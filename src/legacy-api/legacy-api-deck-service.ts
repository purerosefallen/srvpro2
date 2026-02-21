import { Context } from '../app';
import { LegacyDeckEntity } from './legacy-deck.entity';
import { decodeDeckBase64, encodeDeckBase64 } from '../feats/cloud-replay';
import YGOProDeck from 'ygopro-deck-encode';
import { LockDeckExpectedDeckCheck } from '../feats/lock-deck';
import { ChallongeParticipantUpload, ChallongeService } from '../feats';
import { deckNameMatch } from './utility/deck-name-match';
import {
  getDeckNameExactCandidates,
  getDeckNameRegexCandidates,
} from './utility/deck-name-query';
import * as fs from 'node:fs/promises';
import { IncomingForm, Files } from 'formidable';
import { ServerResponse } from 'node:http';

type DeckApiResult = {
  file: string;
  status: string;
};

type DeckDashboardBg = {
  url: string;
  desc: string;
};

const DASHBOARD_STREAM_TIMEOUT_MS = 10 * 60 * 1000;
const DASHBOARD_BG_REFRESH_INTERVAL_MS = 10 * 60 * 1000;

type DeckDashboardStreamConnection = {
  response: ServerResponse;
  timeout: ReturnType<typeof setTimeout>;
};

export class LegacyApiDeckService {
  private logger = this.ctx.createLogger('LegacyApiDeckService');
  private challongeService = this.ctx.get(() => ChallongeService);
  private streamConnections = new Map<string, DeckDashboardStreamConnection>();
  private backgrounds: DeckDashboardBg[] = [{ url: '', desc: '' }];
  private bgRefreshedAt = 0;
  private bgLoading?: Promise<void>;

  constructor(private ctx: Context) {
    this.registerRoutes();
    void this.ensureBackgroundsFresh();
  }

  async init() {
    this.registerLockDeckCheck();
  }

