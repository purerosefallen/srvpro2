import YGOProDeck from 'ygopro-deck-encode';
import { ChatColor, YGOProCtosHsToObserver } from 'ygopro-msg-encode';
import { Context } from '../app';
import { DuelStage, OnRoomFinalize, OnRoomSidingStart, Room } from '../room';
import { deckNameMatch } from '../utility/deck-name-match';
import {
  Challonge,
  ChallongeConfig,
  Match,
  MatchPost,
  Participant,
  Tournament,
} from './challonge-api';
import { LockDeckExpectedDeckCheck } from './lock-deck';
import { ClientRoomField } from '../utility';
import { Client } from '../client';

export type ChallongeParticipantUpload = {
  name: string;
  deckbuf: string;
};

type ScoreSnapshot = {
  roomName: string;
  player0Name: string;
  player1Name: string;
  score0: number;
  score1: number;
  player0ParticipantId?: number;
  player1ParticipantId?: number;
  match: Match;
};

type ScorePostResult = {
  posted: boolean;
  reason: string;
  matchId?: number;
  scoresCsv?: string;
  winnerId?: number | 'tie' | null;
};

type ChallongeJoinResolveResult =
  | {
      ok: true;
      participant: Participant;
      match: Match;
    }
  | {
      ok: false;
      reason: 'match_load_failed' | 'user_not_found' | 'match_not_found';
    };

const CHALLONGE_UPLOAD_CHUNK_SIZE = 10;
const DEFAULT_CHALLONGE_CACHE_TTL = 60_000;

declare module '../client' {
  interface Client {
    challongeInfo?: Participant;
  }
}

ClientRoomField()(Client.prototype, 'challongeInfo');

declare module '../room' {
  interface Room {
    challongeInfo?: Match;
  }
}

export class ChallongeService {
  private logger = this.ctx.createLogger('ChallongeService');
  private invalidConfigWarned = false;
  private challongeApi?: Challonge;
  private challongeApiFingerprint = '';

  constructor(private ctx: Context) {}

  async init() {
    this.registerLockDeckCheck();
    this.registerScoreHooks();
    this.registerToObserverGuard();
  }

  get enabled() {
    return this.isEnabled() && this.hasValidConfig();
  }

  async *uploadToChallonge(
    participants: ChallongeParticipantUpload[],
  ): AsyncGenerator<string, boolean, void> {
    if (!this.isEnabled()) {
      yield '未开启Challonge模式。';
      return false;
    }
    const challonge = this.getChallongeApi();
    if (!challonge) {
      yield 'Challonge 上传失败：配置不完整。';
      return false;
    }
    if (!participants.length) {
      yield '玩家列表为空。';
      return false;
    }

    try {
      yield '开始清空 Challonge 玩家列表。';
      const cleared = await challonge.clearParticipants();
      if (!cleared) {
        throw new Error('clear participants failed');
      }

      yield '开始上传玩家列表至 Challonge。';
      for (
        let i = 0;
        i < participants.length;
        i += CHALLONGE_UPLOAD_CHUNK_SIZE
      ) {
        const chunk = participants.slice(i, i + CHALLONGE_UPLOAD_CHUNK_SIZE);
        yield `开始上传玩家 ${chunk.map((item) => item.name).join(', ')} 至 Challonge。`;
        const uploaded = await challonge.uploadParticipants(chunk);
        if (!uploaded) {
          throw new Error(
            `upload participants failed: ${chunk
              .map((item) => item.name)
              .join(', ')}`,
          );
        }
      }
      yield '玩家列表上传完成。';
      return true;
    } catch (error: unknown) {
      yield `Challonge 上传失败：${this.toErrorMessage(error)}`;
      return false;
    }
  }

