import { CardReader } from 'koishipro-core.js';
import YGOProDeck from 'ygopro-deck-encode';
import { Client } from '../../client';
import { ValueContainer } from '../../utility/value-container';
import { Room } from '../room';

export class RoomSideCheck extends ValueContainer<boolean> {
  constructor(
    public room: Room,
    public client: Client,
    public deck: YGOProDeck,
    public startDeck: YGOProDeck,
    public cardReader: CardReader,
  ) {
    super(false);
  }

  get isValid() {
    return !this.value;
  }

  no() {
    return this.use(true);
  }
}