  private registerRoutes() {
    const router = this.ctx.router;

    router.get('/api/msg', async (koaCtx) => {
      const ok = await this.ctx.legacyApiAuth.auth(
        String(koaCtx.query.username || ''),
        String(koaCtx.query.password || koaCtx.query.pass || ''),
        'deck_dashboard_read',
        'login_deck_dashboard',
      );
      if (!ok) {
        koaCtx.status = 403;
        koaCtx.body = 'Auth Failed.';
        return;
      }

      koaCtx.state.disableJsonp = true;
      koaCtx.respond = false;
      const response = koaCtx.res;
      const connectionIp = this.getConnectionIp(koaCtx);
      response.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      this.addStreamConnection(connectionIp, response);
      const cleanup = () => {
        this.removeStreamConnection(connectionIp, response);
      };
      koaCtx.req.on('close', cleanup);
      koaCtx.req.on('aborted', cleanup);
      response.on('close', cleanup);
      response.on('error', cleanup);

      this.sendDeckDashboardMessage('已连接。', connectionIp);
    });

    router.get('/api/get_decks', async (koaCtx) => {
      const ok = await this.ctx.legacyApiAuth.auth(
        String(koaCtx.query.username || ''),
        String(koaCtx.query.password || ''),
        'deck_dashboard_read',
        'get_decks',
      );
      if (!ok) {
        koaCtx.status = 403;
        koaCtx.body = 'Auth Failed.';
        return;
      }

      const repo = this.getDeckRepo();
      if (!repo) {
        koaCtx.body = [];
        return;
      }
      const rows = await repo.find({
        order: {
          uploadTime: 'DESC',
          id: 'DESC',
        },
      });
      koaCtx.body = rows.map((row) => {
        const deck = decodeDeckBase64(row.payload, row.mainc);
        deck.name = row.name;
        return deck;
      });
    });

    router.get('/api/get_bg', async (koaCtx) => {
      const ok = await this.ctx.legacyApiAuth.auth(
        String(koaCtx.query.username || ''),
        String(koaCtx.query.password || koaCtx.query.pass || ''),
        'deck_dashboard_read',
        'login_deck_dashboard',
      );
      if (!ok) {
        koaCtx.status = 403;
        koaCtx.body = 'Auth Failed.';
        return;
      }

      await this.ensureBackgroundsFresh();
      koaCtx.body = this.pickRandomBackground();
    });

    router.get('/api/del_deck', async (koaCtx) => {
      const ok = await this.ctx.legacyApiAuth.auth(
        String(koaCtx.query.username || ''),
        String(koaCtx.query.password || ''),
        'deck_dashboard_write',
        'delete_deck',
      );
      if (!ok) {
        koaCtx.status = 403;
        koaCtx.body = 'Auth Failed.';
        return;
      }
      const repo = this.getDeckRepo();
      if (!repo) {
        koaCtx.body = '数据库未开启。';
        return;
      }
      const deckName = String(koaCtx.query.msg || '').trim();
      try {
        await repo.softDelete({
          name: deckName,
        });
        const text = `删除卡组 ${deckName}成功。`;
        koaCtx.body = text;
      } catch (e: any) {
        const text = `删除卡组 ${deckName}失败: ${e.toString()}`;
        koaCtx.body = text;
      }
    });

    router.get('/api/clear_decks', async (koaCtx) => {
      const ok = await this.ctx.legacyApiAuth.auth(
        String(koaCtx.query.username || ''),
        String(koaCtx.query.password || ''),
        'deck_dashboard_write',
        'clear_decks',
      );
      if (!ok) {
        koaCtx.status = 403;
        koaCtx.body = 'Auth Failed.';
        return;
      }
      const repo = this.getDeckRepo();
      if (!repo) {
        koaCtx.body = '数据库未开启。';
        return;
      }
      try {
        await repo.createQueryBuilder().softDelete().where('1 = 1').execute();
        const text = '删除全部卡组成功。';
        koaCtx.body = text;
      } catch (e: any) {
        const text = `删除全部卡组失败。${e.toString()}`;
        koaCtx.body = text;
      }
    });

    router.get('/api/upload_to_challonge', async (koaCtx) => {
      const ok = await this.ctx.legacyApiAuth.auth(
        String(koaCtx.query.username || ''),
        String(koaCtx.query.password || ''),
        'deck_dashboard_write',
        'upload_to_challonge',
      );
      if (!ok) {
        koaCtx.status = 403;
        koaCtx.body = 'Auth Failed.';
        return;
      }
      this.sendDeckDashboardMessage('开始读取玩家列表。');
      const participants = await this.loadChallongeParticipantsFromDecks();
      if (!participants.length) {
        this.sendDeckDashboardMessage('玩家列表为空。');
        koaCtx.body = '操作完成。';
        return;
      }
      this.sendDeckDashboardMessage(
        `读取玩家列表完毕，共有${participants.length}名玩家。`,
      );

      for await (const text of this.challongeService.uploadToChallonge(
        participants,
      )) {
        this.sendDeckDashboardMessage(text);
      }
      koaCtx.body = '操作完成。';
    });

    router.post('/api/upload_decks', async (koaCtx) => {
      const ok = await this.ctx.legacyApiAuth.auth(
        String(koaCtx.query.username || ''),
        String(koaCtx.query.password || ''),
        'deck_dashboard_write',
        'upload_deck',
      );
      if (!ok) {
        koaCtx.status = 403;
        koaCtx.body = 'Auth Failed.';
        return;
      }
      const repo = this.getDeckRepo();
      if (!repo) {
        koaCtx.status = 500;
        const result = [{ file: '(unknown)', status: '数据库未开启' }];
        koaCtx.type = 'text/plain; charset=utf-8';
        koaCtx.body = JSON.stringify(result);
        return;
      }

      try {
        const files = await this.parseUploadFiles(koaCtx.req);
        const result = await this.importDeckFiles(files);
        koaCtx.type = 'text/plain; charset=utf-8';
        koaCtx.body = JSON.stringify(result);
      } catch (e: any) {
        this.logger.warn({ err: e }, 'Deck upload failed');
        koaCtx.status = 500;
        const result = [{ file: '(unknown)', status: e.toString() }];
        koaCtx.type = 'text/plain; charset=utf-8';
        koaCtx.body = JSON.stringify(result);
      }
    });
  }

  private registerLockDeckCheck() {
    this.ctx.middleware(
      LockDeckExpectedDeckCheck,
      async (event, client, next) => {
        const current = await next();
        if (event.expectedDeck !== undefined) {
          return current;
        }
        if (
          !this.ctx.config.getBoolean('TOURNAMENT_MODE') ||
          !this.ctx.config.getBoolean('TOURNAMENT_MODE_CHECK_DECK')
        ) {
          return current;
        }

        const expectedDeck = await this.findExpectedDeckByName(
          event.client.name,
        );
        event.use(expectedDeck);
        return current;
      },
    );
  }

