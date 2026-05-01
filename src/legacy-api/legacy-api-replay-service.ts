import JSZip from 'jszip';
import { Context } from '../app';
import { DuelRecordEntity, DuelRecordPlayer } from '../feats/cloud-replay';
import { LegacyRoomIdService } from './legacy-room-id-service';
import { CloudReplayService } from '../feats';
import { RoomManager } from '../room';

type DuelLogQuery = {
  roomName?: string;
  duelCount?: number;
  playerName?: string;
  playerScore?: number;
};

export class LegacyApiReplayService {
  private logger = this.ctx.createLogger('LegacyApiReplayService');
  private roomIdService = this.ctx.get(() => LegacyRoomIdService);
  private cloudReplayService = this.ctx.get(() => CloudReplayService);
  private roomManager = this.ctx.get(() => RoomManager);

  constructor(private ctx: Context) {
    this.registerRoutes();
  }

  private registerRoutes() {
    const router = this.ctx.router;

    router.get('/api/duellog', async (koaCtx) => {
      const ok = await this.ctx.legacyApiAuth.auth(
        String(koaCtx.query.username || ''),
        String(koaCtx.query.pass || koaCtx.query.password || ''),
        'duel_log',
        'duel_log',
      );
      if (!ok) {
        koaCtx.body = [{ name: '密码错误' }];
        return;
      }

      const repo = this.getReplayRepo();
      if (!repo) {
        koaCtx.body = [];
        return;
      }

      const query = this.parseQuery(koaCtx.query as Record<string, unknown>);
      const replays = await this.buildReplayQuery(query).getMany();
      const activeRoomIdentifiers = this.getActiveRoomIdentifierSet();
      koaCtx.body = replays.map((replay) =>
        this.toDuelLogViewJson(replay, activeRoomIdentifiers),
      );
    });

    router.get('/api/archive.zip', async (koaCtx) => {
      const ok = await this.ctx.legacyApiAuth.auth(
        String(koaCtx.query.username || ''),
        String(koaCtx.query.pass || koaCtx.query.password || ''),
        'download_replay',
        'download_replay_archive',
      );
      if (!ok) {
        koaCtx.status = 403;
        koaCtx.body = 'Invalid password.';
        return;
      }

      const repo = this.getReplayRepo();
      if (!repo) {
        koaCtx.status = 404;
        koaCtx.body = 'Replay not found.';
        return;
      }

      const query = this.parseQuery(koaCtx.query as Record<string, unknown>);
      const replays = await this.buildReplayQuery(query).getMany();
      if (!replays.length) {
        koaCtx.status = 404;
        koaCtx.body = 'Replay not found.';
        return;
      }

      const zip = new JSZip();
      for (const replay of replays) {
        const payload = this.cloudReplayService.buildReplayYrpPayload(replay);
        zip.file(`${replay.id}.yrp`, payload);
      }

      koaCtx.state.disableJsonp = true;
      koaCtx.set('Content-Type', 'application/octet-stream');
      koaCtx.set('Content-Disposition', 'attachment; filename="archive.zip"');
      koaCtx.body = zip.generateNodeStream({
        compression: 'DEFLATE',
        compressionOptions: { level: 9 },
      });
    });

    router.get('/api/clearlog', async (koaCtx) => {
      const ok = await this.ctx.legacyApiAuth.auth(
        String(koaCtx.query.username || ''),
        String(koaCtx.query.pass || koaCtx.query.password || ''),
        'clear_duel_log',
        'clear_duel_log',
      );
      if (!ok) {
        koaCtx.body = [{ name: '密码错误' }];
        return;
      }

      const repo = this.getReplayRepo();
      if (!repo) {
        koaCtx.body = [{ name: 'Success' }];
        return;
      }

      const query = this.parseQuery(koaCtx.query as Record<string, unknown>);
      const ids = (
        await this.buildReplayQuery(query)
          .select('replay.id', 'id')
          .getRawMany<{ id: string }>()
      )
        .map((row) => Number(row.id))
        .filter((id) => Number.isFinite(id));

      if (!ids.length) {
        koaCtx.body = [{ name: 'Success' }];
        return;
      }

      await repo.softDelete(ids);
      koaCtx.body = [{ name: 'Success' }];
    });

    router.get('/api/replay/:filename', async (koaCtx) => {
      const ok = await this.ctx.legacyApiAuth.auth(
        String(koaCtx.query.username || ''),
        String(koaCtx.query.pass || koaCtx.query.password || ''),
        'download_replay',
        'download_replay',
      );
      if (!ok) {
        koaCtx.status = 403;
        koaCtx.body = '密码错误';
        return;
      }

      const filename = String(koaCtx.params.filename || '');
      const matched = filename.match(/^(\d+)\.yrp$/);
      if (!matched) {
        koaCtx.status = 404;
        koaCtx.body = `未找到文件 ${filename}`;
        return;
      }

      const replayId = Number(matched[1]);
      const payload = await this.cloudReplayService.getReplayYrpPayloadById(
        replayId,
        { includeDueling: true },
      );
      if (!payload) {
        koaCtx.status = 404;
        koaCtx.body = `未找到文件 ${filename}`;
        return;
      }

      koaCtx.state.disableJsonp = true;
      koaCtx.set('Content-Type', 'application/octet-stream');
      koaCtx.set(
        'Content-Disposition',
        `attachment; filename="${replayId}.yrp"`,
      );
      koaCtx.body = Buffer.from(payload);
    });
  }

