import {
  YGOProCtosHsToObserver,
  ChatColor,
  NetPlayerType,
} from 'ygopro-msg-encode';
import { Context } from '../app';
import { RoomManager } from './room-manager';
import { RoomJoinCheck } from './room-event/room-join-check';

export class NoWatchGuard {
  constructor(private ctx: Context) {}

  async init() {
    this.ctx.middleware(RoomJoinCheck, async (event, _client, next) => {
      if (
        event.toPos === NetPlayerType.OBSERVER &&
        event.room.hostinfo.no_watch
      ) {
        return event.use('#{watch_denied}');
      }
      return next();
    });

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
