import { ChatColor, NetPlayerType } from 'ygopro-msg-encode';
import { Context } from '../app';
import { OnRoomJoinObserver } from '../room/room-event/on-room-join-observer';
import { OnRoomLeave } from '../room/room-event/on-room-leave';
import { PlayerName } from '../utility';

export class PlayerStatusNotify {
  constructor(private ctx: Context) {}

  async init() {
    // 观战者加入
    this.ctx.middleware(OnRoomJoinObserver, async (event, client, next) => {
      const room = event.room;
      await room.sendChat(
        [PlayerName(client), ' #{watch_join}'],
        ChatColor.LIGHTBLUE,
      );
      return next();
    });

    // 离开房间（根据 pos 判断是观战者还是玩家）
    this.ctx.middleware(OnRoomLeave, async (event, client, next) => {
      const room = event.room;
      if (client.pos === NetPlayerType.OBSERVER) {
        // 观战者离开
        await room.sendChat(
          [PlayerName(client), ' #{quit_watch}'],
          ChatColor.LIGHTBLUE,
        );
      } else {
        // 玩家离开
        await room.sendChat(
          [PlayerName(client), ' #{left_game}'],
          ChatColor.LIGHTBLUE,
        );
      }
      return next();
    });
  }
}
