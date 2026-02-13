import { YGOProCtosJoinGame } from 'ygopro-msg-encode';
import { Context } from '../app';
import { RoomManager } from '../room/room-manager';

export class JoinRoom {
  constructor(private ctx: Context) {
    this.ctx.middleware(YGOProCtosJoinGame, async (msg, client, next) => {
      if (!msg.pass) {
        return next();
      }
      const roomManager = this.ctx.get(() => RoomManager);
      const room = await roomManager.findOrCreateByName(msg.pass);
      return room.join(client);
    });
  }
}
