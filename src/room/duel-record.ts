import YGOProDeck from 'ygopro-deck-encode';
import { YGOProYrp, ReplayHeader } from 'ygopro-yrp-encode';
import { Room } from './room';

// Constants from ygopro
const REPLAY_COMPRESSED = 0x1;
const REPLAY_TAG = 0x2;
const REPLAY_UNIFORM = 0x10;
const REPLAY_ID_YRP2 = 0x32707279;
const PRO_VERSION = 0x1362;

export class DuelRecord {
  constructor(
    public seed: number[],
    public players: { name: string; deck: YGOProDeck }[],
  ) {}
  date = new Date();
  winPosition?: number;
  responses: Buffer[] = [];

  toYrp(room: Room) {
    const isTag = room.isTag;

    // Create replay header
    const header = new ReplayHeader();
    header.id = REPLAY_ID_YRP2;
    header.version = PRO_VERSION;
    header.flag = REPLAY_COMPRESSED | REPLAY_UNIFORM;
    if (isTag) {
      header.flag |= REPLAY_TAG;
    }
    header.seedSequence = this.seed;
    // Set start_time (stored in hash field) as Unix timestamp in seconds
    header.hash = Math.floor(this.date.getTime() / 1000);

    // Build YGOProYrp object
    // Note: players array is already swapped
    //
    // YGOProYrp field order matches ygopro replay write order:
    // Single mode:
    //   - hostName, clientName = players[0], players[1]
    //   - hostDeck, clientDeck = players[0].deck, players[1].deck
    //
    // Tag mode (ygopro writes: players[0-3] names, then pdeck[0,1,3,2]):
    //   - hostName, tagHostName, tagClientName, clientName = players[0], players[1], players[2], players[3]
    //   - hostDeck, tagHostDeck, tagClientDeck, clientDeck = players[0], players[1], players[3], players[2]
    //     (note the deck order: 0,1,3,2 - this matches ygopro's load order)
    const yrp = new YGOProYrp({
      header,
      hostName: this.players[0]?.name || '',
      clientName: isTag
        ? this.players[3]?.name || ''
        : this.players[1]?.name || '',
      startLp: room.hostinfo.start_lp,
      startHand: room.hostinfo.start_hand,
      drawCount: room.hostinfo.draw_count,
      opt: room.opt,
      hostDeck: this.players[0]?.deck || null,
      clientDeck: isTag
        ? this.players[2]?.deck || null
        : this.players[1]?.deck || null,
      tagHostName: isTag ? this.players[1]?.name || '' : null,
      tagClientName: isTag ? this.players[2]?.name || '' : null,
      tagHostDeck: isTag ? this.players[1]?.deck || null : null,
      tagClientDeck: isTag ? this.players[3]?.deck || null : null,
      singleScript: null,
      responses: this.responses.map((buf) => new Uint8Array(buf)),
    });

    return yrp;
  }
}
