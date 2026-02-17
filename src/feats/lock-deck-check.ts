import YGOProDeck from 'ygopro-deck-encode';
import { Client } from '../client';
import { Room } from '../room';
import { ValueContainer } from '../utility/value-container';

export class LockDeckExpectedDeckCheck extends ValueContainer<
  YGOProDeck | null | undefined
> {
  constructor(
    public room: Room,
    public client: Client,
    public deck: YGOProDeck,
  ) {
    super(undefined);
  }

  get expectedDeck() {
    return this.value;
  }
}
