import cryptoRandomString from 'crypto-random-string';
import * as fs from 'node:fs/promises';
import { h } from 'koishi';
import { serviceEndpoint } from '../../utility/service-endpoint';
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

  private tokenDataMap = new Map<string, WindbotJoinTokenData>();
  private roomTokenMap = new Map<string, Set<string>>();
  private clientHandler = this.ctx.get(() => ClientHandler);
  private koishiContextService = this.ctx.get(() => KoishiContextService);
  private asRedError(message: string) {
    return h('Chat', { color: 'Red' }, message);
  }

  constructor(private ctx: Context) {}

  async init() {
    if (!this.enabled) {
      return;
    }
    this.registerKoishiCommand();
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

  private registerKoishiCommand() {
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
      const bot = this.selectBot(await this.loadBotList(), botName);
      if (!bot) return this.asRedError('#{windbot_deck_not_found}');
      await this.requestWindbotJoin(room, bot);
    });
  }

  get isEnabled() {
    return this.enabled;
  }

  selectBot(bots: WindbotData[], name?: string) {
    if (name) return bots.find((bot) => bot.name === name || bot.deck === name);
    const visible = bots.filter((bot) => !bot.hidden);
    return visible[Math.floor(Math.random() * visible.length)];
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
    bot: WindbotData,
    options: RequestWindbotJoinOptions = {},
  ) {
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
    retryCount = 0,
  ): Promise<boolean> {
    if (room.finalizing) {
      return false;
    }
    const retryLimit = 10;
    const retry = async () => {
      this.logger.warn(
        { roomToken: token, botName, retryCount },
        'Retrying windbot join by reverse ws',
      );
      return this.requestWindbotJoinByReverseWs(
        room,
        token,
        botName,
        url,
        retryCount + 1,
      );
    };

    try {
      const sock = await this.createReverseWsConnection(url);
      const client = new ReverseWsClient(this.ctx, sock);
      const res = await this.clientHandler
        .handleClient(client)
        .catch((error) => {
          this.logger.warn(
            {
              roomToken: token,
              botName,
              error: (error as Error).toString(),
            },
            'Reverse ws windbot client handler failed',
          );
        });

      if (!res) {
        this.logger.warn(
          { roomToken: token, botName },
          'Reverse ws windbot client failed to establish connection',
        );
        if (retryCount < retryLimit) {
          return retry();
        }
        await room.sendChat('#{add_windbot_failed}', ChatColor.RED);
        return false;
      }

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
      if (retryCount < retryLimit) {
        return retry();
      }
      await room.sendChat('#{add_windbot_failed}', ChatColor.RED);
      return false;
    }
  }

  async loadBotList(): Promise<WindbotData[]> {
    try {
      const data = this.botlistPath
        ? JSON.parse(await fs.readFile(this.botlistPath, 'utf8'))
        : (
            await this.ctx.http.get(
              new URL('bots', serviceEndpoint(this.endpoint, 'http')).href,
              { timeout: 10000 },
            )
          ).data;
      if (!Array.isArray(data?.windbots))
        throw new Error('Invalid WindBot list');
      return data.windbots.filter(
        (bot: WindbotData) =>
          bot && typeof bot.name === 'string' && typeof bot.deck === 'string',
      );
    } catch (error) {
      this.logger.warn({ error: String(error) }, 'Failed to load WindBot list');
      return [];
    }
  }
}
