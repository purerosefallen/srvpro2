import type { Room } from '..';
import { RoomEvent } from './room-event';

/** Observer membership has been committed, before subsequent network sends. */
export class OnRoomObserverChange extends RoomEvent {
  constructor(
    room: Room,
    public readonly observing: boolean,
  ) {
    super(room);
  }
}