  async resolveJoinInfo(
    playerName: string,
  ): Promise<ChallongeJoinResolveResult> {
    const challonge = this.getChallongeApi();
    if (!challonge) {
      return {
        ok: false,
        reason: 'match_load_failed',
      };
    }
    const tournament = await challonge.getTournament();
    if (!tournament) {
      return {
        ok: false,
        reason: 'match_load_failed',
      };
    }

    const participant = this.findParticipantByName(tournament, playerName);
    if (!participant) {
      return {
        ok: false,
        reason: 'user_not_found',
      };
    }

    const match = this.findPendingMatchByParticipant(
      tournament,
      participant.id,
    );
    if (!match) {
      return {
        ok: false,
        reason: 'match_not_found',
      };
    }

    return {
      ok: true,
      participant,
      match,
    };
  }

  private registerLockDeckCheck() {
    this.ctx.middleware(
      LockDeckExpectedDeckCheck,
      async (event, _client, next) => {
        if (
          event.expectedDeck !== undefined ||
          !this.isEnabled() ||
          !event.room.challongeInfo
        ) {
          return next();
        }

        const clientDeck = this.decodeParticipantDeck(
          event.client.challongeInfo,
        );
        if (clientDeck !== undefined) {
          event.use(clientDeck);
          return next();
        }

        const expectedDeck = this.findExpectedDeckFromRoom(
          event.room,
          event.client.name,
        );
        if (expectedDeck !== undefined) {
          event.use(expectedDeck);
        }
        return next();
      },
    );
  }

  private registerScoreHooks() {
    this.ctx.middleware(OnRoomSidingStart, async (event, _client, next) => {
      if (
        this.isEnabled() &&
        event.room.challongeInfo &&
        this.ctx.config.getBoolean('CHALLONGE_POST_SCORE_MIDDUEL')
      ) {
        this.postScoreByRoomNonBlocking(event.room, true, 'OnRoomSidingStart');
      }
      return next();
    });

    this.ctx.middleware(OnRoomFinalize, async (event, _client, next) => {
      if (this.isEnabled() && event.room.challongeInfo) {
        this.postScoreByRoomNonBlocking(event.room, false, 'OnRoomFinalize');
      }
      return next();
    });
  }

  private registerToObserverGuard() {
    this.ctx.middleware(YGOProCtosHsToObserver, async (_msg, client, next) => {
      if (!client.challongeInfo) {
        return next();
      }
      await client.sendChat('#{cannot_to_observer}', ChatColor.BABYBLUE);
      return;
    });
  }

  private postScoreByRoomNonBlocking(
    room: Room,
    noWinner: boolean,
    source: 'OnRoomSidingStart' | 'OnRoomFinalize',
  ) {
    const snapshot = this.createScoreSnapshot(room);
    if (!snapshot) {
      return;
    }

    void this.postScore(snapshot, noWinner)
      .then((result) => {
        this.logger.info(
          {
            source,
            roomName: snapshot.roomName,
            noWinner,
            ...result,
          },
          'Challonge score report finished',
        );
      })
      .catch((error: unknown) => {
        this.logger.warn(
          {
            source,
            roomName: snapshot.roomName,
            noWinner,
            err: error,
          },
          'Challonge score report failed',
        );
      });
  }

  private createScoreSnapshot(room: Room): ScoreSnapshot | undefined {
    if (!room.challongeInfo) {
      return undefined;
    }
    if (room.hostinfo.mode === 2) {
      return undefined;
    }
    if (room.duelStage === DuelStage.Begin) {
      return undefined;
    }

    const player0 = room.getDuelPosPlayers(0)[0];
    const player1 = room.getDuelPosPlayers(1)[0];
    if (!player0 || !player1) {
      return undefined;
    }

    const [score0, score1] = room.score;
    return {
      roomName: room.name,
      player0Name: player0.name,
      player1Name: player1.name,
      score0,
      score1,
      player0ParticipantId: player0.challongeInfo?.id,
      player1ParticipantId: player1.challongeInfo?.id,
      match: room.challongeInfo,
    };
  }

