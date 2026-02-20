import YGOProDeck from 'ygopro-deck-encode';
import { Client } from '../../client';
import { ValueContainer } from '../../utility/value-container';
import { Room } from '../room';
import { YGOProLFListError } from 'ygopro-lflist-encode';
import { CardReader } from 'koishipro-core.js';

export class RoomCheckDeck extends ValueContainer<
  YGOProLFListError | undefined
> {
  constructor(
    public room: Room,
    public client: Client,
    public deck: YGOProDeck,
    public cardReader: CardReader,
  ) {
    super(undefined);
  }
}
