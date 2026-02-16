import cryptoRandomString from 'crypto-random-string';
import YGOProDeck from 'ygopro-deck-encode';
import {
  ChatColor,
  HostInfo,
  NetPlayerType,
  YGOProMsgResponseBase,
  YGOProMsgWin,
  YGOProStocDuelEnd,
  YGOProStocDuelStart,
  YGOProStocGameMsg,
  YGOProStocHsPlayerEnter,
  YGOProStocJoinGame,
  YGOProStocReplay,
} from 'ygopro-msg-encode';
import { Context } from '../../app';
import { Client } from '../../client';
import { DuelRecord, OnRoomCreate, OnRoomWin, Room } from '../../room';
import { ClientKeyProvider } from '../client-key-provider';
import { MenuEntry, MenuManager } from '../menu-manager';
import { DuelRecordEntity } from './duel-record.entity';
import { DuelRecordPlayer } from './duel-record-player.entity';
import {
  decodeDeckBase64,
  decodeMessagesBase64,
  decodeResponsesBase64,
  decodeSeedBase64,
  encodeCurrentDeckBase64,
  encodeDeckBase64,
  encodeIngameDeckBase64,
  encodeMessagesBase64,
  encodeResponsesBase64,
  encodeSeedBase64,
  resolveCurrentDeckMainc,
  resolveIngameDeckMainc,
  resolveIngamePosBySeat,
  resolveIsFirstPlayer,
  resolvePlayerScore,
  resolveStartDeckMainc,
} from './utility';

type ReplayPage = {
  entries: DuelRecordEntity[];
  hasNext: boolean;
  nextCursor?: number;
};

declare module '../../room' {
  interface Room {
    identifier?: string;
  }
}

declare module '../../client' {
  interface Client {
    cloudReplayPageCursors?: Array<number | null>;
    cloudReplayPageIndex?: number;
    cloudReplaySelectedReplayId?: number;
  }
}

export class CloudReplayService {
  private logger = this.ctx.createLogger(this.constructor.name);
  private clientKeyProvider = this.ctx.get(() => ClientKeyProvider);
  private menuManager = this.ctx.get(() => MenuManager);

  constructor(private ctx: Context) {
    this.ctx.middleware(OnRoomCreate, async (event, _client, next) => {
      event.room.identifier = this.createRoomIdentifier();
      return next();
    });

    this.ctx.middleware(OnRoomWin, async (event, _client, next) => {
      await this.saveDuelRecord(event);
      return next();
    });
  }

  async tryHandleJoinPass(pass: string, client: Client) {
    const normalized = (pass || '').trim().toUpperCase();
    if (!normalized || !['R', 'W'].includes(normalized)) {
      return false;
    }

    if (!this.ctx.database) {
      await client.die('#{cloud_replay_no}', ChatColor.RED);
      return true;
    }

    if (normalized === 'W') {
      await this.playRandomReplay(client);
      return true;
    }

    await this.openReplayListMenu(client);
    return true;
  }

  private createRoomIdentifier() {
    return cryptoRandomString({
      length: 64,
      type: 'alphanumeric',
    });
  }

  private async saveDuelRecord(event: OnRoomWin) {
    const database = this.ctx.database;
    if (!database) {
      return;
    }

    const room = event.room;
    const duelRecord = room.lastDuelRecord;
    if (!duelRecord) {
      return;
    }

    const duelRecordRepo = database.getRepository(DuelRecordEntity);

    try {
      const now = new Date();
      const record = duelRecordRepo.create({
        startTime: duelRecord.date,
        endTime: now,
        name: room.name,
        roomIdentifier: this.getRoomIdentifier(room),
        hostInfo: room.hostinfo,
        duelCount: room.duelRecords.length,
        winReason: event.winMsg.type,
        messages: encodeMessagesBase64(duelRecord.messages),
        responses: encodeResponsesBase64(duelRecord.responses),
        seed: encodeSeedBase64(duelRecord.seed),
        players: room.playingPlayers.map((client) =>
          this.buildPlayerRecord(
            room,
            client,
            event.winMsg.player,
            event.wasSwapped,
          ),
        ),
      });

      await duelRecordRepo.save(record);
    } catch (error) {
      this.logger.warn(
        {
          roomName: room.name,
          error: (error as Error).toString(),
        },
        'Failed saving duel record',
      );
    }
  }

