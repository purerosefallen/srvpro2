import { YGOProCtosChat, NetPlayerType } from 'ygopro-msg-encode';
import { Context } from '../app';
import { Client } from '../client';
import { Room, RoomManager } from '../room';

type ChatgptMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

type ChatCompletionsResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
};

type TiktokenEncoder = {
  encode(text: string): { length: number };
};

declare module '../room' {
  interface Room {
    isRequestingChatgpt?: boolean;
    chatgptConversation?: ChatgptMessage[];
  }
}

export class ChatgptService {
  private logger = this.ctx.createLogger(this.constructor.name);
  private roomManager = this.ctx.get(() => RoomManager);

  private enabled = this.ctx.config.getBoolean('ENABLE_CHATGPT');
  private endpoint = this.ctx.config.getString('CHATGPT_ENDPOINT').trim();
  private token = this.ctx.config.getString('CHATGPT_TOKEN').trim();
  private model = this.ctx.config.getString('CHATGPT_MODEL').trim();
  private systemPrompt = this.ctx.config
    .getString('CHATGPT_SYSTEM_PROMPT')
    .trim();
  private tokenLimit = Math.max(
    0,
    this.ctx.config.getInt('CHATGPT_TOKEN_LIMIT') || 0,
  );
  private extraOptions = this.parseExtraOptions(
    this.ctx.config.getString('CHATGPT_EXTRA_OPTS'),
  );

  private tiktokenUnavailable = false;
  private tiktokenUnavailableLogged = false;
  private tokenizerByModel = new Map<string, TiktokenEncoder>();
  private tiktokenModulePromise?: Promise<any>;
  private middlewareRegistered = false;

  constructor(private ctx: Context) {}

  async init() {
    if (!this.middlewareRegistered) {
      if (this.enabled) {
        this.ctx.middleware(YGOProCtosChat, async (msg, client, next) => {
          const room = this.resolveChatRoom(client);
          if (!room) {
            return next();
          }

          const content = (msg.msg || '').trim();
          if (!this.shouldRespond(client, room, content)) {
            return next();
          }

          if (room.isRequestingChatgpt) {
            return next();
          }

          room.isRequestingChatgpt = true;
          void this.requestChatgptAndReply(room, client, content)
            .catch((error) => {
              this.logger.error(
                {
                  roomName: room.name,
                  clientName: client.name,
                  error: (error as Error).toString(),
                },
                'CHATGPT ERROR',
              );
            })
            .finally(() => {
              room.isRequestingChatgpt = false;
            });

          return next();
        });
      }
      this.middlewareRegistered = true;
    }

    if (
      !this.enabled ||
      this.tiktokenUnavailable ||
      this.tiktokenModulePromise
    ) {
      return;
    }

    const moduleName = 'tiktoken';
    this.tiktokenModulePromise = import(moduleName).catch((e) => {
      this.tiktokenUnavailable = true;
      if (!this.tiktokenUnavailableLogged) {
        this.tiktokenUnavailableLogged = true;
        this.logger.warn(
          { error: (e as Error).toString() },
          'tiktoken is unavailable, using approximate token counting',
        );
      }
      return undefined;
    });
  }

  private resolveChatRoom(client: Client) {
    if (!client.roomName) {
      return undefined;
    }
    const room = this.roomManager.findByName(client.roomName);
    if (!room || room.finalizing) {
      return undefined;
    }
    return room;
  }

  private shouldRespond(client: Client, room: Room, content: string) {
    if (!content || content.startsWith('/')) {
      return false;
    }
    if (!this.enabled || !room.windbot) {
      return false;
    }
    if (client.isInternal) {
      return false;
    }
    if (client.pos >= NetPlayerType.OBSERVER) {
      return false;
    }
    return true;
  }

  private async requestChatgptAndReply(
    room: Room,
    client: Client,
    content: string,
  ) {
    const conversation = room.chatgptConversation || [];
    const requestMessages: ChatgptMessage[] = [
      ...conversation,
      {
        role: 'user',
        content,
      },
    ];

    let trimStartIndex = 0;
    if (this.systemPrompt) {
      requestMessages.unshift({
        role: 'system',
        content: this.renderSystemPrompt(client, room),
      });
      trimStartIndex = 1;
    }

    let shrinkCount = 0;
    while (
      !(await this.isWithinTokenLimit(requestMessages, this.tokenLimit)) &&
      requestMessages.length > 1 + trimStartIndex
    ) {
      requestMessages.splice(trimStartIndex, 2);
      shrinkCount += 2;
    }

    const requestBody: Record<string, unknown> = {
      messages: requestMessages,
      model: this.model,
      ...this.extraOptions,
    };

    this.logger.debug(
      {
        roomName: room.name,
        clientName: client.name,
        body: JSON.stringify(requestBody),
      },
      'CHATGPT REQUEST BODY',
    );

    const response = await this.ctx.http.post<ChatCompletionsResponse>(
      this.makeChatCompletionsUrl(),
      requestBody,
      {
        timeout: 300000,
        headers: {
          Authorization: `Bearer ${this.token}`,
        },
      },
    );

    this.logger.debug(
      {
        roomName: room.name,
        clientName: client.name,
        response: JSON.stringify(response.data),
      },
      'CHATGPT RESPONSE BODY',
    );

    const text = response.data?.choices?.[0]?.message?.content?.trim();
    if (!text) {
      return;
    }

    await this.sendReplyToRoom(room, client, text);

    if (shrinkCount > 0) {
      conversation.splice(0, shrinkCount);
    }
    conversation.push({ role: 'user', content });
    conversation.push({ role: 'assistant', content: text });
    room.chatgptConversation = conversation;
  }

