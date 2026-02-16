import {
  Bot,
  Context as KoishiContext,
  Fragment as KoishiFragment,
  Session as KoishiSession,
  Universal,
  h,
} from 'koishi';
import * as koishiHelpModule from '@koishijs/plugin-help';
import { ChatColor, YGOProCtosChat } from 'ygopro-msg-encode';
import { Context } from '../app';
import { Client } from '../client';
import { ClientKeyProvider } from '../feats';
import { I18nService } from '../client/i18n';
import { Room, RoomManager } from '../room';
type KoishiElement = h;
const koishiHelp =
  (koishiHelpModule as any).default || (koishiHelpModule as any);

type KoishiReferrer = {
  roomName: string;
  userId: string;
};

type ChatToken = {
  text: string;
  color?: number;
};

type ColoredChatMessage = {
  text: string;
  color: number;
};

type CommandContext = {
  room: Room;
  client: Client;
};

type LocalKoishiBotConfig = {
  selfId: string;
};

class LocalKoishiBot extends Bot<KoishiContext, LocalKoishiBotConfig> {
  constructor(
    ctx: KoishiContext,
    config: LocalKoishiBotConfig,
    private onSendMessage: (
      channelId: string,
      content: KoishiFragment,
      session?: KoishiSession,
    ) => Promise<string[]>,
  ) {
    super(ctx, config, 'srvpro2');
    this.selfId = config.selfId;
    this.user.name = 'Server';
    this.user.isBot = true;
    this.status = Universal.Status.ONLINE;
  }

  receive(event: Partial<Universal.Event>, locales?: string[]) {
    const session = this.session(event);
    if (typeof event.message?.content === 'string') {
      session.content = event.message.content;
    }
    if (locales?.length) {
      session.locales = locales;
    }
    this.dispatch(session);
    return session.id;
  }

  async sendMessage(
    channelId: string,
    content: KoishiFragment,
    _referrer?: any,
    options?: Universal.SendOptions,
  ): Promise<string[]> {
    return this.onSendMessage(channelId, content, options?.session as any);
  }
}

export class KoishiContextService {
  private logger = this.ctx.createLogger(this.constructor.name);
  private roomManager = this.ctx.get(() => RoomManager);
  private clientKeyProvider = this.ctx.get(() => ClientKeyProvider);
  private i18nService = this.ctx.get(() => I18nService);
  private attachI18nTasks: Promise<void>[] = [];

  private koishi = new KoishiContext({
    prefix: ['/'],
  });
  private bot = new LocalKoishiBot(
    this.koishi,
    { selfId: 'srvpro2' },
    (channelId, content, session) =>
      this.handleBotSendMessage(channelId, content, session),
  );

  private koishiStarted = false;
  private koishiStartPromise?: Promise<void>;

  constructor(private ctx: Context) {
    this.koishi.plugin(koishiHelp);
    this.registerChatBridge();
  }

  get instance() {
    return this.koishi;
  }

  attachI18n(commandName: string, object: Record<string, any>) {
    const task = this.applyAttachI18n(commandName, object).catch((error) => {
      this.logger.warn(
        {
          commandName,
          error: (error as Error).toString(),
        },
        'Failed attaching koishi i18n for command',
      );
    });
    this.attachI18nTasks.push(task);
    return this;
  }

  async init() {
    if (this.attachI18nTasks.length) {
      await Promise.all(this.attachI18nTasks);
      this.attachI18nTasks = [];
    }
    if (this.koishiStarted) {
      return;
    }
    if (!this.koishiStartPromise) {
      this.koishiStartPromise = this.koishi
        .start()
        .then(() => {
          this.koishiStarted = true;
          this.logger.info('Koishi context started');
        })
        .catch((error) => {
          this.logger.warn(
            { error: (error as Error).toString() },
            'Failed to start koishi context',
          );
        });
    }
    await this.koishiStartPromise;
  }

