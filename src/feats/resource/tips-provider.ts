import { ChatColor } from 'ygopro-msg-encode';
import { Context } from '../../app';
import { Chnroute, Client } from '../../client';
import { DuelStage, OnRoomDuelStart, Room, RoomManager } from '../../room';
import { ValueContainer } from '../../utility/value-container';
import { pickRandom } from '../../utility/pick-random';
import { BaseResourceProvider } from './base-resource-provider';
import { EMPTY_TIPS_DATA, TipsData } from './types';

export class TipsLookup extends ValueContainer<string[]> {
  constructor(
    public room: Room,
    public client: Client,
  ) {
    super([]);
  }
}

export class TipsProvider extends BaseResourceProvider<TipsData> {
  enabled = this.ctx.config.getBoolean('ENABLE_TIPS');

  private splitZh = this.ctx.config.getBoolean('TIPS_SPLIT_ZH');
  private prefix = this.ctx.config.getString('TIPS_PREFIX');
  private intervalMs = Math.max(
    0,
    this.ctx.config.getInt('TIPS_INTERVAL') || 0,
  );
  private intervalIngameMs = Math.max(
    0,
    this.ctx.config.getInt('TIPS_INTERVAL_INGAME') || 0,
  );
  private chnroute = this.ctx.get(() => Chnroute);
  private roomManager = this.ctx.get(() => RoomManager);
  private timersRegistered = false;

  constructor(ctx: Context) {
    super(ctx, {
      resourceName: 'tips',
      emptyData: EMPTY_TIPS_DATA,
    });

    if (!this.enabled) {
      return;
    }

    this.ctx.middleware(OnRoomDuelStart, async (event, _client, next) => {
      await this.sendRandomTipToRoom(event.room);
      return next();
    });
  }

  async init() {
    await super.init();
    this.registerAutoTipTimers();
  }

  private registerAutoTipTimers() {
    if (!this.enabled || this.timersRegistered) {
      return;
    }
    this.timersRegistered = true;
    if (this.intervalMs > 0) {
      setInterval(() => {
        this.sendTipsByDuelState(false).catch((error) => {
          this.logger.warn(
            { error: (error as Error).toString() },
            'Failed auto-sending non-duel tips',
          );
        });
      }, this.intervalMs);
    }
    if (this.intervalIngameMs > 0) {
      setInterval(() => {
        this.sendTipsByDuelState(true).catch((error) => {
          this.logger.warn(
            { error: (error as Error).toString() },
            'Failed auto-sending ingame tips',
          );
        });
      }, this.intervalIngameMs);
    }
  }

  async refreshResources() {
    if (!this.enabled) {
      return false;
    }
    return this.refreshFromRemote();
  }

  async getRandomTip(room: Room, client: Client) {
    if (!this.enabled) {
      return undefined;
    }
    const event = await this.ctx.dispatch(new TipsLookup(room, client), client);
    const tips = (event?.value || []).filter((tip) => !!tip);
    return pickRandom(tips);
  }

  async sendRandomTip(client: Client, room?: Room) {
    if (!this.enabled) {
      return false;
    }
    const targetRoom = room || this.resolveClientRoom(client);
    if (!targetRoom) {
      return false;
    }
    try {
      const tip = await this.getRandomTip(targetRoom, client);
      if (!tip) {
        return false;
      }
      await client.sendChat(`${this.prefix}${tip}`, ChatColor.LIGHTBLUE);
      return true;
    } catch (error) {
      this.logger.warn(
        {
          roomName: targetRoom.name,
          clientName: client.name,
          error: (error as Error).toString(),
        },
        'Failed sending random tip',
      );
      return false;
    }
  }

  async sendRandomTipToRoom(room: Room) {
    if (!this.enabled) {
      return false;
    }
    const tasks = room.allPlayers.map((player) =>
      this.sendRandomTip(player, room).catch((error) => {
        this.logger.warn(
          {
            roomName: room.name,
            clientName: player.name,
            error: (error as Error).toString(),
          },
          'Failed sending random tip to room player',
        );
        return false;
      }),
    );
    await Promise.all(tasks);
    return true;
  }

  protected registerLookupMiddleware() {
    this.ctx.middleware(TipsLookup, async (event, _client, next) => {
      const data = this.getResourceData();
      const locale = this.chnroute.getLocale(event.client.ip).toLowerCase();
      const isZh = locale.startsWith('zh');
      if (this.splitZh && isZh && data.tips_zh.length) {
        event.use(data.tips_zh);
      } else {
        event.use(data.tips);
      }
      return next();
    });
  }

  protected getRemoteLoadEntries() {
    return [
      {
        field: 'tips' as const,
        url: this.ctx.config.getString('TIPS_GET').trim(),
      },
      {
        field: 'tips_zh' as const,
        url: this.ctx.config.getString('TIPS_GET_ZH').trim(),
      },
    ];
  }

  protected isEnabled() {
    return this.enabled;
  }

  private resolveClientRoom(client: Client) {
    if (!client.roomName) {
      return undefined;
    }
    return this.roomManager.findByName(client.roomName);
  }

  private async sendTipsByDuelState(dueling: boolean) {
    if (!this.enabled) {
      return;
    }
    const rooms = this.roomManager
      .allRooms()
      .filter((room) => !room.finalizing && room.duelStage !== DuelStage.End)
      .filter((room) =>
        dueling
          ? room.duelStage === DuelStage.Dueling
          : room.duelStage !== DuelStage.Dueling,
      );

    await Promise.all(
      rooms.map((room) =>
        this.sendRandomTipToRoom(room).catch((error) => {
          this.logger.warn(
            {
              roomName: room.name,
              error: (error as Error).toString(),
            },
            'Failed auto-sending tips to room',
          );
          return false;
        }),
      ),
    );
  }
}
