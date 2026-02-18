import { ChatColor } from 'ygopro-msg-encode';
import { Context } from '../app';
import { DialoguesProvider, TipsProvider } from '../feats/resource';
import { RoomDeathService } from '../feats/room-death-service';
import { DuelStage, RoomInfo, RoomManager } from '../room';
import { LegacyRoomIdService } from './legacy-room-id-service';
import { IpResolver } from '../client/ip-resolver';

type ApiMessageHandler = {
  permission: string;
  callback: (
    value: string,
    query: Record<string, string>,
  ) => Promise<unknown[]>;
};

const API_MESSAGE_META_FIELDS = new Set([
  'username',
  'pass',
  'password',
  'callback',
]);

export class LegacyApiService {
  private logger = this.ctx.createLogger('LegacyApiService');
  private roomIdService = this.ctx.get(() => LegacyRoomIdService);
  private handlers = new Map<string, ApiMessageHandler>();
  private ipResolver = this.ctx.get(() => IpResolver);

  constructor(private ctx: Context) {
    this.registerDefaultHandlers();
    this.registerRoutes();
  }

  addApiMessageHandler(
    name: string,
    permission: string,
    callback: ApiMessageHandler['callback'],
  ) {
    this.handlers.set(name, {
      permission,
      callback,
    });
    return this;
  }

  private registerDefaultHandlers() {
    this.addApiMessageHandler('shout', 'shout', async (value) => {
      const text = String(value || '');
      const roomManager = this.ctx.get(() => RoomManager);
      for (const room of roomManager.allRooms()) {
        await room.sendChat(text, ChatColor.YELLOW);
      }
      return ['shout ok', text];
    });

    this.addApiMessageHandler('loadtips', 'change_settings', async () => {
      const success = await this.ctx.get(() => TipsProvider).refreshResources();
      return [
        success ? 'tip ok' : 'tip fail',
        this.ctx.config.getString('TIPS_GET'),
      ];
    });

    this.addApiMessageHandler('loaddialogues', 'change_settings', async () => {
      const provider = this.ctx.get(() => DialoguesProvider);
      const success = await provider.refreshResources();
      return [
        success ? 'dialogue ok' : 'dialogue fail',
        this.ctx.config.getString('DIALOGUES_GET'),
      ];
    });

    this.addApiMessageHandler('kick', 'kick_user', async (value) => {
      const found = await this.kickByTarget(value);
      if (!found) {
        return ['room not found', value];
      }
      return ['kick ok', value];
    });

    this.addApiMessageHandler('reboot', 'stop', async (value) => {
      await this.kickByTarget('all');
      setTimeout(() => process.exit(0), 100);
      return ['reboot ok', value];
    });

    this.addApiMessageHandler('death', 'start_death', async (value) => {
      const roomDeathService = this.ctx.get(() => RoomDeathService);
      const foundRooms =
        value === 'all'
          ? this.ctx.get(() => RoomManager).allRooms()
          : this.findRoomByTarget(value);
      if (!foundRooms.length) {
        return ['room not found', value];
      }
      let changed = false;
      for (const room of foundRooms) {
        if (await roomDeathService.startDeath(room)) {
          changed = true;
        }
      }
      if (!changed) {
        return ['room not found', value];
      }
      return ['death ok', value];
    });

    this.addApiMessageHandler('deathcancel', 'start_death', async (value) => {
      const roomDeathService = this.ctx.get(() => RoomDeathService);
      const foundRooms =
        value === 'all'
          ? this.ctx.get(() => RoomManager).allRooms()
          : this.findRoomByTarget(value);
      if (!foundRooms.length) {
        return ['room not found', value];
      }
      let changed = false;
      for (const room of foundRooms) {
        if (await roomDeathService.cancelDeath(room)) {
          changed = true;
        }
      }
      if (!changed) {
        return ['room not found', value];
      }
      return ['death cancel ok', value];
    });
  }

