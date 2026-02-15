import { ChatColor, YGOProCtosJoinGame } from 'ygopro-msg-encode';
import { Context } from '../app';
import { WindBotProvider } from './windbot-provider';
import { RoomManager } from '../room';
import { fillRandomString } from '../utility/fill-random-string';
import { parseWindbotOptions } from './utility';

const getDisplayLength = (text: string) =>
  text.replace(/[^\x00-\xff]/g, '00').length;

export class JoinWindbotAi {
  private logger = this.ctx.createLogger(this.constructor.name);
  private windbotProvider = this.ctx.get(() => WindBotProvider);
  private roomManager = this.ctx.get(() => RoomManager);

  constructor(private ctx: Context) {
    if (!this.windbotProvider.enabled) {
      return;
    }
    this.ctx.middleware(YGOProCtosJoinGame, async (msg, client, next) => {
      msg.pass = (msg.pass || '').trim();
      if (!msg.pass || !msg.pass.toUpperCase().startsWith('AI')) {
        return next();
      }

      const existingRoom = this.roomManager.findByName(msg.pass);
      if (existingRoom) {
        return existingRoom.join(client);
      }

      const requestedBotName = this.parseRequestedBotName(msg.pass);
      if (
        requestedBotName &&
        !this.windbotProvider.getBotByNameOrDeck(requestedBotName)
      ) {
        return client.die('#{windbot_deck_not_found}', ChatColor.RED);
      }

      const roomName = this.generateWindbotRoomName(msg.pass);
      if (!roomName) {
        return client.die('#{create_room_failed}', ChatColor.RED);
      }
      if (getDisplayLength(roomName) > 20) {
        return client.die('#{windbot_name_too_long}', ChatColor.RED);
      }

      const room = await this.roomManager.findOrCreateByName(roomName, {
        rule: 5,
        lflist: -1,
        time_limit: 0,
      });
      room.noReconnect = true;
      room.windbot = {
        name: '',
        deck: '',
      };
      const windbotOptions = parseWindbotOptions(room.name);

      await room.join(client);
      const requestCount = room.isTag ? 3 : 1;
      for (let i = 0; i < requestCount; i += 1) {
        const requestOk = await this.windbotProvider.requestWindbotJoin(
          room,
          requestedBotName,
          windbotOptions,
        );
        if (!requestOk) {
          await room.finalize();
          return;
        }
      }

      this.logger.debug(
        {
          player: client.name,
          roomName: room.name,
          botName: room.windbot?.name,
          requestCount,
        },
        'Created windbot room',
      );
      return;
    });
  }

  private parseRequestedBotName(pass: string) {
    const parts = pass.split('#');
    if (parts.length > 1) {
      return parts[parts.length - 1];
    }
    return undefined;
  }

  private generateWindbotRoomName(pass: string) {
    for (let i = 0; i < 1000; i += 1) {
      let prefix = '';
      if (pass.toUpperCase() === 'AI') {
        prefix = 'AI#';
      } else if (pass.includes('#')) {
        const roomPrefix = pass.split('#')[0]?.toUpperCase() || 'AI';
        prefix = `${roomPrefix}#`;
      } else {
        prefix = `${pass}#`;
      }
      const roomName = fillRandomString(prefix, 19);
      if (!this.roomManager.findByName(roomName)) {
        return roomName;
      }
    }
    return undefined;
  }
}
