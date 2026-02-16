import { ChatColor, YGOProCtosJoinGame } from 'ygopro-msg-encode';
import { Context } from '../app';
import { RandomDuelProvider } from '../feats';

export class RandomDuelJoinHandler {
  private randomDuelProvider = this.ctx.get(() => RandomDuelProvider);

  constructor(private ctx: Context) {
    if (!this.randomDuelProvider.enabled) {
      return;
    }
    this.ctx.middleware(YGOProCtosJoinGame, async (msg, client, next) => {
      msg.pass = (msg.pass || '').trim();
      const type = this.randomDuelProvider.resolveRandomType(msg.pass);
      if (type == null) {
        return next();
      }
      const room = await this.randomDuelProvider.findOrCreateRandomRoom(
        type,
        client.ip,
      );
      if (!room) {
        return client.die('#{create_room_failed}', ChatColor.RED);
      }
      return room.join(client);
    });
  }
}
