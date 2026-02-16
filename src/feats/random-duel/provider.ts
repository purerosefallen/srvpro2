import { CacheKey } from 'aragami';
import { ChatColor, YGOProCtosChat } from 'ygopro-msg-encode';
import { Context } from '../../app';
import { Client } from '../../client';
import { MAX_ROOM_NAME_LENGTH } from '../../constants/room';
import {
  DuelStage,
  OnRoomFinalize,
  OnRoomJoinPlayer,
  Room,
  RoomManager,
} from '../../room';
import { fillRandomString } from '../../utility/fill-random-string';
import { CanReconnectCheck } from '../reconnect';
import { WaitForPlayerProvider } from '../wait-for-player-provider';
import { RandomDuelScore } from './score.entity';

const RANDOM_DUEL_TTL = 24 * 60 * 60 * 1000;
const BUILTIN_RANDOM_TYPES = [
  'S',
  'M',
  'T',
  'TOR',
  'TR',
  'OOR',
  'OR',
  'TOMR',
  'TMR',
  'OOMR',
  'OMR',
  'CR',
  'CMR',
];

class RandomDuelOpponentCache {
  @CacheKey()
  ip!: string;

  opponentIp = '';
}

declare module '../../room' {
  interface Room {
    randomType?: string;
    randomDuelMaxPlayer?: number;
  }
}

export class RandomDuelProvider {
  private logger = this.ctx.createLogger(this.constructor.name);
  private roomManager = this.ctx.get(() => RoomManager);
  private waitForPlayerProvider = this.ctx.get(() => WaitForPlayerProvider);

  enabled = this.ctx.config.getBoolean('ENABLE_RANDOM_DUEL');
  noRematchCheck = this.ctx.config.getBoolean('RANDOM_DUEL_NO_REMATCH_CHECK');
  disableChat = this.ctx.config.getBoolean('RANDOM_DUEL_DISABLE_CHAT');
  private recordMatchScoresConfigured = this.ctx.config.getBoolean(
    'RANDOM_DUEL_RECORD_MATCH_SCORES',
  );
  private waitForPlayerReadyTimeoutMs =
    Math.max(0, this.ctx.config.getInt('RANDOM_DUEL_READY_TIME') || 0) * 1000;
  private waitForPlayerHangTimeoutMs =
    Math.max(0, this.ctx.config.getInt('RANDOM_DUEL_HANG_TIMEOUT') || 0) * 1000;
  private waitForPlayerLongAgoBackoffMs = Math.max(
    0,
    this.waitForPlayerHangTimeoutMs - 19_000,
  );
  private blankPassModes = this.resolveBlankPassModes();
  private supportedTypes = this.resolveSupportedTypes();

  constructor(private ctx: Context) {
    if (!this.enabled) {
      return;
    }
    this.waitForPlayerProvider.registerTick({
      roomFilter: (room) => !!room.randomType,
      raadyTimeoutMs: this.waitForPlayerReadyTimeoutMs,
      hangTimeoutMs: this.waitForPlayerHangTimeoutMs,
      longAgoBackoffMs: this.waitForPlayerLongAgoBackoffMs,
    });
    if (this.recordMatchScoresConfigured && !this.ctx.database) {
      this.logger.warn(
        'RANDOM_DUEL_RECORD_MATCH_SCORES is enabled but database is unavailable',
      );
    }
    this.ctx.middleware(CanReconnectCheck, async (msg, _client, next) => {
      if (msg.room.randomType && this.getDisconnectedCount(msg.room) > 1) {
        return msg.no();
      }
      return next();
    });
    this.ctx.middleware(OnRoomJoinPlayer, async (event, client, next) => {
      await this.updateOpponentRelation(event.room, client);
      return next();
    });
    this.ctx.middleware(OnRoomFinalize, async (event, _client, next) => {
      await this.recordMatchResult(event.room);
      return next();
    });
    this.ctx.middleware(YGOProCtosChat, async (msg, client, next) => {
      if (!this.disableChat || !client.roomName) {
        return next();
      }
      const room = this.roomManager.findByName(client.roomName);
      if (!room?.randomType) {
        return next();
      }
      await client.sendChat('#{chat_disabled}', ChatColor.BABYBLUE);
      return;
    });
  }

  get defaultType() {
    return this.blankPassModes[0] || 'S';
  }

  resolveRandomType(pass: string): string | undefined {
    if (!this.enabled) {
      return undefined;
    }
    const type = pass.trim().toUpperCase();
    if (!type) {
      return '';
    }
    if (this.supportedTypes.has(type)) {
      return type;
    }
    return undefined;
  }

  async findOrCreateRandomRoom(type: string, playerIp: string) {
    const found = await this.findRandomRoom(type, playerIp);
    if (found) {
      const foundType = found.randomType || type || this.defaultType;
      found.randomType = foundType;
      found.checkChatBadword = true;
      found.noHost = true;
      found.randomDuelMaxPlayer = this.resolveRandomDuelMaxPlayer(foundType);
      found.welcome = '#{random_duel_enter_room_waiting}';
      this.applyWelcomeType(found, foundType);
      return found;
    }

    const randomType = type || this.defaultType;
    const roomName = this.generateRandomRoomName(randomType);
    if (!roomName) {
      return undefined;
    }
    const room = await this.roomManager.findOrCreateByName(roomName);
    room.randomType = randomType;
    room.checkChatBadword = true;
    room.noHost = true;
    room.randomDuelMaxPlayer = this.resolveRandomDuelMaxPlayer(randomType);
    room.welcome = '#{random_duel_enter_room_new}';
    this.applyWelcomeType(room, randomType);
    return room;
  }