  private async findExpectedDeckByName(playerName: string) {
    const repo = this.getDeckRepo();
    if (!repo) {
      return undefined;
    }

    const anyDeckRow = await repo
      .createQueryBuilder('deck')
      .select('deck.id', 'id')
      .limit(1)
      .getRawOne<{ id: string }>();
    if (!anyDeckRow) {
      return undefined;
    }

    const [exact0, exact1, exact2] = getDeckNameExactCandidates(playerName);
    const { firstPlayerRegex, secondPlayerRegex } =
      getDeckNameRegexCandidates(playerName);
    const rows = await repo
      .createQueryBuilder('deck')
      .where(
        `(
          deck.name = :exact0 OR
          deck.name = :exact1 OR
          deck.name = :exact2 OR
          deck.name ~ :firstPlayerRegex OR
          deck.name ~ :secondPlayerRegex
        )`,
        {
          exact0,
          exact1,
          exact2,
          firstPlayerRegex,
          secondPlayerRegex,
        },
      )
      .orderBy('deck.uploadTime', 'DESC')
      .addOrderBy('deck.id', 'DESC')
      .limit(32)
      .getMany();

    const matched = rows.find((row) => deckNameMatch(row.name, playerName));
    if (!matched) {
      return null;
    }
    const deck = decodeDeckBase64(matched.payload, matched.mainc);
    deck.name = matched.name;
    return deck;
  }

  private getDeckRepo() {
    const database = this.ctx.database;
    if (!database) {
      return undefined;
    }
    return database.getRepository(LegacyDeckEntity);
  }

