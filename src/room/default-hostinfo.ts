import { HostInfo } from 'ygopro-msg-encode';

export const DefaultHostinfo: HostInfo = {
  lflist: 0, // lflist index
  rule: 0, // 0: OCG, 1: TCG, 2: SC, 3: NOUNIQUE, 4: CUSTOM, 5: ALL
  mode: 0, // 0: single, 1: match, 2: tag
  duel_rule: 5, // 1-5
  no_check_deck: 0,
  no_shuffle_deck: 0,
  start_lp: 8000,
  start_hand: 5,
  draw_count: 1,
  time_limit: 240,
  no_watch: 0,
  auto_death: 0,
};
