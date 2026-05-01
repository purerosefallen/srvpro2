import YGOProDeck from 'ygopro-deck-encode';
import { ValueContainer } from '../../utility/value-container';
import type { DuelRecord } from '../duel-record';
import type { Room } from '../room';

export class RoomShuffleDeck extends ValueContainer<YGOProDeck[]> {
  constructor(
    public room: Room,
    public duelRecord: DuelRecord,
    public isPosSwapped: boolean,
    public players: DuelRecord['players'],
    public seed: number[],
  ) {
    super(players.map((player) => player.deck));
  }
}
