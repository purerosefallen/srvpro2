import { YGOProCtosJoinGame } from 'ygopro-msg-encode';
import { Context } from '../app';
import { Client } from '../client';
import { MenuEntry, MenuManager } from '../feats';
import { DuelStage, RoomManager } from '../room';

export class JoinRoomlist {
  private logger = this.ctx.createLogger(this.constructor.name);
  private menuManager = this.ctx.get(() => MenuManager);
  private roomManager = this.ctx.get(() => RoomManager);
  private enabled = this.ctx.config.getBoolean('ENABLE_ROOMLIST');

  constructor(private ctx: Context) {
    this.ctx.middleware(YGOProCtosJoinGame, async (msg, client, next) => {
      if (!this.enabled) {
        return next();
      }
      const pass = (msg.pass || '').trim();
      if (!pass || pass.toUpperCase() !== 'L') {
        return next();
      }

      await this.openRoomListMenu(client);
      return msg;
    });
  }

  private async openRoomListMenu(client: Client) {
    await this.menuManager.launchMenu(client, async () => {
      const roomNames = this.roomManager
        .allRooms()
        .filter(
          (room) =>
            (room.native ||
              (room.duelStage !== DuelStage.Begin && room.challongeInfo)) &&
            !room.name.includes('$'),
        )
        .map((room) => room.name);

      const menu: MenuEntry[] = roomNames.map((roomName) => ({
        title: roomName,
        callback: async (menuClient) => {
          const room = this.roomManager.findByName(roomName);
          if (!room || !room.native) {
            this.logger.debug(
              { roomName },
              'Roomlist target room no longer exists',
            );
            await this.openRoomListMenu(menuClient);
            return;
          }
          await room.join(menuClient);
        },
      }));
      return menu;
    });
  }
}