  private parseQuery(query: Record<string, unknown>): DuelLogQuery {
    const roomName = String(query.roomname || '').trim();
    const playerName = String(query.playername || '').trim();
    const duelCount = this.parseOptionalNumber(query.duelcount);
    const playerScore = this.parseOptionalNumber(query.score);
    return {
      roomName: roomName || undefined,
      duelCount,
      playerName: playerName || undefined,
      playerScore,
    };
  }

  private parseOptionalNumber(value: unknown) {
    const text = String(value ?? '').trim();
    if (!text.length) {
      return undefined;
    }
    const parsed = Number(text);
    if (!Number.isFinite(parsed)) {
      return undefined;
    }
    return parsed;
  }

  private toDuelLogViewJson(
    replay: DuelRecordEntity,
    activeRoomIdentifiers = this.getActiveRoomIdentifierSet(),
  ) {
    const mode = replay.hostInfo?.mode || 0;
    const players = [...replay.players].sort((a, b) => a.pos - b.pos);
    const isDueling = activeRoomIdentifiers.has(replay.roomIdentifier);
    return {
      id: replay.id,
      time: this.formatDate(replay.endTime),
      originalName: replay.name,
      name: `${replay.name} (Duel:${replay.duelCount})`,
      roomid: this.roomIdService.getRoomIdString(replay.roomIdentifier),
      cloud_replay_id: isDueling ? '' : `R#${replay.id}`,
      replay_filename: `${replay.id}.yrp`,
      roommode: mode,
      players: players.map((player) => ({
        pos: player.pos,
        is_first: player.isFirst,
        originalName: player.name,
        name: player.name + ` (Score: ${player.score})`,
        winner: player.winner,
        score: player.score,
      })),
    };
  }

  private getActiveRoomIdentifierSet() {
    return new Set(this.roomManager.allRooms().map((room) => room.identifier));
  }

  private formatDate(date: Date) {
    const normalized = new Date(date);
    const year = normalized.getFullYear();
    const month = `${normalized.getMonth() + 1}`.padStart(2, '0');
    const day = `${normalized.getDate()}`.padStart(2, '0');
    const hour = `${normalized.getHours()}`.padStart(2, '0');
    const minute = `${normalized.getMinutes()}`.padStart(2, '0');
    const second = `${normalized.getSeconds()}`.padStart(2, '0');
    return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
  }

  private getReplayRepo() {
    const database = this.ctx.database;
    if (!database) {
      return undefined;
    }
    return database.getRepository(DuelRecordEntity);
  }

  private buildReplayQuery(query: DuelLogQuery) {
    const repo = this.getReplayRepo();
    if (!repo) {
      throw new Error('Database disabled');
    }

    const qb = repo
      .createQueryBuilder('replay')
      .leftJoinAndSelect('replay.players', 'player');

    if (query.roomName) {
      qb.andWhere(`replay.name LIKE :roomName || '%'`, {
        roomName: query.roomName,
      });
    }
    if (query.duelCount != null && !Number.isNaN(query.duelCount)) {
      qb.andWhere('replay.duelCount = :duelCount', {
        duelCount: query.duelCount,
      });
    }

    if (query.playerName || query.playerScore != null) {
      const subQb = qb
        .subQuery()
        .select('splayer.id')
        .from(DuelRecordPlayer, 'splayer')
        .where('splayer.duelRecordId = replay.id');

      if (query.playerName) {
        subQb.andWhere(`splayer.realName LIKE :playerName || '%'`);
      }
      if (query.playerScore != null && !Number.isNaN(query.playerScore)) {
        subQb.andWhere('splayer.score = :playerScore');
      }

      const params: Record<string, unknown> = {};
      if (query.playerName) {
        params.playerName = query.playerName;
      }
      if (query.playerScore != null && !Number.isNaN(query.playerScore)) {
        params.playerScore = query.playerScore;
      }
      qb.andWhere(`exists ${subQb.getQuery()}`, params);
    }

    qb.orderBy('replay.id', 'DESC');
    return qb;
  }
}
