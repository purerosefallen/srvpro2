import { ValueContainer } from '../../utility/value-container';
import { Room } from '../room';

export class RoomUseSeed extends ValueContainer<number[]> {
  constructor(public room: Room) {
    super([]);
  }
}
