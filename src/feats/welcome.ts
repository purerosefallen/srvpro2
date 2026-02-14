import { ChatColor } from 'ygopro-msg-encode';
import { Context } from '../app';
import { OnRoomJoin } from '../room/room-event/on-room-join';

declare module '../room' {
  interface Room {
    welcome: string;
    welcome2: string;
  }
}

export class Welcome {
  private welcomeMessage = this.ctx.getConfig('WELCOME');

  constructor(private ctx: Context) {
    this.ctx.middleware(OnRoomJoin, async (event, client, next) => {
      const room = event.room;
      if (this.welcomeMessage) {
        await client.sendChat(this.welcomeMessage, ChatColor.GREEN);
      }
      if (room.welcome) {
        await client.sendChat(room.welcome, ChatColor.BABYBLUE);
      }
      if (room.welcome2) {
        await client.sendChat(room.welcome2, ChatColor.PINK);
      }
      return next();
    });
  }
}