  private parseUploadFiles(req: any) {
    return new Promise<Files>((resolve, reject) => {
      const form = new IncomingForm();
      form.parse(req, (err, fields, files) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(files);
      });
    });
  }

  private async importDeckFiles(files: Files) {
    const fileList = Object.values(files).flatMap((v: any) =>
      Array.isArray(v) ? v : [v],
    );
    const result: DeckApiResult[] = [];

    for (const item of fileList) {
      const filename = String(item?.originalFilename || '').trim();
      const filepath = String(item?.filepath || '').trim();
      if (!filename || !filepath) {
        result.push({
          file: filename || '(unknown)',
          status: '上传文件信息缺失',
        });
        continue;
      }

      if (!filename.endsWith('.ydk')) {
        result.push({
          file: filename,
          status: '不是卡组文件',
        });
        continue;
      }

      try {
        const text = await fs.readFile(filepath, {
          encoding: 'utf-8',
        });
        const deck = YGOProDeck.fromYdkString(text);
        if ((deck.main || []).length < 40) {
          result.push({
            file: filename,
            status: '卡组不合格',
          });
          continue;
        }
        await this.saveDeck(filename, deck);
        result.push({
          file: filename,
          status: 'OK',
        });
      } catch (e: any) {
        result.push({
          file: filename,
          status: e.toString(),
        });
      }
    }

    return result;
  }

  private async saveDeck(name: string, deck: YGOProDeck) {
    const repo = this.getDeckRepo();
    if (!repo) {
      return;
    }

    const existing = await repo.findOne({
      where: {
        name,
      },
      withDeleted: true,
      order: {
        id: 'DESC',
      },
    });

    if (existing) {
      existing.payload = encodeDeckBase64(deck);
      existing.mainc = deck.main.length;
      existing.uploadTime = new Date();
      await repo.save(existing);
      if (existing.deleteTime) {
        await repo.recover(existing);
      }
      return;
    }

    const row = repo.create({
      name,
      payload: encodeDeckBase64(deck),
      mainc: deck.main.length,
      uploadTime: new Date(),
    });
    await repo.save(row);
  }

  private async loadChallongeParticipantsFromDecks() {
    const repo = this.getDeckRepo();
    if (!repo) {
      return [] as ChallongeParticipantUpload[];
    }

    const rows = await repo.find({
      order: {
        uploadTime: 'DESC',
        id: 'DESC',
      },
    });
    const loaded = new Set<string>();
    const participants: ChallongeParticipantUpload[] = [];
    for (const row of rows) {
      const name = this.toChallongeParticipantName(row.name);
      if (!name || loaded.has(name)) {
        continue;
      }
      try {
        const deck = decodeDeckBase64(row.payload, row.mainc);
        participants.push({
          name,
          deckbuf: Buffer.from(deck.toUpdateDeckPayload()).toString('base64'),
        });
        loaded.add(name);
      } catch (error: unknown) {
        this.logger.warn(
          {
            deckName: row.name,
            err: error,
          },
          'Failed to decode legacy deck for challonge upload',
        );
      }
    }
    return participants;
  }

  private toChallongeParticipantName(deckName: string) {
    if (deckName.endsWith('.ydk')) {
      return deckName.slice(0, -4);
    }
    return deckName;
  }

  private addStreamConnection(ip: string, response: ServerResponse) {
    this.closeStreamConnection(ip, 'replaced_by_same_ip');

    const timeout = setTimeout(() => {
      this.closeStreamConnection(ip, 'timeout', response);
    }, DASHBOARD_STREAM_TIMEOUT_MS);
    this.streamConnections.set(ip, {
      response,
      timeout,
    });
  }

  private removeStreamConnection(
    ip: string,
    expectedResponse?: ServerResponse,
  ) {
    const connection = this.streamConnections.get(ip);
    if (!connection) {
      return;
    }
    if (expectedResponse && connection.response !== expectedResponse) {
      return;
    }
    clearTimeout(connection.timeout);
    this.streamConnections.delete(ip);
  }

  private closeStreamConnection(
    ip: string,
    reason: string,
    expectedResponse?: ServerResponse,
  ) {
    const connection = this.streamConnections.get(ip);
    if (!connection) {
      return;
    }
    if (expectedResponse && connection.response !== expectedResponse) {
      return;
    }
    this.removeStreamConnection(ip, expectedResponse);
    try {
      connection.response.end();
    } catch (error: any) {
      this.logger.debug(
        { err: error, ip, reason },
        'Failed to close deck dashboard stream',
      );
    }
  }

  private resetStreamTimeout(ip: string, expectedResponse?: ServerResponse) {
    const connection = this.streamConnections.get(ip);
    if (!connection) {
      return;
    }
    if (expectedResponse && connection.response !== expectedResponse) {
      return;
    }
    clearTimeout(connection.timeout);
    connection.timeout = setTimeout(() => {
      this.closeStreamConnection(ip, 'timeout', connection.response);
    }, DASHBOARD_STREAM_TIMEOUT_MS);
  }

  private sendDeckDashboardMessage(text: string, targetIp?: string) {
    const payload = String(text || '').replace(/\n/g, '<br>');
    const message = `data: ${payload}\n\n`;
    for (const [ip, connection] of this.streamConnections.entries()) {
      if (targetIp != null && ip !== targetIp) {
        continue;
      }
      try {
        connection.response.write(message);
        this.resetStreamTimeout(ip, connection.response);
      } catch (error: any) {
        this.logger.debug(
          { err: error, ip },
          'Failed to write deck dashboard stream message',
        );
        this.removeStreamConnection(ip, connection.response);
      }
    }
  }

  private getConnectionIp(koaCtx: any) {
    const candidates = [
      koaCtx?.state?.realIp,
      koaCtx?.ip,
      koaCtx?.request?.ip,
      koaCtx?.req?.socket?.remoteAddress,
    ];
    for (const value of candidates) {
      const text = String(value || '').trim();
      if (text) {
        return text;
      }
    }
    return '(unknown)';
  }

  private pickRandomBackground() {
    if (!this.backgrounds.length) {
      return { url: '', desc: '' };
    }
    const index = Math.floor(Math.random() * this.backgrounds.length);
    return this.backgrounds[index];
  }

  private async ensureBackgroundsFresh() {
    const now = Date.now();
    if (
      this.backgrounds.length > 1 &&
      now - this.bgRefreshedAt < DASHBOARD_BG_REFRESH_INTERVAL_MS
    ) {
      return;
    }
    if (this.bgLoading) {
      return this.bgLoading;
    }
    this.bgLoading = this.refreshBackgrounds().finally(() => {
      this.bgLoading = undefined;
    });
    return this.bgLoading;
  }

  private async refreshBackgrounds() {
    try {
      const response = await this.ctx.http.get(
        'http://www.bing.com/HPImageArchive.aspx',
        {
          params: {
            format: 'js',
            idx: 0,
            n: 8,
            mkt: 'zh-CN',
          },
          timeout: 10000,
        },
      );
      const body = response.data as any;
      const images = Array.isArray(body?.images) ? body.images : [];
      if (!images.length) {
        this.logger.warn(
          { body },
          'Deck dashboard background API returned no images',
        );
        return;
      }
      const next = images
        .map((image: any) => {
          const urlbase = String(image?.urlbase || '');
          if (!urlbase) {
            return undefined;
          }
          return {
            url: `http://s.cn.bing.net${urlbase}_768x1366.jpg`,
            desc: String(image?.copyright || ''),
          };
        })
        .filter((item): item is DeckDashboardBg => !!item);
      if (!next.length) {
        this.logger.warn(
          'Deck dashboard background API parse produced no valid result',
        );
        return;
      }
      this.backgrounds = next;
      this.bgRefreshedAt = Date.now();
    } catch (error: any) {
      this.logger.warn(
        { err: error },
        'Failed to refresh deck dashboard backgrounds',
      );
    }
  }
}
