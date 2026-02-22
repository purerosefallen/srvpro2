import { HostInfo } from 'ygopro-msg-encode';
import { MayBeArray } from 'nfkit';
import { Context } from '../app';
import { DefaultHostinfo } from './default-hostinfo';

const TAG_MODE_BIT = 0x2;
const MATCH_WINS_BITS_MASK = 0xfd;

const encodeWinMatchCountBits = (winMatchCount: number): number => {
  // room.ts decode: ((mode & 0x1) | ((mode & 0xfc) >>> 1)) + 1
  const value = Math.max(1, winMatchCount) - 1;
  return (value & 0x1) | ((value & 0x7e) << 1);
};

const setTagBit = (mode: number, isTag: boolean): number =>
  isTag ? mode | TAG_MODE_BIT : mode & ~TAG_MODE_BIT;

const setWinMatchCountBits = (mode: number, winMatchCount: number): number => {
  const nonTagBits =
    encodeWinMatchCountBits(winMatchCount) & MATCH_WINS_BITS_MASK;
  return (mode & TAG_MODE_BIT) | nonTagBits;
};

type RoomModeContext = {
  hostinfo: HostInfo;
  defaultHostinfo: HostInfo;
  roomName: string;
  roomPrefix: string;
  regexResult: RegExpMatchArray;
};
type RoomModeBaseContext = Omit<RoomModeContext, 'regexResult'>;

type RoomModeRegistration = {
  patterns: string[];
  handler: RoomModeHandler;
};
type RoomModeHandler = (context: RoomModeContext) => Partial<HostInfo>;
type RoomModeHandlerLike = RoomModeHandler | Partial<HostInfo>;

export class DefaultHostInfoProvider {
  private roomModeRegistrations: RoomModeRegistration[] = [];

  constructor(private ctx: Context) {
    this.registerBuiltInRoomModes();
  }

  registerRoomMode(
    pattern: MayBeArray<string>,
    handler: RoomModeHandlerLike,
  ): this {
    const normalizedHandler: RoomModeHandler =
      typeof handler === 'function' ? handler : () => handler;
    const patterns = (Array.isArray(pattern) ? pattern : [pattern]).map(
      (item) => this.normalizeRoomModePattern(item),
    );
    this.roomModeRegistrations.push({
      patterns,
      handler: normalizedHandler,
    });
    return this;
  }

  getHostinfo(): HostInfo {
    const hostinfo = { ...DefaultHostinfo };
    for (const key of Object.keys(hostinfo)) {
      const configKey = `HOSTINFO_${key.toUpperCase()}`;
      const value = this.ctx.config.getString(configKey as any);
      if (value) {
        const num = Number(value);
        if (!isNaN(num)) {
          (hostinfo as any)[key] = num;
        }
      }
    }
    return hostinfo;
  }