  private buildPlayerRecord(
    room: Room,
    client: Client,
    winPlayer: number,
    wasSwapped: boolean,
  ) {
    const player = new DuelRecordPlayer();
    player.name = client.name;
    player.pos = client.pos;
    player.realName = client.name_vpass || client.name;
    player.ip = client.ip || '';
    player.clientKey = this.clientKeyProvider.getClientKey(client);
    player.isFirst = resolveIsFirstPlayer(room, client, wasSwapped);
    player.score = resolvePlayerScore(room, client);
    player.startDeckBuffer = encodeDeckBase64(client.startDeck);
    player.startDeckMainc = resolveStartDeckMainc(client);
    player.currentDeckBuffer = encodeCurrentDeckBase64(room, client, wasSwapped);
    player.currentDeckMainc = resolveCurrentDeckMainc(room, client, wasSwapped);
    player.ingameDeckBuffer = encodeIngameDeckBase64(room, client, wasSwapped);
    player.ingameDeckMainc = resolveIngameDeckMainc(room, client, wasSwapped);
    player.winner = room.getDuelPos(client) === winPlayer;
    return player;
  }

  private getRoomIdentifier(room: Room) {
    if (!room.identifier) {
      room.identifier = this.createRoomIdentifier();
    }
    return room.identifier;
  }

  private async playRandomReplay(client: Client) {
    const replay = await this.getRandomReplay();
    if (!replay) {
      await client.die('#{cloud_replay_no}', ChatColor.RED);
      return;
    }
    await this.playReplayStream(client, replay, true);
  }

  private async openReplayListMenu(client: Client) {
    await client.sendChat('#{cloud_replay_hint}', ChatColor.BABYBLUE);
    client.cloudReplayPageCursors = [null];
    client.cloudReplayPageIndex = 0;
    client.cloudReplaySelectedReplayId = undefined;
    await this.renderReplayListMenu(client);
  }

  private async renderReplayListMenu(client: Client) {
    const page = await this.getReplayPage(client);
    if (!page.entries.length) {
      await client.die('#{cloud_replay_no}', ChatColor.RED);
      return;
    }

    const menu: MenuEntry[] = [];
    if (!this.isFirstReplayPage(client)) {
      menu.push({
        title: '#{menu_prev_page}',
        callback: async (currentClient) => {
          this.goToPrevReplayPage(currentClient);
          await this.renderReplayListMenu(currentClient);
        },
      });
    }

    for (const replay of page.entries) {
      menu.push({
        title: this.formatDate(replay.endTime),
        callback: async (currentClient) => {
          currentClient.cloudReplaySelectedReplayId = replay.id;
          await this.renderReplayDetailMenu(currentClient, replay.id);
        },
      });
    }

    if (page.hasNext && page.nextCursor != null) {
      menu.push({
        title: '#{menu_next_page}',
        callback: async (currentClient) => {
          this.goToNextReplayPage(currentClient, page.nextCursor!);
          await this.renderReplayListMenu(currentClient);
        },
      });
    }

    await this.menuManager.launchMenu(client, menu);
  }

  private async renderReplayDetailMenu(client: Client, replayId: number) {
    const replay = await this.findOwnedReplayById(client, replayId);
    if (!replay) {
      await client.sendChat('#{cloud_replay_no}', ChatColor.RED);
      await this.renderReplayListMenu(client);
      return;
    }

    await this.sendReplayDetail(client, replay);

    const menu: MenuEntry[] = [
      {
        title: '#{cloud_replay_menu_play}',
        callback: async (currentClient) => {
          const selectedReplay = await this.findOwnedReplayById(
            currentClient,
            replayId,
          );
          if (!selectedReplay) {
            await currentClient.die('#{cloud_replay_no}', ChatColor.RED);
            return;
          }
          await this.playReplayStream(currentClient, selectedReplay, false);
        },
      },
      {
        title: '#{cloud_replay_menu_download_yrp}',
        callback: async (currentClient) => {
          const selectedReplay = await this.findOwnedReplayById(
            currentClient,
            replayId,
          );
          if (!selectedReplay) {
            await currentClient.die('#{cloud_replay_no}', ChatColor.RED);
            return;
          }
          await this.downloadReplayYrp(currentClient, selectedReplay);
        },
      },
      {
        title: '#{cloud_replay_menu_back}',
        callback: async (currentClient) => {
          await this.renderReplayListMenu(currentClient);
        },
      },
    ];

    await this.menuManager.launchMenu(client, menu);
  }

