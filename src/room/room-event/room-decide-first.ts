import { ValueContainer } from '../../utility/value-container';
import { Room } from '../room';

export class RoomDecideFirst extends ValueContainer<number | undefined> {
  constructor(public room: Room) {
    super(undefined);
  }
}
