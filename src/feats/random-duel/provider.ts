import { CacheKey } from 'aragami';
import {
  ChatColor,
  NetPlayerType,
  YGOProCtosChat,
  YGOProCtosSurrender,
} from 'ygopro-msg-encode';
import { Context } from '../../app';
import { Client } from '../../client';
import { MAX_ROOM_NAME_LENGTH } from '../../constants/room';
import {
  DuelStage,
  DefaultHostInfoProvider,
  OnRoomFinalize,
  OnRoomJoinPlayer,
  OnRoomLeavePlayer,
  RoomLeavePlayerReason,
  Room,
  RoomManager,
} from '../../room';
import { fillRandomString } from '../../utility/fill-random-string';
import {
  OnClientBadwordViolation,
  OnClientWaitTimeout,
} from './random-duel-events';
import { CanReconnectCheck } from '../reconnect';
import { WaitForPlayerProvider } from '../wait-for-player-provider';
import { ClientKeyProvider } from '../client-key-provider';
import { HidePlayerNameProvider } from '../hide-player-name-provider';
import { RandomDuelScore } from './score.entity';
import {
  formatRemainText,
  RandomDuelPunishReason,
  renderReasonText,
} from './utility/random-duel-discipline';

const RANDOM_DUEL_TTL = 24 * 60 * 60 * 1000;
const RANDOM_DUEL_WARN_COUNT = 2;
const RANDOM_DUEL_DEPRECATED_COUNT = 3;
const RANDOM_DUEL_BANNED_COUNT = 6;
const RANDOM_DUEL_EARLY_SURRENDER_TURN = 3;

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
  clientKey!: string;

  opponentKey = '';
}

class RandomDuelDisciplineCache {
  @CacheKey()
  clientKey!: string;

  count = 0;
  reasons: RandomDuelPunishReason[] = [];
  needTip = false;
  abuseCount = 0;
  expireAt = 0;
}

declare module '../../room' {
  interface Room {
    randomType?: string;
    randomDuelMaxPlayer?: number;
    randomDuelDeprecated?: boolean;
    randomDuelScoreHandled?: boolean;
  }
}

interface RandomDuelJoinState {
  deprecated: boolean;
  errorMessage?: string;
}

interface FindOrCreateRandomRoomResult {
  room?: Room;
  errorMessage?: string;
}

export class RandomDuelProvider {
  private logger = this.ctx.createLogger(this.constructor.name);
  private roomManager = this.ctx.get(() => RoomManager);
  private waitForPlayerProvider = this.ctx.get(() => WaitForPlayerProvider);
  private clientKeyProvider = this.ctx.get(() => ClientKeyProvider);
  private hidePlayerNameProvider = this.ctx.get(() => HidePlayerNameProvider);
  private defaultHostInfoProvider = this.ctx.get(() => DefaultHostInfoProvider);
  private hidePlayerName = this.ctx.get(() => HidePlayerNameProvider);

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

  constructor(private ctx: Context) {}

