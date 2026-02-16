import cryptoRandomString from 'crypto-random-string';
import { Context } from '../../app';
import { ClientKeyProvider } from '../client-key-provider';
import { OnRoomCreate, OnRoomWin, Room } from '../../room';
import { DuelRecordEntity } from './duel-record.entity';
import { DuelRecordPlayer } from './duel-record-player.entity';
import { Client } from '../../client';
import {
  encodeCurrentDeckBase64,
  encodeDeckBase64,
  encodeMessagesBase64,
  encodeResponsesBase64,
  encodeSeedBase64,
  resolveCurrentDeckMainc,
  resolvePlayerScore,
  resolveStartDeckMainc,
} from './utility';

declare module '../../room' {
  interface Room {
    identifier?: string;
  }
}

export class CloudReplayService {
  private logger = this.ctx.createLogger(this.constructor.name);
  private clientKeyProvider = this.ctx.get(() => ClientKeyProvider);

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
          this.buildPlayerRecord(room, client, event.winMsg.player),
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

  private buildPlayerRecord(room: Room, client: Client, winPlayer: number) {
    const player = new DuelRecordPlayer();
    player.name = client.name;
    player.pos = client.pos;
    player.realName = client.name_vpass || client.name;
    player.ip = client.ip || '';
    player.clientKey = this.clientKeyProvider.getClientKey(client);
    player.isFirst = room.getIngameDuelPos(client) === 0;
    player.score = resolvePlayerScore(room, client);
    player.startDeckBuffer = encodeDeckBase64(client.startDeck);
    player.startDeckMainc = resolveStartDeckMainc(client);
    player.currentDeckBuffer = encodeCurrentDeckBase64(room, client);
    player.currentDeckMainc = resolveCurrentDeckMainc(room, client);
    player.winner = room.getIngameDuelPos(client) === winPlayer;
    return player;
  }

  private getRoomIdentifier(room: Room) {
    if (!room.identifier) {
      room.identifier = this.createRoomIdentifier();
    }
    return room.identifier;
  }
}
