import { NetPlayerType } from 'ygopro-msg-encode';
import { Context } from '../app';
import { Client } from '../client';
import { DuelStage } from './duel-stage';
import { Room } from './room';
import { RoomManager } from './room-manager';

const CLEAN_INTERVAL_MS = 10 * 60 * 1000;

export class ZombieRoomCleaner {
  private logger = this.ctx.createLogger('ZombieRoomCleaner');
  private roomManager = this.ctx.get(() => RoomManager);
  private timerRegistered = false;
  private cleaning = false;

  constructor(private ctx: Context) {}

  async init() {
    this.registerTimer();
  }

  private registerTimer() {
    if (this.timerRegistered) {
      return;
    }
    this.timerRegistered = true;
    setInterval(() => {
      this.cleanZombieRooms().catch((error) => {
        this.logger.warn({ error }, 'Failed cleaning zombie rooms');
      });
    }, CLEAN_INTERVAL_MS);
  }

  private async cleanZombieRooms() {
    if (this.cleaning) {
      return;
    }
    this.cleaning = true;
    try {
      const rooms = this.roomManager.allRooms();
      let disconnectCount = 0;
      let finalizeCount = 0;
      for (const room of rooms) {
        const result = await this.cleanRoom(room);
        disconnectCount += result.disconnectCount;
        if (result.finalized) {
          finalizeCount += 1;
        }
      }
      if (disconnectCount > 0 || finalizeCount > 0) {
        this.logger.info(
          {
            roomCount: rooms.length,
            disconnectCount,
            finalizeCount,
          },
          'ZombieRoomCleaner cleaned rooms',
        );
      }
    } finally {
      this.cleaning = false;
    }
  }

  private async cleanRoom(room: Room) {
    if (room.finalizing) {
      return {
        disconnectCount: 0,
        finalized: false,
      };
    }

    const allPlayers = room.allPlayers;
    const zombiePlayers = allPlayers.filter((player) =>
      this.isZombiePlayer(room, player),
    );
    let disconnectCount = 0;

    await Promise.all(
      zombiePlayers.map(async (player) => {
        try {
          await player._disconnect();
          disconnectCount += 1;
        } catch {}
      }),
    );

    if (allPlayers.every((player) => this.isZombiePlayer(room, player))) {
      await room.finalize();
      return {
        disconnectCount,
        finalized: true,
      };
    }
    return {
      disconnectCount,
      finalized: false,
    };
  }

  private isZombiePlayer(room: Room, player: Client) {
    if (!player.disconnected) {
      return false;
    }
    if (player.pos === NetPlayerType.OBSERVER) {
      return true;
    }
    return room.duelStage === DuelStage.Begin;
  }
}