  private async sendReplayDetail(client: Client, replay: DuelRecordEntity) {
    const dateText = this.formatDate(replay.endTime);
    const versus = this.formatReplayVersus(replay);
    const score = this.formatReplayScore(replay);
    const winners = this.formatReplayWinners(replay);

    await client.sendChat(`#{cloud_replay_detail_time}${dateText}`, ChatColor.BABYBLUE);
    await client.sendChat(`#{cloud_replay_detail_players}${versus}`, ChatColor.BABYBLUE);
    await client.sendChat(`#{cloud_replay_detail_score}${score}`, ChatColor.BABYBLUE);
    await client.sendChat(`#{cloud_replay_detail_winner}${winners}`, ChatColor.BABYBLUE);
  }

  private async playReplayStream(
    client: Client,
    replay: DuelRecordEntity,
    withYrp: boolean,
  ) {
    try {
      await client.sendChat(
        `#{cloud_replay_playing} R#${replay.id}`,
        ChatColor.BABYBLUE,
      );
      await client.send(this.createJoinGamePacket(replay));
      await this.sendReplayPlayers(client, replay);
      await client.send(new YGOProStocDuelStart());

      const gameMessages = this.resolveReplayVisibleMessages(replay.messages);
      for (const msg of gameMessages) {
        await client.send(msg);
      }
      await this.sendReplayWinMsg(client, replay);

      if (withYrp) {
        await client.send(this.createReplayPacket(replay));
      }

      await client.send(new YGOProStocDuelEnd());
      client.disconnect();
    } catch (error) {
      this.logger.warn(
        {
          replayId: replay.id,
          clientName: client.name,
          error: (error as Error).toString(),
        },
        'Failed to play cloud replay',
      );
      await client.die('#{cloud_replay_error}', ChatColor.RED);
    }
  }

  private resolveReplayVisibleMessages(messagesBase64: string) {
    return decodeMessagesBase64(messagesBase64).filter((packet) => {
      const msg = packet.msg;
      if (!msg) {
        return false;
      }
      if (msg instanceof YGOProMsgResponseBase) {
        return false;
      }
      if (msg instanceof YGOProMsgWin) {
        return false;
      }
      return msg.getSendTargets().includes(NetPlayerType.OBSERVER);
    });
  }

  private async sendReplayWinMsg(client: Client, replay: DuelRecordEntity) {
    const player = this.resolveReplayWinPlayer(replay);
    if (player == null) {
      return;
    }
    await client.send(
      new YGOProStocGameMsg().fromPartial({
        msg: new YGOProMsgWin().fromPartial({
          player,
          type: replay.winReason,
        }),
      }),
    );
  }

  private resolveReplayWinPlayer(replay: DuelRecordEntity) {
    const winnerPlayer = replay.players.find((player) => player.winner);
    if (!winnerPlayer) {
      return undefined;
    }

    const winnerDuelPos = this.resolveDuelPosBySeat(
      winnerPlayer.pos,
      replay.hostInfo,
    );
    const swapped = this.resolveReplaySwappedByIsFirst(replay);
    return swapped ? 1 - winnerDuelPos : winnerDuelPos;
  }

  private resolveDuelPosBySeat(pos: number, hostInfo: HostInfo) {
    const teamOffsetBit = this.isTagMode(hostInfo) ? 1 : 0;
    return (pos & (0x1 << teamOffsetBit)) >>> teamOffsetBit;
  }

  private resolveReplaySwappedByIsFirst(replay: DuelRecordEntity) {
    const pos0Player = replay.players.find((player) => player.pos === 0);
    return !pos0Player?.isFirst;
  }

  private async downloadReplayYrp(client: Client, replay: DuelRecordEntity) {
    try {
      await client.send(new YGOProStocDuelStart());
      await client.send(this.createReplayPacket(replay));
      await client.send(new YGOProStocDuelEnd());
      client.disconnect();
    } catch (error) {
      this.logger.warn(
        {
          replayId: replay.id,
          clientName: client.name,
          error: (error as Error).toString(),
        },
        'Failed to download cloud replay yrp',
      );
      await client.die('#{cloud_replay_error}', ChatColor.RED);
    }
  }

  private async sendReplayPlayers(client: Client, replay: DuelRecordEntity) {
    const seatCount = this.resolveSeatCount(replay.hostInfo);
    const sortedPlayers = [...replay.players].sort((a, b) => a.pos - b.pos);
    for (let pos = 0; pos < seatCount; pos += 1) {
      const player = sortedPlayers.find((entry) => entry.pos === pos);
      await client.send(
        new YGOProStocHsPlayerEnter().fromPartial({
          pos,
          name: player?.name || '',
        }),
      );
    }
  }