  private registerChatBridge() {
    this.ctx.middleware(
      YGOProCtosChat,
      async (msg, client, next) => {
        const text = (msg.msg || '').trim();
        if (!text.startsWith('/')) {
          return next();
        }
        await this.dispatchCommandToKoishi(client, text);
        return;
      },
      true,
    );
  }

  private async applyAttachI18n(
    commandName: string,
    object: Record<string, any>,
  ) {
    const locales = Array.from(this.i18nService.locales);
    for (const locale of locales) {
      const commandData = await this.translateAttachObject(locale, object);
      this.koishi.i18n.define(locale, {
        commands: {
          [commandName]: commandData,
        },
      });
    }
  }

  private async translateAttachObject(
    locale: string,
    value: any,
  ): Promise<any> {
    if (typeof value === 'string') {
      const wrapped =
        value.startsWith('#{') && value.endsWith('}') ? value : `#{${value}}`;
      return this.i18nService.translate(locale, wrapped);
    }
    if (Array.isArray(value)) {
      return Promise.all(
        value.map((item) => this.translateAttachObject(locale, item)),
      );
    }
    if (value && typeof value === 'object') {
      const entries = await Promise.all(
        Object.entries(value).map(async ([key, entryValue]) => [
          key,
          await this.translateAttachObject(locale, entryValue),
        ]),
      );
      return Object.fromEntries(entries);
    }
    return value;
  }

  private async dispatchCommandToKoishi(client: Client, content: string) {
    const roomName = client.roomName;
    if (!roomName) {
      return;
    }

    const room = this.roomManager.findByName(roomName);
    if (!room || room.finalizing) {
      return;
    }

    await this.init();

    const userId = this.getUserId(room.name, client);
    this.bot.receive(
      {
        type: 'message',
        timestamp: Date.now(),
        channel: {
          id: room.name,
          type: Universal.Channel.Type.TEXT,
          name: room.name,
        },
        guild: {
          id: room.name,
          name: room.name,
        },
        user: {
          id: userId,
          name: client.name || userId,
        },
        message: {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          content,
        },
        referrer: {
          roomName: room.name,
          userId,
        } as KoishiReferrer,
      },
      [client.getLocale()],
    );
  }

  resolveCommandContext(session: KoishiSession): CommandContext | undefined {
    const roomName = session.channelId;
    if (!roomName) {
      return undefined;
    }
    const room = this.roomManager.findByName(roomName);
    if (!room || room.finalizing) {
      return undefined;
    }

    const userId = session.userId;
    if (!userId) {
      return undefined;
    }

    const client = this.findClientByUserId(room, userId);
    if (!client) {
      return undefined;
    }

    return { room, client };
  }

  private findClientByUserId(room: Room, userId: string): Client | undefined {
    const prefix = `${room.name}:`;
    if (!userId.startsWith(prefix)) {
      return undefined;
    }
    const expectedClientKey = userId.slice(prefix.length);
    return room.allPlayers.find(
      (player) => this.getClientKey(player) === expectedClientKey,
    );
  }

  private getClientKey(client: Client) {
    const key = this.clientKeyProvider.getClientKey(client);
    return key || `${client.ip}:${client.name}`;
  }

  private getUserId(roomName: string, client: Client) {
    return `${roomName}:${this.getClientKey(client)}`;
  }

  private async handleBotSendMessage(
    channelId: string,
    content: KoishiFragment,
    session?: KoishiSession,
  ): Promise<string[]> {
    const room = this.roomManager.findByName(channelId);
    if (!room || room.finalizing) {
      return [];
    }

    const targets = this.resolveSendTargets(room, session);
    if (!targets.length) {
      return [];
    }

    const messages = this.resolveColoredMessages(h.normalize(content));
    if (!messages.length) {
      return [];
    }

    const messageIds: string[] = [];
    for (let i = 0; i < messages.length; i += 1) {
      const message = messages[i];
      await Promise.all(
        targets.map((target) => target.sendChat(message.text, message.color)),
      );
      messageIds.push(
        `${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}`,
      );
    }
    return messageIds;
  }

