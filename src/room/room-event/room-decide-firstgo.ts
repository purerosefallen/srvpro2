import { ValueContainer } from '../../utility/value-container';
import { Room } from '../room';

export class RoomDecideFirstgo extends ValueContainer<number | undefined> {
  constructor(public room: Room) {
    super(undefined);
  }
}
