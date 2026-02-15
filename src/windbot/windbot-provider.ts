import cryptoRandomString from 'crypto-random-string';
import * as fs from 'node:fs/promises';
import { ChatColor } from 'ygopro-msg-encode';
import { Context } from '../app';
import { OnRoomFinalize, Room } from '../room';
import type {
  RequestWindbotJoinOptions,
  WindbotData,
  WindbotJoinTokenData,
} from './utility';

declare module '../client' {
  interface Client {
    windbot?: WindbotData;
  }
}

declare module '../room' {
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

  constructor(private ctx: Context) {
    if (!this.enabled) {
      return;
    }
    this.ctx.middleware(OnRoomFinalize, async (event, _client, next) => {
      this.deleteRoomToken(event.room.name);
      return next();
    });
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
    this.logger.debug({ roomName: data?.roomName, token }, 'Consuming windbot join token');
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
    url.searchParams.set('port', this.port);
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