  private createJoinGamePacket(replay: DuelRecordEntity) {
    return new YGOProStocJoinGame().fromPartial({
      info: this.normalizeHostInfoForClient(replay.hostInfo),
    });
  }

  private normalizeHostInfoForClient(hostInfo: HostInfo) {
    return {
      ...hostInfo,
      mode:
        hostInfo.mode > 2
          ? this.isTagMode(hostInfo)
            ? 2
            : 1
          : hostInfo.mode,
    };
  }

  private createReplayPacket(replay: DuelRecordEntity) {
    const duelRecord = this.restoreDuelRecord(replay);
    return new YGOProStocReplay().fromPartial({
      replay: duelRecord.toYrp({
        hostinfo: replay.hostInfo as any,
        isTag: this.isTagMode(replay.hostInfo),
      }),
    });
  }

  private restoreDuelRecord(replay: DuelRecordEntity) {
    const isTag = this.isTagMode(replay.hostInfo);
    const wasSwapped = this.resolveReplaySwappedByIsFirst(replay);
    const seatCount = this.resolveSeatCount(replay.hostInfo);
    const players = Array.from({ length: seatCount }, () => ({
      name: '',
      deck: new YGOProDeck(),
    }));
    const sortedPlayers = [...replay.players].sort((a, b) => a.pos - b.pos);

    for (const player of sortedPlayers) {
      const deckBuffer = player.ingameDeckBuffer || player.currentDeckBuffer;
      const mainc = player.ingameDeckMainc ?? player.currentDeckMainc ?? 0;
      const ingamePos = resolveIngamePosBySeat(
        player.pos,
        isTag,
        wasSwapped,
      );
      players[ingamePos] = {
        name: player.name,
        deck: decodeDeckBase64(deckBuffer, mainc),
      };
    }

    const duelRecord = new DuelRecord(decodeSeedBase64(replay.seed), players);
    duelRecord.responses = decodeResponsesBase64(replay.responses);
    return duelRecord;
  }

  private async getReplayPage(client: Client): Promise<ReplayPage> {
    const cursor = this.getReplayCursor(client);
    const firstPage = this.isFirstReplayPage(client);
    const take = firstPage ? 5 : 4;
    const entries = await this.getOwnedReplays(client, cursor, take);

    if (firstPage) {
      if (entries.length <= 4) {
        return {
          entries,
          hasNext: false,
        };
      }
      return {
        entries: entries.slice(0, 3),
        hasNext: true,
        nextCursor: entries[2].id,
      };
    }

    if (entries.length <= 3) {
      return {
        entries,
        hasNext: false,
      };
    }

    return {
      entries: entries.slice(0, 2),
      hasNext: true,
      nextCursor: entries[1].id,
    };
  }

  private async getOwnedReplays(
    client: Client,
    cursor: number | null,
    take: number,
  ) {
    const database = this.ctx.database;
    if (!database) {
      return [];
    }

    const clientKey = this.clientKeyProvider.getClientKey(client);
    const repo = database.getRepository(DuelRecordEntity);
    const qb = repo
      .createQueryBuilder('replay')
      .leftJoinAndSelect('replay.players', 'player');

    const subQuery = qb
      .subQuery()
      .select('1')
      .from(DuelRecordPlayer, 'owned_player')
      .where('owned_player.duelRecordId = replay.id')
      .andWhere('owned_player.clientKey = :clientKey')
      .getQuery();

    qb.where(`EXISTS ${subQuery}`, { clientKey });
    if (cursor != null) {
      qb.andWhere('replay.id < :cursor', { cursor });
    }

    return qb.orderBy('replay.id', 'DESC').take(take).getMany();
  }

  private async findOwnedReplayById(client: Client, replayId: number) {
    const replay = await this.findReplayById(replayId);
    if (!replay) {
      return undefined;
    }
    const clientKey = this.clientKeyProvider.getClientKey(client);
    const hasOwnedPlayer = replay.players.some(
      (player) => player.clientKey === clientKey,
    );
    return hasOwnedPlayer ? replay : undefined;
  }

  private async findReplayById(replayId: number) {
    const database = this.ctx.database;
    if (!database) {
      return undefined;
    }
    return database.getRepository(DuelRecordEntity).findOne({
      where: {
        id: replayId,
      },
      relations: ['players'],
    });
  }

