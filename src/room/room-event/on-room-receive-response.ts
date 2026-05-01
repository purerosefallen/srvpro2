import { Room } from '../room';
import { RoomEvent } from './room-event';

export class OnRoomReceiveResponse extends RoomEvent {
  constructor(
    room: Room,
    public response: Buffer,
  ) {
    super(room);
  }
}
