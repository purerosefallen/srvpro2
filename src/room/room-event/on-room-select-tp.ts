import { Client } from '../../client';
import { Room } from '../room';
import { RoomEvent } from './room-event';

export class OnRoomSelectTp extends RoomEvent {
  constructor(
    room: Room,
    public selector: Client,
  ) {
    super(room);
  }
}
