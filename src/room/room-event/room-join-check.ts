import { ValueContainer } from '../../utility/value-container';
import { Room } from '../room';

export class RoomJoinCheck extends ValueContainer<string> {
  constructor(
    public room: Room,
    public toPos: number,
    public hasPlayerBeforeJoin: boolean,
  ) {
    super('');
  }
}
