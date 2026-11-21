import { HostInfo } from 'ygopro-msg-encode';
// YRP option bits from ocgcore/common.h.
const DUEL_PSEUDO_SHUFFLE = 0x10;
const DUEL_TAG_MODE = 0x20;

/**
 * Calculate duel options from HostInfo
 * @param hostinfo HostInfo from ygopro-msg-encode
 * @param isTag Whether this is a tag duel
 * @returns Duel options number
 */
export function calculateDuelOptions(hostinfo: HostInfo): number {
  // duel_rule is stored in high 16 bits
  let opt = hostinfo.duel_rule << 16;

  if (hostinfo.no_shuffle_deck) {
    opt |= DUEL_PSEUDO_SHUFFLE;
  }

  if (hostinfo.mode & 0x2) {
    opt |= DUEL_TAG_MODE;
  }

  return opt;
}
