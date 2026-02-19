import { ChatColor, YGOProCtosJoinGame } from 'ygopro-msg-encode';
import { Context } from '../app';
import { LegacyBanEntity } from './legacy-ban.entity';
import { RoomManager } from '../room';
import { HidePlayerNameProvider } from '../feats';
import { LegacyApiService } from './legacy-api-service';

export class LegacyBanService {
  private logger = this.ctx.createLogger('LegacyBanService');
  private hidePlayerNameProvider = this.ctx.get(() => HidePlayerNameProvider);

  constructor(private ctx: Context) {
    this.ctx
      .get(() => LegacyApiService)
      .addApiMessageHandler('ban', 'ban_user', async (value) => {
        const result = await this.banUser(value);
        return [result ? 'ban ok' : 'ban fail', value];
      });
  }

  async init() {
    this.ctx.middleware(YGOProCtosJoinGame, async (msg, client, next) => {
      if (client.isLocal || client.isInternal) {
        return next();
      }

      const nameBan = client.name
        ? await this.findBanRecord({ name: client.name })
        : null;
      if (nameBan) {
        this.logger.info(
          { name: client.name, ip: client.ip },
          'Blocked banned user from joining',
        );
        return client.die('#{banned_user_login}', ChatColor.RED);
      }

      const ipBan = client.ip
        ? await this.findBanRecord({ ip: client.ip })
        : null;
      if (ipBan) {
        this.logger.info(
          { name: client.name, ip: client.ip },
          'Blocked banned IP from joining',
        );
        return client.die('#{banned_ip_login}', ChatColor.RED);
      }
      return next();
    });
  }

  async banUser(name: string) {
    const targetName = (name || '').trim();
    if (!targetName) {
      return false;
    }

    await this.addBanRecord(targetName, null);

    const pendingIps = new Set<string>();
    const roomManager = this.ctx.get(() => RoomManager);
    const rooms = roomManager.allRooms();
    for (const room of rooms) {
      const players = room.allPlayers;
      for (const player of players) {
        if (!player) {
          continue;
        }
        const hitByName = player.name === targetName;
        const hitByIp = !!(player.ip && pendingIps.has(player.ip));
        if (!hitByName && !hitByIp) {
          continue;
        }

        if (player.ip) {
          pendingIps.add(player.ip);
          await this.addBanRecord(targetName, player.ip);
        }

        await room.sendChat(
          (sightPlayer) =>
            `${this.hidePlayerNameProvider.getHidPlayerName(player, sightPlayer)} #{kicked_by_system}`,
          ChatColor.RED,
        );
        await room.kick(player);
      }
    }

    this.logger.info({ name: targetName }, 'Legacy ban applied');
    return true;
  }

  private async findBanRecord(criteria: { name?: string; ip?: string }) {
    const database = this.ctx.database;
    if (!database) {
      return null;
    }
    const repo = database.getRepository(LegacyBanEntity);
    return repo.findOne({
      where: criteria,
    });
  }

  private async addBanRecord(name: string | null, ip: string | null) {
    const database = this.ctx.database;
    if (!database) {
      return;
    }
    const repo = database.getRepository(LegacyBanEntity);
    const existing = await repo.findOne({
      where: {
        name: name || null,
        ip: ip || null,
      },
      withDeleted: true,
    });
    if (existing) {
      if (existing.deleteTime) {
        await repo.recover(existing);
      }
      return;
    }
    const row = repo.create({
      name: name || null,
      ip: ip || null,
    });
    await repo.save(row);
  }
}
