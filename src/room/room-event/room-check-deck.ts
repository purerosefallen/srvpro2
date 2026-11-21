import YGOProDeck from 'ygopro-deck-encode';
import { Client } from '../../client';
import { ValueContainer } from '../../utility/value-container';
import { Room } from '../room';

export class RoomCheckDeck extends ValueContainer<
  { toPayload(): number } | undefined
> {
  constructor(
    public room: Room,
    public client: Client,
    public deck: YGOProDeck,
  ) {
    super(undefined);
  }

  /** Legacy tournament, arena and recovery checks use the generic zero error. */
  reject() {
    return this.use({ toPayload: () => 0 });
  }
}
