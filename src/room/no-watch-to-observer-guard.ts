import { YGOProCtosHsToObserver, ChatColor } from 'ygopro-msg-encode';
import { Context } from '../app';
import { RoomManager } from './room-manager';

export class NoWatchToObserverGuard {
  constructor(private ctx: Context) {}

  async init() {
    this.ctx.middleware(YGOProCtosHsToObserver, async (_msg, client, next) => {
      const room = this.ctx.get(() => RoomManager).findByName(client.roomName);
      if (!room?.hostinfo?.no_watch) {
        return next();
      }
      await client.sendChat('#{watch_denied_room}', ChatColor.BABYBLUE);
      return;
    });
  }
}
