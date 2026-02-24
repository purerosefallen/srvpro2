import { Context } from '../app';
import { Room, RoomFinalizor } from './room';
import BetterLock from 'better-lock';
import { HostInfo } from 'ygopro-msg-encode';

declare module './room' {
  export interface Room {
    native?: boolean;
  }
}

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

  findByName(name: string | undefined) {
    if (!name) return undefined;
    return this.rooms.get(name);
  }

  allRooms() {
    return Array.from(this.rooms.values());
  }

  private roomCreateLock = new BetterLock();

  private logger = this.ctx.createLogger('RoomManager');

  async findOrCreateByName(name: string, hostinfo?: Partial<HostInfo>) {
    const existing = this.findByName(name);
    if (existing) return existing;

    return this.roomCreateLock.acquire(`room_create:${name}`, async () => {
      const existing = this.findByName(name);
      if (existing) return existing;

      const room = new Room(this.ctx, name, hostinfo).addFinalizor((r) => {
        this.rooms.delete(r.name);
        this.logger.info(
          { room: r.name, roomCount: this.rooms.size },
          'Room finalized and removed',
        );
      });
      for (const finalizor of this.finalizors) {
        room.addFinalizor(finalizor);
      }
      await room.init();
      this.rooms.set(name, room);
      this.logger.info(
        { room: name, roomCount: this.rooms.size },
        'Room created',
      );
      return room;
    });
  }
}
