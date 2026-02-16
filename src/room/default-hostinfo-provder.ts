import { HostInfo } from 'ygopro-msg-encode';
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

export class DefaultHostInfoProvider {
  constructor(private ctx: Context) {}

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

    if (name.startsWith('M#')) {
      hostinfo.mode = 1;
      return hostinfo;
    }
    if (name.startsWith('T#')) {
      hostinfo.mode = 2;
      hostinfo.start_lp = defaultHostinfo.start_lp * 2;
      return hostinfo;
    }
    const compactParam = name.match(
      /^(\d)(\d)([12345TF])(T|F)(T|F)(\d+),(\d+),(\d+)/i,
    );
    if (compactParam) {
      hostinfo.rule = Number.parseInt(compactParam[1], 10);
      hostinfo.mode = Number.parseInt(compactParam[2], 10);
      const duelRuleNumber = Number.parseInt(compactParam[3], 10);
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

    const rulePrefix = name.match(/(.+)#/);
    const rule = rulePrefix ? rulePrefix[1].toUpperCase() : '';
    if (!rule) {
      return hostinfo;
    }
    if (/(^|，|,)(M|MATCH)(，|,|$)/.test(rule)) {
      hostinfo.mode = setWinMatchCountBits(hostinfo.mode, 2);
    }
    if (/(^|，|,)(T|TAG)(，|,|$)/.test(rule)) {
      hostinfo.mode = setTagBit(hostinfo.mode, true);
      hostinfo.start_lp = defaultHostinfo.start_lp * 2;
    }
    const boParam = rule.match(/(^|，|,)BO(\d+)(，|,|$)/);
    if (boParam) {
      const bo = Number.parseInt(boParam[2], 10);
      // only odd BOx is valid (e.g. BO1/3/5...)
      if (!Number.isNaN(bo) && bo > 0 && bo % 2 === 1) {
        hostinfo.mode = setWinMatchCountBits(hostinfo.mode, (bo + 1) / 2);
      }
    }
    if (/(^|，|,)(OOR|OCGONLYRANDOM)(，|,|$)/.test(rule)) {
      hostinfo.rule = 0;
      hostinfo.lflist = 0;
    }
    if (/(^|，|,)(OR|OCGRANDOM)(，|,|$)/.test(rule)) {
      hostinfo.rule = 5;
      hostinfo.lflist = 0;
    }
    if (/(^|，|,)(CR|CCGRANDOM)(，|,|$)/.test(rule)) {
      hostinfo.rule = 2;
      hostinfo.lflist = -1;
    }
    if (/(^|，|,)(TOR|TCGONLYRANDOM)(，|,|$)/.test(rule)) {
      hostinfo.rule = 1;
    }
    if (/(^|，|,)(TR|TCGRANDOM)(，|,|$)/.test(rule)) {
      hostinfo.rule = 5;
    }
    if (/(^|，|,)(OOMR|OCGONLYMATCHRANDOM)(，|,|$)/.test(rule)) {
      hostinfo.rule = 0;
      hostinfo.lflist = 0;
      hostinfo.mode = 1;
    }
    if (/(^|，|,)(OMR|OCGMATCHRANDOM)(，|,|$)/.test(rule)) {
      hostinfo.rule = 5;
      hostinfo.lflist = 0;
      hostinfo.mode = 1;
    }
    if (/(^|，|,)(CMR|CCGMATCHRANDOM)(，|,|$)/.test(rule)) {
      hostinfo.rule = 2;
      hostinfo.lflist = -1;
      hostinfo.mode = 1;
    }
    if (/(^|，|,)(TOMR|TCGONLYMATCHRANDOM)(，|,|$)/.test(rule)) {
      hostinfo.rule = 1;
      hostinfo.mode = 1;
    }
    if (/(^|，|,)(TMR|TCGMATCHRANDOM)(，|,|$)/.test(rule)) {
      hostinfo.rule = 5;
      hostinfo.mode = 1;
    }
    if (/(^|，|,)(TCGONLY|TO)(，|,|$)/.test(rule)) {
      hostinfo.rule = 1;
    }
    if (/(^|，|,)(OCGONLY|OO)(，|,|$)/.test(rule)) {
      hostinfo.rule = 0;
      hostinfo.lflist = 0;
    }
    if (/(^|，|,)(OT|TCG)(，|,|$)/.test(rule)) {
      hostinfo.rule = 5;
    }
    if (/(^|，|,)(SC|CN|CCG|CHINESE)(，|,|$)/.test(rule)) {
      hostinfo.rule = 2;
      hostinfo.lflist = -1;
    }
    const lpParam = rule.match(/(^|，|,)LP(\d+)(，|,|$)/);
    if (lpParam) {
      let startLp = Number.parseInt(lpParam[2], 10);
      if (startLp <= 0) startLp = 1;
      if (startLp >= 99999) startLp = 99999;
      hostinfo.start_lp = startLp;
    }
    const timeLimitParam = rule.match(/(^|，|,)(TIME|TM|TI)(\d+)(，|,|$)/);
    if (timeLimitParam) {
      let timeLimit = Number.parseInt(timeLimitParam[3], 10);
      if (timeLimit < 0) timeLimit = 180;
      if (timeLimit >= 1 && timeLimit <= 60) timeLimit *= 60;
      if (timeLimit >= 999) timeLimit = 999;
      hostinfo.time_limit = timeLimit;
    }
    const startHandParam = rule.match(/(^|，|,)(START|ST)(\d+)(，|,|$)/);
    if (startHandParam) {
      let startHand = Number.parseInt(startHandParam[3], 10);
      if (startHand <= 0) startHand = 1;
      if (startHand >= 40) startHand = 40;
      hostinfo.start_hand = startHand;
    }
    const drawCountParam = rule.match(/(^|，|,)(DRAW|DR)(\d+)(，|,|$)/);
    if (drawCountParam) {
      let drawCount = Number.parseInt(drawCountParam[3], 10);
      if (drawCount >= 35) drawCount = 35;
      hostinfo.draw_count = drawCount;
    }
    const lflistParam = rule.match(/(^|，|,)(LFLIST|LF)(\d+)(，|,|$)/);
    if (lflistParam) {
      hostinfo.lflist = Number.parseInt(lflistParam[3], 10) - 1;
    }
    if (/(^|，|,)(NOLFLIST|NF)(，|,|$)/.test(rule)) {
      hostinfo.lflist = -1;
    }
    if (/(^|，|,)(NOUNIQUE|NU)(，|,|$)/.test(rule)) {
      hostinfo.rule = 4;
    }
    if (/(^|，|,)(CUSTOM|DIY)(，|,|$)/.test(rule)) {
      hostinfo.rule = 3;
    }
    if (/(^|，|,)(NOCHECK|NC)(，|,|$)/.test(rule)) {
      hostinfo.no_check_deck = 1;
    }
    if (/(^|，|,)(NOSHUFFLE|NS)(，|,|$)/.test(rule)) {
      hostinfo.no_shuffle_deck = 1;
    }
    if (/(^|，|,)(IGPRIORITY|PR)(，|,|$)/.test(rule)) {
      hostinfo.duel_rule = 4;
    }
    const duelRuleParam = rule.match(/(^|，|,)(DUELRULE|MR)(\d+)(，|,|$)/);
    if (duelRuleParam) {
      const duelRule = Number.parseInt(duelRuleParam[3], 10);
      if (duelRule > 0 && duelRule <= 5) {
        hostinfo.duel_rule = duelRule;
      }
    }
    return hostinfo;
  }
}