  private async postScore(snapshot: ScoreSnapshot, noWinner: boolean) {
    const challonge = this.getChallongeApi();
    if (!challonge) {
      return {
        posted: false,
        reason: 'challonge_config_incomplete',
      } satisfies ScorePostResult;
    }

    const [participant0Id, participant1Id] =
      this.resolveScoreParticipantIds(snapshot);

    if (participant0Id == null || participant1Id == null) {
      return {
        posted: false,
        reason: 'participant_not_found',
      } satisfies ScorePostResult;
    }

    const match = snapshot.match;
    if (
      !this.isScoreParticipantMatched(match, participant0Id, participant1Id)
    ) {
      return {
        posted: false,
        reason: 'match_player_mismatch',
        matchId: match.id,
      } satisfies ScorePostResult;
    }

    const scorePost = this.buildScorePost(
      snapshot,
      match,
      participant0Id,
      participant1Id,
    );
    if (noWinner) {
      delete scorePost.winner_id;
    }

    const posted = await challonge.putScore(match.id, scorePost);
    if (!posted) {
      return {
        posted: false,
        reason: 'put_score_failed',
        matchId: match.id,
        scoresCsv: scorePost.scores_csv,
      } satisfies ScorePostResult;
    }

    return {
      posted: true,
      reason: 'ok',
      matchId: match.id,
      scoresCsv: scorePost.scores_csv,
      winnerId: scorePost.winner_id || null,
    } satisfies ScorePostResult;
  }

  private buildScorePost(
    snapshot: ScoreSnapshot,
    match: Match,
    participant0Id: number,
    participant1Id: number,
  ): MatchPost {
    let winnerId: number | 'tie' = 'tie';
    if (snapshot.score0 > snapshot.score1) {
      winnerId = participant0Id;
    } else if (snapshot.score0 < snapshot.score1) {
      winnerId = participant1Id;
    }

    let scoresCsv = '0-0';
    if (this.ctx.config.getBoolean('CHALLONGE_POST_DETAILED_SCORE')) {
      if (
        participant0Id === match.player1_id &&
        participant1Id === match.player2_id
      ) {
        scoresCsv = `${snapshot.score0}-${snapshot.score1}`;
      } else if (
        participant1Id === match.player1_id &&
        participant0Id === match.player2_id
      ) {
        scoresCsv = `${snapshot.score1}-${snapshot.score0}`;
      } else {
        this.logger.warn(
          {
            roomName: snapshot.roomName,
            player0: snapshot.player0Name,
            player1: snapshot.player1Name,
            participant0Id,
            participant1Id,
            matchPlayer1Id: match.player1_id,
            matchPlayer2Id: match.player2_id,
          },
          'Challonge score mismatch',
        );
      }
    } else if (winnerId === match.player1_id) {
      scoresCsv = '1-0';
    } else if (winnerId === match.player2_id) {
      scoresCsv = '0-1';
    }

    return {
      scores_csv: scoresCsv,
      winner_id: winnerId,
    };
  }

  private findPendingMatchByParticipant(
    tournament: Tournament,
    participantId: number,
  ) {
    return tournament.matches
      .map((wrapper) => wrapper.match)
      .find((match) => {
        if (
          !match ||
          match.winner_id ||
          match.state === 'complete' ||
          !match.player1_id ||
          !match.player2_id
        ) {
          return false;
        }
        return (
          match.player1_id === participantId ||
          match.player2_id === participantId
        );
      });
  }

  private findParticipantByName(tournament: Tournament, name: string) {
    return tournament.participants
      .map((wrapper) => wrapper.participant)
      .find((participant) => deckNameMatch(participant?.name || '', name));
  }

  private isScoreParticipantMatched(
    match: Match,
    participant0Id: number,
    participant1Id: number,
  ) {
    if (participant0Id === participant1Id) {
      return false;
    }
    const ids = [match.player1_id, match.player2_id];
    return ids.includes(participant0Id) && ids.includes(participant1Id);
  }

