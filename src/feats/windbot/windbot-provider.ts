import cryptoRandomString from 'crypto-random-string';
import * as fs from 'node:fs/promises';
import { h } from 'koishi';
import { ChatColor } from 'ygopro-msg-encode';
import WebSocket from 'ws';
import { Context } from '../../app';
import { ClientHandler } from '../../client';
import { KoishiContextService } from '../../koishi';
import { OnRoomFinalize, Room } from '../../room';
import type {
  RequestWindbotJoinOptions,
  WindbotData,
  WindbotJoinTokenData,
} from './utility';
import { ReverseWsClient } from './reverse-ws-client';
import { RoomCheckDeck } from '../../room/room-event/room-check-deck';

declare module '../../client' {
  interface Client {
    windbot?: WindbotData;
  }
}

declare module '../../room' {
  interface Room {
    windbot?: WindbotData;
  }
}

export class WindBotProvider {
  private logger = this.ctx.createLogger(this.constructor.name);

  public enabled = this.ctx.config.getBoolean('ENABLE_WINDBOT');
  public spawnEnabled = this.ctx.config.getBoolean('WINDBOT_SPAWN');
  public endpoint = this.ctx.config.getString('WINDBOT_ENDPOINT');
  public myIp = this.ctx.config.getString('WINDBOT_MY_IP');
  public port = this.ctx.config.getString('PORT');
  public version = this.ctx.config.getInt('YGOPRO_VERSION');
  public botlistPath = this.ctx.config.getString('WINDBOT_BOTLIST');

  private bots: WindbotData[] = [];
  private tokenDataMap = new Map<string, WindbotJoinTokenData>();
  private roomTokenMap = new Map<string, Set<string>>();
  private clientHandler = this.ctx.get(() => ClientHandler);
  private koishiContextService = this.ctx.get(() => KoishiContextService);
  private asRedError(message: string) {
    return h('Chat', { color: 'Red' }, message);
  }

  constructor(private ctx: Context) {
    if (!this.enabled) {
      return;
    }

    const koishi = this.koishiContextService.instance;
    this.koishiContextService.attachI18n('ai', {
      description: 'koishi_cmd_ai_desc',
    });

    koishi.command('ai [name:text]', '').action(async ({ session }, name) => {
      const commandContext =
        this.koishiContextService.resolveCommandContext(session);
      if (!commandContext) {
        return;
      }

      const { room, client } = commandContext;
      if (!client.isHost) {
        return this.asRedError('#{koishi_ai_only_host}');
      }
      if (!this.enabled) {
        return this.asRedError('#{koishi_ai_disabled}');
      }
      if (room.randomType) {
        return this.asRedError('#{koishi_ai_disabled_random_room}');
      }
      let hasFreeSeat = false;
      for (let i = 0; i < room.players.length; i += 1) {
        if (!room.players[i]) {
          hasFreeSeat = true;
          break;
        }
      }
      if (!hasFreeSeat) {
        return this.asRedError('#{koishi_ai_room_full}');
      }

      const botName = (name || '').trim() || undefined;
      if (botName && !this.getBotByNameOrDeck(botName)) {
        return this.asRedError('#{windbot_deck_not_found}');
      }
      if (!botName && !this.getRandomBot()) {
        return this.asRedError('#{windbot_deck_not_found}');
      }
      await this.requestWindbotJoin(room, botName);
    });

    this.ctx
      .middleware(OnRoomFinalize, async (event, _client, next) => {
        this.deleteRoomToken(event.room.name);
        return next();
      })
      .middleware(
        RoomCheckDeck,
        async (evt, client, next) => {
          if (client.windbot) {
            return undefined; // entirely skip check deck for windbot client
          }
          return next();
        },
        true,
      );
  }

  async init() {
    if (!this.enabled) {
      return;
    }
    await this.loadBotList();
  }

  get isEnabled() {
    return this.enabled;
  }

  getRandomBot() {
    const visibleBots = this.bots.filter((bot) => !bot.hidden);
    if (!visibleBots.length) {
      return undefined;
    }
    const index = Math.floor(Math.random() * visibleBots.length);
    return visibleBots[index];
  }

  getBotByNameOrDeck(name: string) {
    return this.bots.find((bot) => bot.name === name || bot.deck === name);
  }

  getBots() {
    return this.bots.filter((bot) => !bot.hidden);
  }

  issueJoinToken(roomName: string, windbot: WindbotData) {
    let token = '';
    do {
      token = cryptoRandomString({
        length: 12,
        type: 'alphanumeric',
      });
    } while (this.tokenDataMap.has(token));

    this.logger.debug(
      { roomName, token },
      'Issuing windbot join token for room',
    );
    this.tokenDataMap.set(token, {
      roomName,
      windbot: { ...windbot },
    });
    let roomTokens = this.roomTokenMap.get(roomName);
    if (!roomTokens) {
      roomTokens = new Set<string>();
      this.roomTokenMap.set(roomName, roomTokens);
    }
    roomTokens.add(token);
    return token;
  }