  private resolveBlankPassModes() {
    const modes = this.ctx.config
      .getStringArray('RANDOM_DUEL_BLANK_PASS_MODES')
      .map((s) => s.trim().toUpperCase())
      .filter((s) => !!s);
    const uniqModes = Array.from(new Set(modes));
    if (!uniqModes.length) {
      return ['S', 'M'];
    }
    return uniqModes;
  }

  private resolveSupportedTypes() {
    return new Set([...BUILTIN_RANDOM_TYPES, ...this.blankPassModes]);
  }

  private canMatchType(roomType: string, targetType: string) {
    if (!targetType) {
      return (
        roomType === this.defaultType || this.blankPassModes.includes(roomType)
      );
    }
    return roomType === targetType;
  }

  private resolveRandomDuelMaxPlayer(type: string) {
    return type === 'T' ? 4 : 2;
  }

  private getDisconnectedCount(room: Room) {
    return room.playingPlayers.filter((player) => !!player.disconnected).length;
  }

  private async findRandomRoom(type: string, playerIp: string) {
    for (const room of this.roomManager.allRooms()) {
      if (
        !room.randomType ||
        room.finalizing ||
        room.duelStage !== DuelStage.Begin ||
        room.windbot
      ) {
        continue;
      }
      if (!this.canMatchType(room.randomType, type)) {
        continue;
      }
      const maxPlayer =
        room.randomDuelMaxPlayer ||
        this.resolveRandomDuelMaxPlayer(room.randomType);
      const playingCount = room.playingPlayers.length;
      if (playingCount <= 0 || playingCount >= maxPlayer) {
        continue;
      }
      if (!this.noRematchCheck) {
        const host = room.playingPlayers.find((p) => p.isHost);
        if (host?.ip) {
          const lastOpponentIp = await this.getLastOpponent(playerIp);
          if (lastOpponentIp && lastOpponentIp === host.ip) {
            continue;
          }
        }
      }
      return room;
    }
    return undefined;
  }

  private generateRandomRoomName(type: string) {
    const prefix = `${type},RANDOM#`;
    for (let i = 0; i < 1000; i += 1) {
      const name = fillRandomString(prefix, MAX_ROOM_NAME_LENGTH);
      if (!this.roomManager.findByName(name)) {
        return name;
      }
    }
    return undefined;
  }

  private applyWelcomeType(room: Room, type: string) {
    if (type === 'S') {
      room.welcome2 = '#{random_duel_enter_room_single}';
      return;
    }
    if (type === 'M') {
      room.welcome2 = '#{random_duel_enter_room_match}';
      return;
    }
    if (type === 'T') {
      room.welcome2 = '#{random_duel_enter_room_tag}';
      return;
    }
    room.welcome2 = '';
  }

  private async updateOpponentRelation(room: Room, client: Client) {
    if (!room.randomType || !client.ip) {
      return;
    }
    const host = room.playingPlayers.find((player) => player.isHost);
    if (host && host !== client && host.ip) {
      await this.setLastOpponent(host.ip, client.ip);
      await this.setLastOpponent(client.ip, host.ip);
      return;
    }
    await this.setLastOpponent(client.ip, '');
  }

  private async getLastOpponent(ip: string) {
    const data = await this.ctx.aragami.get(RandomDuelOpponentCache, ip);
    return data?.opponentIp || '';
  }

  private async setLastOpponent(ip: string, opponentIp: string) {
    await this.ctx.aragami.set(
      RandomDuelOpponentCache,
      {
        ip,
        opponentIp,
      },
      {
        key: ip,
        ttl: RANDOM_DUEL_TTL,
      },
    );
  }

  private get recordMatchScoresEnabled() {
    return this.recordMatchScoresConfigured && !!this.ctx.database;
  }

  private async recordMatchResult(room: Room) {
    if (!this.recordMatchScoresEnabled || room.randomType !== 'M') {
      return;
    }
    const duelPos0Player = room.getDuelPosPlayers(0)[0];
    const duelPos1Player = room.getDuelPosPlayers(1)[0];
    if (!duelPos0Player || !duelPos1Player) {
      return;
    }
    const [score0, score1] = room.score;
    if (score0 === score1) {
      return;
    }
    if (score0 > score1) {
      await this.recordWin(duelPos0Player.name_vpass || duelPos0Player.name);
      await this.recordLose(duelPos1Player.name_vpass || duelPos1Player.name);
      return;
    }
    await this.recordWin(duelPos1Player.name_vpass || duelPos1Player.name);
    await this.recordLose(duelPos0Player.name_vpass || duelPos0Player.name);
  }

  private async getOrCreateScore(name: string) {
    const repo = this.ctx.database?.getRepository(RandomDuelScore);
    if (!repo) {
      return undefined;
    }
    let score = await repo.findOneBy({ name });
    if (!score) {
      score = repo.create({ name });
    }
    return score;
  }

  private async recordWin(name: string) {
    if (!name) {
      return;
    }
    const repo = this.ctx.database?.getRepository(RandomDuelScore);
    if (!repo) {
      return;
    }
    const score = await this.getOrCreateScore(name);
    if (!score) {
      return;
    }
    score.win();
    await repo.save(score);
  }

  private async recordLose(name: string) {
    if (!name) {
      return;
    }
    const repo = this.ctx.database?.getRepository(RandomDuelScore);
    if (!repo) {
      return;
    }
    const score = await this.getOrCreateScore(name);
    if (!score) {
      return;
    }
    score.lose();
    await repo.save(score);
  }
}
