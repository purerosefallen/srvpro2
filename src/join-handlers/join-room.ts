import { YGOProCtosJoinGame } from 'ygopro-msg-encode';
import { Context } from '../app';
import { RoomManager } from '../room/room-manager';

export class JoinRoom {
  private logger = this.ctx.createLogger(this.constructor.name);
  constructor(private ctx: Context) {
    this.ctx.middleware(YGOProCtosJoinGame, async (msg, client, next) => {
      if (!msg.pass) {
        return next();
      }
      this.logger.debug({ name: client.name, pass: msg.pass }, 'Joining room');
      const roomManager = this.ctx.get(() => RoomManager);
      const existing = roomManager.findByName(msg.pass);
      if (existing) {
        return existing.join(client);
      }
      const room = await roomManager.findOrCreateByName(msg.pass);
      room.native = true;
      return room.join(client);
    });
  }
}