  consumeJoinToken(token: string) {
    const data = this.tokenDataMap.get(token);
    this.logger.debug(
      { roomName: data?.roomName, token },
      'Consuming windbot join token',
    );
    if (!data) {
      return undefined;
    }
    this.tokenDataMap.delete(token);
    const roomTokens = this.roomTokenMap.get(data.roomName);
    if (roomTokens) {
      roomTokens.delete(token);
      if (roomTokens.size === 0) {
        this.roomTokenMap.delete(data.roomName);
      }
    }
    return data;
  }

  deleteRoomToken(roomName: string) {
    const roomTokens = this.roomTokenMap.get(roomName);
    if (!roomTokens) {
      return;
    }
    this.roomTokenMap.delete(roomName);
    for (const token of roomTokens) {
      const mappedData = this.tokenDataMap.get(token);
      if (mappedData?.roomName === roomName) {
        this.tokenDataMap.delete(token);
      }
    }
  }

  async requestWindbotJoin(
    room: Room,
    botname?: string,
    options: RequestWindbotJoinOptions = {},
  ) {
    const bot =
      (botname && this.getBotByNameOrDeck(botname)) || this.getRandomBot();
    if (!bot) {
      await room.sendChat('#{windbot_deck_not_found}', ChatColor.RED);
      return false;
    }
    if (!room.windbot) {
      room.windbot = {
        name: '',
        deck: '',
      };
    }
    Object.assign(room.windbot, bot);
    const token = this.issueJoinToken(room.name, bot);

    let url: URL;
    try {
      url = new URL(this.endpoint);
    } catch (error) {
      this.logger.warn(
        { endpoint: this.endpoint, error: (error as Error).toString() },
        'Invalid WINDBOT_ENDPOINT',
      );
      await room.sendChat('#{add_windbot_failed}', ChatColor.RED);
      return false;
    }

    url.searchParams.set('name', bot.name);
    url.searchParams.set('deck', bot.deck);
    url.searchParams.set('host', this.myIp);
    if (!this.hasHostScheme(this.myIp)) {
      url.searchParams.set('port', this.port);
    }
    if (bot.dialog) {
      url.searchParams.set('dialog', bot.dialog);
    }
    url.searchParams.set('version', this.version.toString());
    url.searchParams.set('password', `AIJOIN#${token}`);
    if (bot.deckcode) {
      url.searchParams.set('deckcode', bot.deckcode);
    }
    if (options.hand) {
      url.searchParams.set('hand', options.hand.toString());
    }

    this.logger.debug(
      { url: url.toString(), roomName: room.name },
      'Requesting windbot join',
    );

    if (this.isWebSocketEndpoint(url)) {
      return this.requestWindbotJoinByReverseWs(room, token, bot.name, url);
    }

    try {
      await this.ctx.http.get(url.toString());
      return true;
    } catch (error) {
      this.logger.warn(
        {
          roomToken: token,
          botName: bot.name,
          error: (error as Error).toString(),
        },
        'Windbot add request failed',
      );
      await room.sendChat('#{add_windbot_failed}', ChatColor.RED);
      return false;
    }
  }

  private hasHostScheme(host: string) {
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(host);
  }

  private isWebSocketEndpoint(url: URL) {
    return url.protocol === 'ws:' || url.protocol === 'wss:';
  }

  private async createReverseWsConnection(url: URL) {
    return new Promise<WebSocket>((resolve, reject) => {
      const sock = new WebSocket(url.toString());
      const cleanup = () => {
        sock.off('open', onOpen);
        sock.off('error', onError);
      };
      const onOpen = () => {
        cleanup();
        resolve(sock);
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      sock.once('open', onOpen);
      sock.once('error', onError);
    });
  }

  private async requestWindbotJoinByReverseWs(
    room: Room,
    token: string,
    botName: string,
    url: URL,
  ) {
    try {
      const sock = await this.createReverseWsConnection(url);
      const client = new ReverseWsClient(this.ctx, sock);
      this.clientHandler.handleClient(client).catch((error) => {
        this.logger.warn(
          {
            roomToken: token,
            botName,
            error: (error as Error).toString(),
          },
          'Reverse ws windbot client handler failed',
        );
      });

      return true;
    } catch (error) {
      this.logger.warn(
        {
          roomToken: token,
          botName,
          error: (error as Error).toString(),
        },
        'Windbot reverse ws request failed',
      );
      await room.sendChat('#{add_windbot_failed}', ChatColor.RED);
      return false;
    }
  }

  private async loadBotList() {
    try {
      const text = await fs.readFile(this.botlistPath, 'utf-8');
      const parsed = JSON.parse(text) as {
        windbots?: WindbotData[];
      };
      const loadedBots = parsed?.windbots;
      if (!Array.isArray(loadedBots)) {
        this.logger.warn(
          { botlistPath: this.botlistPath },
          'Windbot botlist format invalid',
        );
        return;
      }
      this.bots = loadedBots.filter(
        (bot) =>
          bot && typeof bot.name === 'string' && typeof bot.deck === 'string',
      );
      this.logger.info(
        { count: this.bots.length, botlistPath: this.botlistPath },
        'Loaded windbot botlist',
      );
    } catch (error) {
      this.logger.warn(
        { botlistPath: this.botlistPath, error: (error as Error).toString() },
        'Failed to load windbot botlist',
      );
    }
  }
}