  private resolveSendTargets(room: Room, session?: KoishiSession) {
    const referrer = session?.event?.referrer as KoishiReferrer | undefined;
    if (!referrer?.userId) {
      return room.allPlayers;
    }
    const target = this.findClientByUserId(room, referrer.userId);
    return target ? [target] : [];
  }

  private resolveColoredMessages(
    elements: KoishiElement[],
  ): ColoredChatMessage[] {
    const tokens = this.collectTextTokens(elements);
    if (!tokens.length) {
      return [];
    }

    const cleanedTokens = tokens.filter((token) => token.text.length > 0);
    if (!cleanedTokens.length) {
      return [];
    }

    const firstColoredIndex = cleanedTokens.findIndex(
      (token) => typeof token.color === 'number',
    );
    if (firstColoredIndex === -1) {
      return [
        {
          text: cleanedTokens.map((token) => token.text).join(''),
          color: ChatColor.BABYBLUE,
        },
      ];
    }

    let currentColor = cleanedTokens[firstColoredIndex].color as number;
    let currentText = cleanedTokens
      .slice(0, firstColoredIndex + 1)
      .map((token) => token.text)
      .join('');
    const result: ColoredChatMessage[] = [];

    for (let i = firstColoredIndex + 1; i < cleanedTokens.length; i += 1) {
      const token = cleanedTokens[i];
      if (typeof token.color === 'number' && token.color !== currentColor) {
        if (currentText) {
          result.push({
            text: currentText,
            color: currentColor,
          });
        }
        currentColor = token.color;
        currentText = token.text;
      } else {
        currentText += token.text;
      }
    }

    if (currentText) {
      result.push({
        text: currentText,
        color: currentColor,
      });
    }

    if (!result.length) {
      return [];
    }

    return result;
  }

  private collectTextTokens(
    elements: KoishiElement[],
    inheritedColor?: number,
  ): ChatToken[] {
    const tokens: ChatToken[] = [];
    for (const element of elements) {
      if (!element) {
        continue;
      }

      const color = this.resolveElementColor(element) ?? inheritedColor;

      if (element.type === 'text') {
        const content = element.attrs?.content;
        if (typeof content === 'string' && content.length > 0) {
          tokens.push({
            text: content,
            color,
          });
        }
      } else if (element.type === 'br') {
        tokens.push({
          text: '\n',
          color,
        });
      }

      if (element.children?.length) {
        tokens.push(
          ...this.collectTextTokens(element.children as KoishiElement[], color),
        );
      }
    }
    return tokens;
  }

  private resolveElementColor(element: KoishiElement): number | undefined {
    const isChatElement =
      typeof element.type === 'string' && element.type.toLowerCase() === 'chat';
    const rawColor = isChatElement
      ? element.attrs?.color
      : element.attrs?.chatColor;
    if (rawColor == null) {
      return undefined;
    }
    if (typeof rawColor === 'number') {
      return this.normalizeChatColor(rawColor);
    }
    if (typeof rawColor !== 'string') {
      return undefined;
    }
    const normalized = rawColor.replace(/[^a-z0-9]/gi, '').toUpperCase();
    if (!normalized) {
      return undefined;
    }
    const enumValue = (ChatColor as any)[normalized];
    if (typeof enumValue === 'number') {
      return enumValue;
    }
    const parsed = Number(rawColor);
    if (Number.isFinite(parsed)) {
      return this.normalizeChatColor(parsed);
    }
    return undefined;
  }

  private normalizeChatColor(value: number): number {
    if (typeof (ChatColor as any)[value] === 'string') {
      return value;
    }
    return ChatColor.BABYBLUE;
  }
}