  private resolveScoreParticipantIds(
    snapshot: ScoreSnapshot,
  ): [number | undefined, number | undefined] {
    const match = snapshot.match;
    let participant0Id = snapshot.player0ParticipantId;
    let participant1Id = snapshot.player1ParticipantId;

    if (participant0Id == null && participant1Id == null) {
      return [match.player1_id, match.player2_id];
    }

    if (participant0Id == null && participant1Id != null) {
      participant0Id =
        participant1Id === match.player1_id
          ? match.player2_id
          : match.player1_id;
    } else if (participant1Id == null && participant0Id != null) {
      participant1Id =
        participant0Id === match.player1_id
          ? match.player2_id
          : match.player1_id;
    }

    return [participant0Id, participant1Id];
  }

  private findExpectedDeckFromRoom(room: Room, playerName: string) {
    const name = String(playerName || '').trim();
    if (!name) {
      return undefined;
    }
    for (const player of room.playingPlayers) {
      if (!deckNameMatch(player.name, name)) {
        continue;
      }
      return this.decodeParticipantDeck(player.challongeInfo);
    }
    return undefined;
  }

  private decodeParticipantDeck(
    participant: Pick<Participant, 'name' | 'deckbuf'> | undefined,
  ): YGOProDeck | null | undefined {
    if (!participant || !participant.deckbuf) {
      return undefined;
    }
    try {
      const payload = Buffer.from(participant.deckbuf, 'base64');
      const deck = YGOProDeck.fromUpdateDeckPayload(payload);
      deck.name = participant.name;
      return deck;
    } catch (error: unknown) {
      this.logger.warn(
        {
          participantName: participant.name,
          err: error,
        },
        'Failed to decode challonge deckbuf',
      );
      return null;
    }
  }

  private isEnabled() {
    return this.ctx.config.getBoolean('CHALLONGE_ENABLED');
  }

  private getChallongeApi() {
    if (!this.isEnabled() || !this.hasValidConfig()) {
      return undefined;
    }
    const config = this.getChallongeConfig();
    const fingerprint = JSON.stringify(config);
    if (!this.challongeApi || this.challongeApiFingerprint !== fingerprint) {
      this.challongeApi = new Challonge(config, this.ctx.http, {
        info: (message, ...args) => {
          this.logger.info({ args }, String(message));
        },
        warn: (message, ...args) => {
          this.logger.warn({ args }, String(message));
        },
        error: (message, ...args) => {
          this.logger.warn({ args }, String(message));
        },
      });
      this.challongeApiFingerprint = fingerprint;
    }
    return this.challongeApi;
  }

  private getChallongeConfig(): ChallongeConfig {
    return {
      api_key: this.ctx.config.getString('CHALLONGE_API_KEY'),
      tournament_id: this.ctx.config.getString('CHALLONGE_TOURNAMENT_ID'),
      cache_ttl: this.getCacheTtl(),
      challonge_url: this.ctx.config.getString('CHALLONGE_URL'),
    };
  }

  private getCacheTtl() {
    const ttl = this.ctx.config.getInt('CHALLONGE_CACHE_TTL');
    if (!Number.isFinite(ttl) || ttl < 0) {
      return DEFAULT_CHALLONGE_CACHE_TTL;
    }
    return ttl;
  }

  private hasValidConfig() {
    const apiKey = this.ctx.config.getString('CHALLONGE_API_KEY');
    const tournamentId = this.ctx.config.getString('CHALLONGE_TOURNAMENT_ID');
    const url = this.ctx.config.getString('CHALLONGE_URL');
    const valid = !!(apiKey && tournamentId && url);
    if (!valid && !this.invalidConfigWarned) {
      this.invalidConfigWarned = true;
      this.logger.warn(
        {
          hasApiKey: !!apiKey,
          hasTournamentId: !!tournamentId,
          hasUrl: !!url,
        },
        'Challonge is enabled but config is incomplete',
      );
    }
    if (valid) {
      this.invalidConfigWarned = false;
    }
    return valid;
  }

  private toErrorMessage(error: unknown) {
    if (error instanceof Error) {
      return error.message;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
}