  async init() {
    if (!this.enabled) {
      return;
    }

    this.ctx.middleware(CanReconnectCheck, async (msg, _client, next) => {
      if (msg.room.randomType && this.getDisconnectedCount(msg.room) > 1) {
        return msg.no();
      }
      return next();
    });

    this.ctx.middleware(OnRoomJoinPlayer, async (event, client, next) => {
      if (event.room.randomType) {
        await this.setAbuseCount(this.getClientKey(client), 0);
      }
      await this.updateOpponentRelation(event.room, client);
      if (event.room.randomType === 'M') {
        await this.sendMatchScoreTips(event.room, client);
      }
      return next();
    });

    this.ctx.middleware(OnRoomLeavePlayer, async (event, client, next) => {
      await this.handlePlayerLeave(event, client);
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

    this.ctx.middleware(YGOProCtosSurrender, async (_msg, client, next) => {
      if (client.isInternal || !client.roomName) {
        return next();
      }
      const room = this.roomManager.findByName(client.roomName);
      if (!room?.randomType) {
        return next();
      }
      if (
        room.turnCount >= RANDOM_DUEL_EARLY_SURRENDER_TURN ||
        (room.randomType === 'M' && this.recordMatchScoresEnabled) ||
        client.fleeFree
      ) {
        return next();
      }
      await client.sendChat('#{surrender_denied}', ChatColor.BABYBLUE);
      return;
    });

    this.ctx.middleware(OnClientWaitTimeout, async (event, _client, next) => {
      await this.handleWaitTimeout(event);
      return next();
    });

    this.ctx.middleware(
      OnClientBadwordViolation,
      async (event, _client, next) => {
        await this.handleBadwordViolation(event);
        return next();
      },
    );

    this.registerRandomRoomModes();
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

  async findOrCreateRandomRoom(
    type: string,
    client: Client,
  ): Promise<FindOrCreateRandomRoomResult> {
    const playerKey = this.getClientKey(client);
    const joinState = await this.resolveJoinState(type, playerKey);
    if (joinState.errorMessage) {
      return { errorMessage: joinState.errorMessage };
    }

    const found = await this.findRandomRoom(
      type,
      playerKey,
      joinState.deprecated,
    );
    if (found) {
      const foundType = found.randomType || type || this.defaultType;
      found.welcome = '#{random_duel_enter_room_waiting}';
      this.applyWelcomeType(found, foundType);
      return { room: found };
    }

    const randomType = type || this.defaultType;
    const roomName = this.generateRandomRoomName(randomType);
    if (!roomName) {
      return {};
    }
    const room = await this.roomManager.findOrCreateByName(roomName);
    room.randomType = randomType;
    room.hidePlayerNames = this.hidePlayerNameProvider.enabled;
    room.randomDuelDeprecated = joinState.deprecated;
    room.checkChatBadword = true;
    room.noHost = true;
    room.randomDuelMaxPlayer = this.resolveRandomDuelMaxPlayer(randomType);
    room.welcome = '#{random_duel_enter_room_new}';
    this.applyWelcomeType(room, randomType);
    return { room };
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

  private registerRandomRoomModes() {
    this.defaultHostInfoProvider
      .registerRoomMode('(OOR|OCGONLYRANDOM)', {
        rule: 0,
        lflist: 0,
      })
      .registerRoomMode('(OR|OCGRANDOM)', {
        rule: 5,
        lflist: 0,
      })
      .registerRoomMode('(CR|CCGRANDOM)', {
        rule: 2,
        lflist: -1,
      })
      .registerRoomMode('(TOR|TCGONLYRANDOM)', {
        rule: 1,
      })
      .registerRoomMode('(TR|TCGRANDOM)', {
        rule: 5,
      })
      .registerRoomMode('(OOMR|OCGONLYMATCHRANDOM)', {
        rule: 0,
        lflist: 0,
        mode: 1,
      })
      .registerRoomMode('(OMR|OCGMATCHRANDOM)', {
        rule: 5,
        lflist: 0,
        mode: 1,
      })
      .registerRoomMode('(CMR|CCGMATCHRANDOM)', {
        rule: 2,
        lflist: -1,
        mode: 1,
      })
      .registerRoomMode('(TOMR|TCGONLYMATCHRANDOM)', {
        rule: 1,
        mode: 1,
      })
      .registerRoomMode('(TMR|TCGMATCHRANDOM)', {
        rule: 5,
        mode: 1,
      });
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

  private async resolveJoinState(
    type: string,
    playerKey: string,
  ): Promise<RandomDuelJoinState> {
    if (!playerKey) {
      return { deprecated: false };
    }
    const discipline = await this.getDiscipline(playerKey);
    const reasonsText = renderReasonText(discipline.reasons);
    const remainText = formatRemainText(discipline.expireAt);
    const deprecated = discipline.count > RANDOM_DUEL_DEPRECATED_COUNT;

    if (discipline.count > RANDOM_DUEL_BANNED_COUNT) {
      return {
        deprecated,
        errorMessage: `#{random_banned_part1}${reasonsText}#{random_banned_part2}${remainText}#{random_banned_part3}`,
      };
    }

    if (
      discipline.count > RANDOM_DUEL_DEPRECATED_COUNT &&
      discipline.needTip &&
      type !== 'T'
    ) {
      discipline.needTip = false;
      await this.setDiscipline(playerKey, discipline);
      return {
        deprecated,
        errorMessage: `#{random_deprecated_part1}${reasonsText}#{random_deprecated_part2}${remainText}#{random_deprecated_part3}`,
      };
    }

    if (discipline.needTip) {
      discipline.needTip = false;
      await this.setDiscipline(playerKey, discipline);
      return {
        deprecated,
        errorMessage: `#{random_warn_part1}${reasonsText}#{random_warn_part2}`,
      };
    }

    if (discipline.count > RANDOM_DUEL_WARN_COUNT && !discipline.needTip) {
      discipline.needTip = true;
      await this.setDiscipline(playerKey, discipline);
    }
    return { deprecated };
  }

  private async findRandomRoom(
    type: string,
    playerKey: string,
    playerDeprecated: boolean,
  ) {
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
      if (type !== 'T' && !!room.randomDuelDeprecated !== !!playerDeprecated) {
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
        if (host) {
          const hostKey = this.getClientKey(host);
          const lastOpponentKey = await this.getLastOpponent(playerKey);
          if (lastOpponentKey && lastOpponentKey === hostKey) {
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

  private async handlePlayerLeave(event: OnRoomLeavePlayer, client: Client) {
    const room = event.room;
    if (
      !room.randomType ||
      client.isInternal ||
      event.reason !== RoomLeavePlayerReason.Disconnect ||
      event.bySystem ||
      event.oldPos >= NetPlayerType.OBSERVER ||
      room.duelStage === DuelStage.Begin ||
      client.fleeFree
    ) {
      return;
    }

    await this.punishPlayer(client, 'FLEE');

    if (
      this.recordMatchScoresEnabled &&
      room.randomType === 'M' &&
      !room.randomDuelScoreHandled
    ) {
      await this.recordFleeResult(room, client);
      room.randomDuelScoreHandled = true;
    }
  }

  private async handleWaitTimeout(event: OnClientWaitTimeout) {
    if (!event.room.randomType || event.client.isInternal) {
      return;
    }
    const reason: RandomDuelPunishReason =
      event.type === 'ready' ? 'ZOMBIE' : 'AFK';
    await this.punishPlayer(event.client, reason);
  }

  private async handleBadwordViolation(event: OnClientBadwordViolation) {
    const room = event.room;
    const client = event.client;
    const clientKey = this.getClientKey(client);
    if (!room?.randomType || client.isInternal || !clientKey) {
      return;
    }

    let abuseCount = await this.getAbuseCount(clientKey);
    if (event.level >= 3) {
      if (abuseCount > 0) {
        await client.sendChat('#{banned_duel_tip}', ChatColor.RED);
        await this.punishPlayer(client, 'ABUSE');
        await this.punishPlayer(client, 'ABUSE', 3);
        client.disconnect();
        return;
      }
      abuseCount += 4;
    } else if (event.level === 2) {
      abuseCount += 3;
    } else if (event.level === 1) {
      abuseCount += 1;
    } else {
      return;
    }

    await this.setAbuseCount(clientKey, abuseCount);

    if (abuseCount >= 2) {
      await this.unwelcome(room, client);
    }
    if (abuseCount >= 5) {
      await room.sendChat(
        (sightPlayer) =>
          `${this.hidePlayerName.getHidPlayerName(client, sightPlayer)} #{chat_banned}`,
        ChatColor.RED,
      );
      await this.punishPlayer(client, 'ABUSE');
      client.disconnect();
    }
  }

  private async unwelcome(room: Room, badPlayer: Client) {
    await Promise.all(
      room.playingPlayers.map(async (player) => {
        if (player === badPlayer) {
          await player.sendChat(
            '#{unwelcome_warn_part1}#{random_ban_reason_abuse}#{unwelcome_warn_part2}',
            ChatColor.RED,
          );
          return;
        }
        if (player.pos >= NetPlayerType.OBSERVER || player.isInternal) {
          return;
        }
        player.fleeFree = true;
        await player.sendChat(
          '#{unwelcome_tip_part1}#{random_ban_reason_abuse}#{unwelcome_tip_part2}',
          ChatColor.BABYBLUE,
        );
      }),
    );
  }

  private async recordFleeResult(room: Room, loser: Client) {
    const loserName = this.getClientKey(loser);
    if (loserName) {
      await this.recordFlee(loserName);
    }
    const winner = room
      .getOpponents(loser)
      .find((player) => player.pos < NetPlayerType.OBSERVER);
    const winnerName = winner ? this.getClientKey(winner) : '';
    if (winnerName) {
      await this.recordWin(winnerName);
    }
  }

  private async updateOpponentRelation(room: Room, client: Client) {
    if (!room.randomType) {
      return;
    }
    const clientKey = this.getClientKey(client);
    if (!clientKey) {
      return;
    }
    const host = room.playingPlayers.find((player) => player.isHost);
    if (host && host !== client) {
      const hostKey = this.getClientKey(host);
      if (!hostKey) {
        return;
      }
      await this.setLastOpponent(hostKey, clientKey);
      await this.setLastOpponent(clientKey, hostKey);
      return;
    }
    await this.setLastOpponent(clientKey, '');
  }

  private async getLastOpponent(clientKey: string) {
    const data = await this.ctx.aragami.get(RandomDuelOpponentCache, clientKey);
    return data?.opponentKey || '';
  }

  private async setLastOpponent(clientKey: string, opponentKey: string) {
    if (!clientKey) {
      return;
    }
    await this.ctx.aragami.set(
      RandomDuelOpponentCache,
      {
        clientKey,
        opponentKey,
      },
      {
        key: clientKey,
        ttl: RANDOM_DUEL_TTL,
      },
    );
  }

  private async punishPlayer(
    client: Client,
    reason: RandomDuelPunishReason,
    countAdd = 1,
  ) {
    const clientKey = this.getClientKey(client);
    if (!clientKey) {
      return;
    }
    const discipline = await this.getDiscipline(clientKey);
    discipline.count += Math.max(0, countAdd);
    if (!discipline.reasons.includes(reason)) {
      discipline.reasons = [...discipline.reasons, reason].slice(-16);
    }
    discipline.needTip = true;
    discipline.expireAt = Date.now() + RANDOM_DUEL_TTL;
    await this.setDiscipline(clientKey, discipline);
    this.logger.info(
      {
        name: client.name,
        clientKey,
        reason,
        countAdd,
        count: discipline.count,
      },
      'Recorded random duel punishment',
    );
  }

  private async getDiscipline(clientKey: string) {
    const empty = {
      count: 0,
      reasons: [] as RandomDuelPunishReason[],
      needTip: false,
      abuseCount: 0,
      expireAt: 0,
    };
    if (!clientKey) {
      return empty;
    }
    const data = await this.ctx.aragami.get(
      RandomDuelDisciplineCache,
      clientKey,
    );
    const now = Date.now();
    const expireAt = Math.max(0, data?.expireAt || 0);
    if (!data || expireAt <= now) {
      return empty;
    }
    return {
      count: Math.max(0, data?.count || 0),
      reasons: [...(data?.reasons || [])].filter((reason) =>
        ['AFK', 'ABUSE', 'FLEE', 'ZOMBIE'].includes(reason),
      ) as RandomDuelPunishReason[],
      needTip: !!data?.needTip,
      abuseCount: Math.max(0, data?.abuseCount || 0),
      expireAt,
    };
  }

  private async setDiscipline(
    clientKey: string,
    data: {
      count: number;
      reasons: RandomDuelPunishReason[];
      needTip: boolean;
      abuseCount: number;
      expireAt: number;
    },
  ) {
    if (!clientKey) {
      return;
    }
    const now = Date.now();
    const expireAt = Math.max(
      now + 1000,
      data.expireAt || now + RANDOM_DUEL_TTL,
    );
    const ttl = Math.max(1000, expireAt - now);
    await this.ctx.aragami.set(
      RandomDuelDisciplineCache,
      {
        clientKey,
        count: Math.max(0, data.count || 0),
        reasons: [...(data.reasons || [])].slice(-16),
        needTip: !!data.needTip,
        abuseCount: Math.max(0, data.abuseCount || 0),
        expireAt,
      },
      {
        key: clientKey,
        ttl,
      },
    );
  }

  private async getAbuseCount(clientKey: string) {
    const discipline = await this.getDiscipline(clientKey);
    return discipline.abuseCount;
  }

  private async setAbuseCount(clientKey: string, abuseCount: number) {
    if (!clientKey) {
      return;
    }
    const discipline = await this.getDiscipline(clientKey);
    if (
      discipline.count <= 0 &&
      discipline.reasons.length <= 0 &&
      !discipline.needTip &&
      abuseCount <= 0
    ) {
      return;
    }
    discipline.abuseCount = Math.max(0, abuseCount);
    await this.setDiscipline(clientKey, discipline);
  }

  private async sendMatchScoreTips(room: Room, client: Client) {
    if (!this.recordMatchScoresEnabled) {
      return;
    }
    const players = room.playingPlayers.filter(
      (player) => player.pos < NetPlayerType.OBSERVER,
    );
    if (!players.length) {
      return;
    }

    const clientScoreText = await this.getScoreDisplay(
      this.getClientKey(client),
      this.hidePlayerName.getHidPlayerName(client, client),
    );
    for (const player of players) {
      if (clientScoreText) {
        await player.sendChat(clientScoreText, ChatColor.GREEN);
      }
      if (player === client) {
        continue;
      }
      const playerScoreText = await this.getScoreDisplay(
        this.getClientKey(player),
        this.hidePlayerName.getHidPlayerName(player, client),
      );
      if (playerScoreText) {
        await client.sendChat(playerScoreText, ChatColor.GREEN);
      }
    }
  }

  private async getScoreDisplay(name: string, displayName: string) {
    const repo = this.ctx.database?.getRepository(RandomDuelScore);
    if (!repo || !name) {
      return '';
    }
    const score = await repo.findOneBy({ name });
    if (!score) {
      return `${displayName} #{random_score_blank}`;
    }

    const total = score.winCount + score.loseCount;
    if (score.winCount < 2 && total < 3) {
      return `${displayName} #{random_score_not_enough}`;
    }

    const safeTotal = total > 0 ? total : 1;
    const winRate = Math.ceil((score.winCount / safeTotal) * 100);
    const fleeRate = Math.ceil((score.fleeCount / safeTotal) * 100);

    if (score.winCombo >= 2) {
      return `#{random_score_part1}${displayName} #{random_score_part2} ${winRate}#{random_score_part3} ${fleeRate}#{random_score_part4_combo}${score.winCombo}#{random_score_part5_combo}`;
    }
    return `#{random_score_part1}${displayName} #{random_score_part2} ${winRate}#{random_score_part3} ${fleeRate}#{random_score_part4}`;
  }

  private get recordMatchScoresEnabled() {
    return this.recordMatchScoresConfigured && !!this.ctx.database;
  }

  private async recordMatchResult(room: Room) {
    if (
      !this.recordMatchScoresEnabled ||
      room.randomType !== 'M' ||
      room.randomDuelScoreHandled
    ) {
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
      await this.recordWin(this.getClientKey(duelPos0Player));
      await this.recordLose(this.getClientKey(duelPos1Player));
      return;
    }
    await this.recordWin(this.getClientKey(duelPos1Player));
    await this.recordLose(this.getClientKey(duelPos0Player));
  }

  private getClientKey(client: Client) {
    return this.clientKeyProvider.getClientKey(client);
  }

  async getOrCreateScore(name: string) {
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

  private async recordFlee(name: string) {
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
    score.flee();
    await repo.save(score);
  }
}