  parseHostinfo(name: string, partial: Partial<HostInfo> = {}): HostInfo {
    const defaultHostinfo = this.getHostinfo();
    const hostinfo: HostInfo = {
      ...defaultHostinfo,
      ...partial,
    };

    const namePrefixMatch = name.match(/(.+)#/);
    const namePrefixRaw = namePrefixMatch ? namePrefixMatch[1] : '';
    const namePrefix = namePrefixRaw.toUpperCase();

    if (namePrefix === 'M') {
      hostinfo.mode = 1;
      return hostinfo;
    }
    if (namePrefix === 'T') {
      hostinfo.mode = 2;
      hostinfo.start_lp = defaultHostinfo.start_lp * 2;
      return hostinfo;
    }
    const compactParam = namePrefix.match(
      /^([0-5])([0-9])([12345TF])(T|F)(T|F)(\d+),(\d+),(\d+)$/i,
    );
    if (compactParam) {
      const duelRuleNumber = Number.parseInt(compactParam[3], 10);
      hostinfo.rule = Number.parseInt(compactParam[1], 10);
      hostinfo.mode = Number.parseInt(compactParam[2], 10);
      hostinfo.duel_rule = Number.isNaN(duelRuleNumber)
        ? compactParam[3].toUpperCase() === 'T'
          ? 3
          : 5
        : duelRuleNumber;
      hostinfo.no_check_deck = compactParam[4].toUpperCase() === 'T' ? 1 : 0;
      hostinfo.no_shuffle_deck = compactParam[5].toUpperCase() === 'T' ? 1 : 0;
      hostinfo.start_lp = Number.parseInt(compactParam[6], 10);
      hostinfo.start_hand = Number.parseInt(compactParam[7], 10);
      hostinfo.draw_count = Number.parseInt(compactParam[8], 10);
      return hostinfo;
    }

    const rule = namePrefix;
    if (!rule) {
      return hostinfo;
    }

    this.applyRoomModes(rule, false, {
      hostinfo,
      defaultHostinfo,
      roomName: name,
      roomPrefix: namePrefixRaw,
    });
    return hostinfo;
  }

  private applyRoomModes(
    source: string,
    stopOnMatch: boolean,
    baseContext: RoomModeBaseContext,
  ): boolean {
    let matched = false;

    for (const registration of this.roomModeRegistrations) {
      for (const pattern of registration.patterns) {
        const regexResult = source.match(new RegExp(pattern, 'i'));
        if (!regexResult) {
          continue;
        }

        const context: RoomModeContext = {
          ...baseContext,
          regexResult: this.trimRegexResult(regexResult),
        };
        Object.assign(baseContext.hostinfo, registration.handler(context));
        matched = true;
        break;
      }

      if (stopOnMatch && matched) {
        return true;
      }
    }

    return matched;
  }

  private normalizeRoomModePattern(pattern: string): string {
    if (
      pattern.startsWith('^') ||
      pattern.endsWith('$') ||
      pattern.includes('(^|，|,') ||
      pattern.includes('(，|,|$)')
    ) {
      return pattern;
    }
    return `(?:^|，|,)${pattern}(?:，|,|$)`;
  }

  private trimRegexResult(regexResult: RegExpMatchArray): RegExpMatchArray {
    const trimmed = regexResult.slice(1) as RegExpMatchArray;
    trimmed.index = regexResult.index;
    trimmed.input = regexResult.input;
    trimmed.groups = regexResult.groups;
    return trimmed;
  }

  private registerBuiltInRoomModes(): void {
    this.registerRoomMode('(M|MATCH)', ({ hostinfo }) => ({
      mode: setWinMatchCountBits(hostinfo.mode, 2),
    }))
      .registerRoomMode('(T|TAG)', ({ hostinfo, defaultHostinfo }) => ({
        mode: setTagBit(hostinfo.mode, true),
        start_lp: defaultHostinfo.start_lp * 2,
      }))
      .registerRoomMode('BO(\\d+)', ({ regexResult, hostinfo }) => {
        const bo = Number.parseInt(regexResult[0], 10);
        if (Number.isNaN(bo) || bo <= 0 || bo % 2 !== 1) {
          return {};
        }
        return {
          mode: setWinMatchCountBits(hostinfo.mode, (bo + 1) / 2),
        };
      })
      .registerRoomMode('(TCGONLY|TO)', { rule: 1 })
      .registerRoomMode('(OCGONLY|OO)', {
        rule: 0,
        lflist: 0,
      })
      .registerRoomMode('(OT|TCG)', { rule: 5 })
      .registerRoomMode('(SC|CN|CCG|CHINESE)', {
        rule: 2,
        lflist: -1,
      })
      .registerRoomMode('LP(\\d+)', ({ regexResult }) => {
        let startLp = Number.parseInt(regexResult[0], 10);
        if (startLp <= 0) startLp = 1;
        if (startLp >= 99999) startLp = 99999;
        return { start_lp: startLp };
      })
      .registerRoomMode('(TIME|TM|TI)(\\d+)', ({ regexResult }) => {
        let timeLimit = Number.parseInt(regexResult[1], 10);
        if (timeLimit < 0) timeLimit = 180;
        if (timeLimit >= 1 && timeLimit <= 60) timeLimit *= 60;
        if (timeLimit >= 999) timeLimit = 999;
        return { time_limit: timeLimit };
      })
      .registerRoomMode('(START|ST)(\\d+)', ({ regexResult }) => {
        let startHand = Number.parseInt(regexResult[1], 10);
        if (startHand <= 0) startHand = 1;
        if (startHand >= 40) startHand = 40;
        return { start_hand: startHand };
      })
      .registerRoomMode('(DRAW|DR)(\\d+)', ({ regexResult }) => {
        let drawCount = Number.parseInt(regexResult[1], 10);
        if (drawCount >= 35) drawCount = 35;
        return { draw_count: drawCount };
      })
      .registerRoomMode('(LFLIST|LF)(\\d+)', ({ regexResult }) => ({
        lflist: Number.parseInt(regexResult[1], 10) - 1,
      }))
      .registerRoomMode('(NOLFLIST|NF)', {
        lflist: -1,
      })
      .registerRoomMode('(NOUNIQUE|NU)', {
        rule: 4,
      })
      .registerRoomMode('(CUSTOM|DIY)', {
        rule: 3,
      })
      .registerRoomMode('(NOCHECK|NC)', {
        no_check_deck: 1,
      })
      .registerRoomMode('(NOSHUFFLE|NS)', {
        no_shuffle_deck: 1,
      })
      .registerRoomMode('(IGPRIORITY|PR)', {
        duel_rule: 4,
      })
      .registerRoomMode('(DUELRULE|MR)(\\d+)', ({ regexResult }) => {
        const duelRule = Number.parseInt(regexResult[1], 10);
        if (duelRule <= 0 || duelRule > 5) {
          return {};
        }
        return { duel_rule: duelRule };
      })
      .registerRoomMode('(NOWATCH|NW)', {
        no_watch: 1,
      });
  }
}
