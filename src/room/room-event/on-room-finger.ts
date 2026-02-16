import { Client } from '../../client';
import { Room } from '../room';
import { RoomEvent } from './room-event';

export class OnRoomFinger extends RoomEvent {
  constructor(room: Room, public fingerPlayers: [Client, Client]) {
    super(room);
  }
}
