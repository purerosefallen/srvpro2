import { Context } from '../app';
import { Room, RoomFinalizor } from './room';
import BetterLock from 'better-lock';

export class RoomManager {
  constructor(private ctx: Context) {}

  private rooms = new Map<string, Room>();

  private finalizors: RoomFinalizor[] = [];

  addFinalizor(finalizor: RoomFinalizor, atEnd = false) {
    if (atEnd) {
      this.finalizors.push(finalizor);
    } else {
      this.finalizors.unshift(finalizor);
    }
  }

  findByName(name: string) {
    return this.rooms.get(name);
  }

  allRooms() {
    return Array.from(this.rooms.values());
  }

  private roomCreateLock = new BetterLock();

  async findOrCreateByName(name: string) {
    const existing = this.findByName(name);
    if (existing) return existing;

    return this.roomCreateLock.acquire(`room_create:${name}`, async () => {
      const existing = this.findByName(name);
      if (existing) return existing;

      const room = new Room(this.ctx, name).addFinalizor((r) => {
        this.rooms.delete(r.name);
      });
      for (const finalizor of this.finalizors) {
        room.addFinalizor(finalizor);
      }
      await room.init();
      this.rooms.set(name, room);
      return room;
    });
  }
}