  private async getRandomReplay() {
    const database = this.ctx.database;
    if (!database) {
      return undefined;
    }

    const repo = database.getRepository(DuelRecordEntity);
    const minMax = await repo
      .createQueryBuilder('replay')
      .select('MIN(replay.id)', 'minId')
      .addSelect('MAX(replay.id)', 'maxId')
      .getRawOne<{ minId?: string; maxId?: string }>();

    const minId = Number(minMax?.minId);
    const maxId = Number(minMax?.maxId);
    if (!Number.isFinite(minId) || !Number.isFinite(maxId) || minId > maxId) {
      return undefined;
    }

    const targetId = Math.floor(Math.random() * (maxId - minId + 1)) + minId;
    let replay = await repo
      .createQueryBuilder('replay')
      .leftJoinAndSelect('replay.players', 'player')
      .where('replay.id >= :targetId', { targetId })
      .orderBy('replay.id', 'ASC')
      .getOne();

    if (!replay) {
      replay = await repo
        .createQueryBuilder('replay')
        .leftJoinAndSelect('replay.players', 'player')
        .where('replay.id <= :targetId', { targetId })
        .orderBy('replay.id', 'DESC')
        .getOne();
    }
    return replay || undefined;
  }

  private getReplayCursor(client: Client) {
    const cursors = client.cloudReplayPageCursors || [null];
    const pageIndex = client.cloudReplayPageIndex || 0;
    return cursors[pageIndex] ?? null;
  }

  private isFirstReplayPage(client: Client) {
    return (client.cloudReplayPageIndex || 0) === 0;
  }

  private goToNextReplayPage(client: Client, cursor: number) {
    const pageIndex = client.cloudReplayPageIndex || 0;
    const cursors = (client.cloudReplayPageCursors || [null]).slice(
      0,
      pageIndex + 1,
    );
    cursors.push(cursor);
    client.cloudReplayPageCursors = cursors;
    client.cloudReplayPageIndex = pageIndex + 1;
  }

  private goToPrevReplayPage(client: Client) {
    const pageIndex = client.cloudReplayPageIndex || 0;
    if (pageIndex <= 0) {
      return;
    }
    client.cloudReplayPageIndex = pageIndex - 1;
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

  private formatReplayVersus(replay: DuelRecordEntity) {
    const [team0, team1] = this.resolveReplayTeams(replay);
    return `${team0.join('+')} VS ${team1.join('+')}`;
  }

  private formatReplayScore(replay: DuelRecordEntity) {
    const [team0, team1] = this.resolveReplayTeamPlayers(replay);
    const score0 = team0[0]?.score || 0;
    const score1 = team1[0]?.score || 0;
    return `${score0}-${score1}`;
  }

  private formatReplayWinners(replay: DuelRecordEntity) {
    const [team0, team1] = this.resolveReplayTeamPlayers(replay);
    const team0Won = team0.some((player) => player.winner);
    const team1Won = team1.some((player) => player.winner);
    if (team0Won === team1Won) {
      return '-';
    }
    const winners = (team0Won ? team0 : team1).map((player) => player.name);
    return winners.join('+');
  }

  private resolveReplayTeams(replay: DuelRecordEntity) {
    const [team0, team1] = this.resolveReplayTeamPlayers(replay);
    const left = team0.map((player) => player.name);
    const right = team1.map((player) => player.name);
    return [left, right] as const;
  }

  private resolveReplayTeamPlayers(replay: DuelRecordEntity) {
    const sortedPlayers = [...replay.players].sort((a, b) => a.pos - b.pos);
    const isTag = this.isTagMode(replay.hostInfo);
    const teamOffsetBit = isTag ? 1 : 0;

    const team0 = sortedPlayers.filter(
      (player) => ((player.pos & (0x1 << teamOffsetBit)) >> teamOffsetBit) === 0,
    );
    const team1 = sortedPlayers.filter(
      (player) => ((player.pos & (0x1 << teamOffsetBit)) >> teamOffsetBit) === 1,
    );
    return [team0, team1] as const;
  }

  private isTagMode(hostInfo: HostInfo) {
    return (hostInfo.mode & 0x2) !== 0;
  }

  private resolveSeatCount(hostInfo: HostInfo) {
    return this.isTagMode(hostInfo) ? 4 : 2;
  }
}
