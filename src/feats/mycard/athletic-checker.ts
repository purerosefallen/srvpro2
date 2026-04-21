import YGOProDeck from 'ygopro-deck-encode';
import { ChatColor } from 'ygopro-msg-encode';
import {
  YGOProLFListError,
  YGOProLFListErrorReason,
} from 'ygopro-lflist-encode';
import { Context } from '../../app';
import { OnRoomGameStart, Room, RoomCheckDeck } from '../../room';
import { PlayerName } from '../../utility';

type AthleticDecksReturnData = {
  name: string;
};

export type AthleticCheckResult = {
  success: boolean;
  athletic?: number;
  message: string | null;
};

class AthleticDeckBadError extends YGOProLFListError {
  constructor() {
    super(YGOProLFListErrorReason.LFLIST, 0);
  }

  toPayload() {
    return 0;
  }
}

export class AthleticChecker {
  private logger = this.ctx.createLogger(this.constructor.name);
  private athleticDeckCache?: string[];
  private lastAthleticDeckFetchTime = 0;

  constructor(private ctx: Context) {}

  get enabled() {
    return this.ctx.config.getBoolean('ATHLETIC_CHECK_ENABLED');
  }

  async init() {
    if (!this.enabled) {
      return;
    }

    this.ctx.middleware(RoomCheckDeck, async (msg, client, next) => {
      if (msg.value || !msg.room.mycardArena || this.banCount <= 0) {
        return next();
      }

      const result = await this.checkAthletic(msg.deck);
      if (!result.success) {
        this.logger.warn(
          { player: client.name, message: result.message },
          'GET ATHLETIC FAIL',
        );
        return next();
      }
      if (result.athletic && result.athletic <= this.banCount) {
        await client.sendChat(
          `#{banned_athletic_deck_part1}${this.banCount}#{banned_athletic_deck_part2}`,
          ChatColor.RED,
        );
        return msg.use(new AthleticDeckBadError());
      }
      return next();
    });

    this.ctx.middleware(OnRoomGameStart, async (event, _client, next) => {
      await this.notifyAthleticDecks(event.room);
      return next();
    });
  }

  async checkAthletic(deck: Pick<YGOProDeck, 'toYdkString'>) {
    try {
      const deckType = await this.getDeckType(deck);
      if (deckType === '迷之卡组') {
        return { success: true, athletic: 0, message: null };
      }
      const athleticDecks = await this.getAthleticDecks();
      const athletic = athleticDecks.findIndex((d) => d === deckType) + 1;
      return { success: true, athletic, message: null };
    } catch (e) {
      return {
        success: false,
        message: e instanceof Error ? e.message : String(e),
      };
    }
  }

  private get rankUrl() {
    return this.ctx.config.getString('ATHLETIC_CHECK_RANK_URL');
  }

  private get identifierUrl() {
    return this.ctx.config.getString('ATHLETIC_CHECK_IDENTIFIER_URL');
  }

  private get rankCount() {
    return Math.max(0, this.ctx.config.getInt('ATHLETIC_CHECK_RANK_COUNT'));
  }

  private get banCount() {
    return Math.max(0, this.ctx.config.getInt('ATHLETIC_CHECK_BAN_COUNT'));
  }

  private get ttlMs() {
    return Math.max(0, this.ctx.config.getInt('ATHLETIC_CHECK_TTL')) * 1000;
  }

  private getFetchParams() {
    const raw = this.ctx.config.getString('ATHLETIC_CHECK_FETCH_PARAMS').trim();
    if (!raw) {
      return {};
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch (error) {
      this.logger.warn(
        { error: (error as Error).message },
        'Failed to parse ATHLETIC_CHECK_FETCH_PARAMS',
      );
    }
    return {};
  }

  private async getAthleticDecks() {
    const now = Date.now();
    if (
      this.athleticDeckCache &&
      now - this.lastAthleticDeckFetchTime < this.ttlMs
    ) {
      return this.athleticDeckCache;
    }
    const { data } = await this.ctx.http.get<AthleticDecksReturnData[]>(
      this.rankUrl,
      {
        timeout: 10000,
        responseType: 'json',
        params: this.getFetchParams(),
      },
    );
    const athleticDecks = (Array.isArray(data) ? data : [])
      .slice(0, this.rankCount)
      .map((item) => item.name);
    this.athleticDeckCache = athleticDecks;
    this.lastAthleticDeckFetchTime = now;
    return athleticDecks;
  }

  private async getDeckType(deck: Pick<YGOProDeck, 'toYdkString'>) {
    const form = new URLSearchParams();
    form.append('deck', deck.toYdkString());
    const { data } = await this.ctx.http.post(this.identifierUrl, form, {
      timeout: 10000,
      responseType: 'json',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });
    return data?.deck || '';
  }

  private async notifyAthleticDecks(room: Room) {
    if (!this.enabled || room.finalizing) {
      return;
    }
    await Promise.all(
      room.playingPlayers.map(async (player) => {
        const deck = player.deck || player.startDeck;
        if (!deck) {
          return;
        }
        const result = await this.checkAthletic(deck);
        if (!result.success) {
          this.logger.warn(
            { player: player.name, message: result.message },
            'GET ATHLETIC FAIL',
          );
          return;
        }
        if (result.athletic) {
          await room.sendChat(
            [PlayerName(player), '#{using_athletic_deck}'],
            ChatColor.BABYBLUE,
          );
        }
      }),
    );
  }
}
