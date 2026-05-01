import { ValueContainer } from '../../utility/value-container';
import { Room } from '../room';

export class RoomJoinCheck extends ValueContainer<number | string> {
  constructor(
    public room: Room,
    value: number,
    public hasPlayerBeforeJoin: boolean,
  ) {
    super(value);
  }
}
