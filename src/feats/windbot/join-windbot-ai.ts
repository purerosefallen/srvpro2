import { ChatColor, YGOProCtosJoinGame } from 'ygopro-msg-encode';
import { Context } from '../../app';
import { Client } from '../../client';
import { WindBotProvider } from './windbot-provider';
import { RoomCreateError, RoomManager } from '../../room';
import { MAX_ROOM_NAME_LENGTH } from '../../constants/room';
import { fillRandomString } from '../../utility/fill-random-string';
import { parseWindbotOptions } from './utility';

const getDisplayLength = (text: string) =>
  text.replace(/[^\x00-\xff]/g, '00').length;

export class JoinWindbotAi {
  private logger = this.ctx.createLogger(this.constructor.name);
  private windbotProvider = this.ctx.get(() => WindBotProvider);
  private roomManager = this.ctx.get(() => RoomManager);

  constructor(private ctx: Context) {}

  async init() {
    if (!this.windbotProvider.enabled) {
      return;
    }
    this.ctx.middleware(YGOProCtosJoinGame, async (msg, client, next) => {
      if (!(await this.joinByPass(msg.pass, client))) {
        return next();
      }
      return;
    });
  }

  async joinByPass(pass: string, client: Client) {
    const normalizedPass = (pass || '').trim();
    if (
      !this.windbotProvider.enabled ||
      !normalizedPass ||
      !normalizedPass.toUpperCase().startsWith('AI')
    ) {
      return false;
    }

    const existingRoom = this.roomManager.findByName(normalizedPass);
    if (existingRoom) {
      await existingRoom.join(client);
      return true;
    }

    const requestedBotName = this.parseRequestedBotName(normalizedPass);
    if (
      requestedBotName &&
      !this.windbotProvider.getBotByNameOrDeck(requestedBotName)
    ) {
      await client.die('#{windbot_deck_not_found}', ChatColor.RED);
      return true;
    }

    const roomName = this.generateWindbotRoomName(normalizedPass);
    if (!roomName) {
      await client.die('#{create_room_failed}', ChatColor.RED);
      return true;
    }
    if (getDisplayLength(roomName) > 20) {
      await client.die('#{windbot_name_too_long}', ChatColor.RED);
      return true;
    }

    const room = await this.roomManager.findOrCreateByName(roomName, client, {
      rule: 5,
      lflist: -1,
      time_limit: 0,
    });
    if (room instanceof RoomCreateError) {
      await client.die(room.message, ChatColor.RED);
      return true;
    }
    room.noHost = true;
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
        return true;
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
    return true;
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
      const roomName = fillRandomString(prefix, MAX_ROOM_NAME_LENGTH);
      if (!this.roomManager.findByName(roomName)) {
        return roomName;
      }
    }
    return undefined;
  }
}
