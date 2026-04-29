import { Context } from '../app';
import { Room, RoomFinalizor } from './room';
import BetterLock from 'better-lock';
import { HostInfo } from 'ygopro-msg-encode';
import { Client } from '../client';
import { DefaultHostInfoProvider } from './default-hostinfo-provder';
import { RoomCreateCheck } from './room-event/room-create-check';

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

  async findOrCreateByName(
    name: string,
    creator: Client,
    hostinfo?: Partial<HostInfo>,
  ): Promise<Room | RoomCreateError> {
    const existing = this.findByName(name);
    if (existing) return existing;

    return this.roomCreateLock.acquire(`room_create:${name}`, async () => {
      const existing = this.findByName(name);
      if (existing) return existing;

      const resolvedHostinfo = this.ctx
        .get(() => DefaultHostInfoProvider)
        .parseHostinfo(name, hostinfo);
      const createCheck = await this.ctx.dispatch(
        new RoomCreateCheck(resolvedHostinfo, name),
        creator,
      );
      if (createCheck?.value) {
        return new RoomCreateError(createCheck.value);
      }

      const room = new Room(
        this.ctx,
        name,
        resolvedHostinfo,
        resolvedHostinfo,
      ).addFinalizor((r) => {
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

export class RoomCreateError {
  constructor(public message: string) {}
}