  private makeChatCompletionsUrl() {
    const base = this.endpoint.replace(/\/+$/, '');
    return `${base}/v1/chat/completions`;
  }

  private renderSystemPrompt(client: Client, room: Room) {
    const player = client.name || 'Player';
    const windbot = room.windbot?.name || 'AI';
    const locale = client.getLocale() || 'en-US';
    const language = this.resolveLanguageByLocale(locale);

    return this.systemPrompt
      .replace(/{{\s*player\s*}}/g, player)
      .replace(/{{\s*windbot\s*}}/g, windbot)
      .replace(/{{\s*locale\s*}}/g, locale)
      .replace(/{{\s*language\s*}}/g, language);
  }

  private resolveLanguageByLocale(locale: string) {
    const normalized = locale.toLowerCase();
    if (normalized.startsWith('zh')) return 'Simplified Chinese';
    if (normalized.startsWith('en')) return 'English';
    if (normalized.startsWith('ja')) return 'Japanese';
    if (normalized.startsWith('ko')) return 'Korean';
    if (normalized.startsWith('es')) return 'Spanish';
    if (normalized.startsWith('fr')) return 'French';
    if (normalized.startsWith('de')) return 'German';
    if (normalized.startsWith('ru')) return 'Russian';
    if (normalized.startsWith('pt')) return 'Portuguese';
    if (normalized.startsWith('it')) return 'Italian';
    return locale;
  }

  private async sendReplyToRoom(room: Room, client: Client, text: string) {
    const chatType = this.resolveReplyChatType(room, client);
    for (const line of text.split('\n')) {
      if (!line.length) {
        await room.sendChat(' ', chatType);
        continue;
      }
      for (const chunk of this.chunkLine(line, 100)) {
        await room.sendChat(chunk, chatType);
      }
    }
  }

  private resolveReplyChatType(room: Room, client: Client) {
    const duelPos = room.getIngameDuelPos(client);
    if (duelPos === 0 || duelPos === 1) {
      const opponents = room.getIngameDuelPosPlayers(1 - duelPos);
      const firstOpponent = opponents[0];
      if (firstOpponent) {
        return room.getIngamePos(firstOpponent);
      }
    }
    return room.getIngamePos(client);
  }

  private chunkLine(line: string, size: number) {
    const chars = Array.from(line);
    const chunks: string[] = [];
    for (let i = 0; i < chars.length; i += size) {
      chunks.push(chars.slice(i, i + size).join(''));
    }
    return chunks;
  }

  private parseExtraOptions(raw: string) {
    const source = raw.trim();
    if (!source) {
      return {};
    }
    try {
      const parsed = JSON.parse(source);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {};
      }
      return parsed as Record<string, unknown>;
    } catch (error) {
      this.logger.warn(
        { error: (error as Error).toString() },
        'Invalid CHATGPT_EXTRA_OPTS, fallback to empty object',
      );
      return {};
    }
  }

  private async isWithinTokenLimit(messages: ChatgptMessage[], limit: number) {
    if (!limit) {
      return true;
    }
    const tokenCount = await this.countTokens(messages);
    return tokenCount <= limit;
  }

  private async countTokens(messages: ChatgptMessage[]) {
    const encoder = await this.getTokenizer(this.model);
    if (!encoder) {
      return this.estimateTokens(messages);
    }

    try {
      let tokens = 2;
      for (const message of messages) {
        tokens += 4;
        tokens += encoder.encode(message.role).length;
        tokens += encoder.encode(message.content).length;
      }
      return tokens;
    } catch {
      return this.estimateTokens(messages);
    }
  }

  private estimateTokens(messages: ChatgptMessage[]) {
    let tokens = 2;
    for (const message of messages) {
      tokens += 4;
      tokens += Math.ceil((message.role.length + message.content.length) / 4);
    }
    return tokens;
  }

  private async getTokenizer(model: string) {
    if (this.tiktokenUnavailable) {
      return undefined;
    }

    const cached = this.tokenizerByModel.get(model);
    if (cached) {
      return cached;
    }

    if (!this.tiktokenModulePromise) {
      await this.init();
    }

    try {
      const module = await this.tiktokenModulePromise;
      if (!module) {
        return undefined;
      }
      let encoder: TiktokenEncoder | undefined;
      try {
        encoder = module.encoding_for_model(model);
      } catch {
        encoder = module.get_encoding('cl100k_base');
      }
      if (!encoder) {
        return undefined;
      }
      this.tokenizerByModel.set(model, encoder);
      return encoder;
    } catch(e) {
      this.tiktokenUnavailable = true;
      if (!this.tiktokenUnavailableLogged) {
        this.tiktokenUnavailableLogged = true;
        this.logger.warn(
          { error: (e as Error).toString() },
          'tiktoken is unavailable, using approximate token counting',
        );
      }
      return undefined;
    }
  }
}
