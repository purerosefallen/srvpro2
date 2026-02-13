import { Room } from '../room';
import { RoomEvent } from './room-event';

export class OnRoomLeavePlayer extends RoomEvent {
  constructor(
    room: Room,
    public oldPos: number,
  ) {
    super(room);
  }
}