  private registerRoutes() {
    const router = this.ctx.router;

    router.get('/api/getrooms', async (koaCtx) => {
      const username = String(koaCtx.query.username || '');
      const pass = String(koaCtx.query.pass || koaCtx.query.password || '');
      const passValidated = await this.ctx.legacyApiAuth.auth(
        username,
        pass,
        'get_rooms',
        'get_rooms',
      );
      if (!passValidated) {
        koaCtx.body = {
          rooms: [
            {
              roomid: '0',
              roomname: '密码错误',
              needpass: 'true',
            },
          ],
        };
        return;
      }

      const roomManager = this.ctx.get(() => RoomManager);
      const rooms = roomManager.allRooms();
      const roomInfos = await Promise.all(
        rooms.map(async (room) => {
          const info = await room.getInfo();
          const users = [...info.players]
            .sort((a, b) => a.pos - b.pos)
            .map((player) => ({
              id: '-1',
              name: player.name,
              ip: this.ipResolver.toIpv4(player.ip) || null,
              status:
                info.duelStage !== DuelStage.Begin
                  ? {
                      score: player.score ?? 0,
                      lp: player.lp ?? info.hostinfo.start_lp,
                      cards: player.cardCount ?? info.hostinfo.start_hand,
                    }
                  : null,
              pos: player.pos,
            }));
          return {
            roomid: this.roomIdService.getRoomIdString(info.identifier),
            roomname: info.name,
            roommode: info.hostinfo.mode,
            needpass: (info.name.includes('$') ? true : false).toString(),
            users,
            istart: this.buildRoomIstart(info, room.death),
          };
        }),
      );

      koaCtx.body = {
        rooms: roomInfos,
      };
    });

    router.get('/api/message', async (koaCtx) => {
      const rawQuery = koaCtx.query as Record<
        string,
        string | string[] | undefined
      >;
      const query: Record<string, string> = {};
      for (const [key, value] of Object.entries(rawQuery)) {
        query[key] = Array.isArray(value)
          ? String(value[0] || '')
          : String(value || '');
      }
      const username = String(query.username || '');
      const pass = String(query.pass || query.password || '');

      const matchedName = Object.keys(query).find(
        (key) => !API_MESSAGE_META_FIELDS.has(key) && this.handlers.has(key),
      );
      if (!matchedName) {
        koaCtx.status = 400;
        koaCtx.body = '400';
        return;
      }
      const handler = this.handlers.get(matchedName)!;
      const value = String(query[matchedName] || '');
      const passValidated = await this.ctx.legacyApiAuth.auth(
        username,
        pass,
        handler.permission,
        matchedName,
      );
      if (!passValidated) {
        koaCtx.body = ['密码错误', 0];
        return;
      }

      koaCtx.body = await handler.callback(value, query);
    });
  }

  private async kickByTarget(target: string) {
    const value = (target || '').trim();
    if (!value) {
      return false;
    }
    const roomManager = this.ctx.get(() => RoomManager);
    const foundRooms =
      value === 'all' ? roomManager.allRooms() : this.findRoomByTarget(value);
    if (!foundRooms.length) {
      return false;
    }
    await Promise.all(foundRooms.map((room) => room.finalize(true)));
    return true;
  }

  findRoomByTarget(target: string) {
    const roomManager = this.ctx.get(() => RoomManager);
    const roomByName = roomManager.findByName(target);
    if (roomByName) {
      return [roomByName];
    }
    const roomName = this.roomIdService.findRoomNameByRoomId(target);
    if (!roomName) {
      return [];
    }
    const roomById = roomManager.findByName(roomName);
    return roomById ? [roomById] : [];
  }

  private buildRoomIstart(
    info: Pick<RoomInfo, 'duelStage' | 'duels' | 'turnCount'>,
    death?: number,
  ) {
    if (info.duelStage === DuelStage.Begin) {
      return 'wait';
    }

    const duelText = `Duel:${info.duels.length}`;
    const deathSuffix = this.formatDeathIstartSuffix(death);
    if (info.duelStage === DuelStage.Siding) {
      return `${duelText} Siding`;
    }
    if (info.duelStage === DuelStage.Finger) {
      return `${duelText} Finger`;
    }
    if (info.duelStage === DuelStage.FirstGo) {
      return `${duelText} FirstGo`;
    }
    if (info.duelStage === DuelStage.Dueling) {
      const turn = Number.isFinite(info.turnCount) ? Number(info.turnCount) : 0;
      return `${duelText} Turn:${turn}${deathSuffix}`;
    }

    return 'start';
  }

  private formatDeathIstartSuffix(death?: number) {
    if (!death) {
      return '';
    }
    return `/${death > 0 ? death - 1 : 'Death'}`;
  }
}
