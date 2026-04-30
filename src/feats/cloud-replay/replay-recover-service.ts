import YGOProDeck from 'ygopro-deck-encode';
import {
  ChatColor,
  HostInfo,
  NetPlayerType,
  OcgcoreCommonConstants,
  YGOProCtosResponse,
  YGOProMsgNewPhase,
  YGOProMsgNewTurn,
  YGOProMsgResponseBase,
  YGOProMsgRetry,
  YGOProStocGameMsg,
} from 'ygopro-msg-encode';
import {
  YGOProLFListError,
  YGOProLFListErrorReason,
} from 'ygopro-lflist-encode';
import { Context } from '../../app';
import { Client } from '../../client';
import {
  DefaultHostInfoProvider,
  DuelStage,
  OnRoomCreate,
  OnRoomDuelStart,
  OnRoomPlayerReady,
  OnRoomPlayerUnready,
  OnRoomWin,
  Room,
  RoomCheckDeck,
  RoomCreateCheck,
  RoomDecideFirst,
  RoomJoinCheck,
  RoomManager,
  RoomUseSeed,
} from '../../room';
import { isUpdateDeckPayloadEqual } from '../../utility/deck-compare';
import { DuelRecordEntity } from './duel-record.entity';
import { DuelRecordPlayer } from './duel-record-player.entity';
import { CloudReplayService } from './cloud-replay-service';
import { ClientKeyProvider } from '../client-key-provider';
import {
  decodeDeckBase64,
  decodeResponsesBase64,
  decodeSeedBase64,
} from './utility';

type ReplayRecoverPhaseCode = 'DP' | 'SP' | 'M1' | 'BP' | 'M2' | 'EP';

export type ReplayRecoverSpec = {
  id: number;
  turnCount: number;
  phase?: ReplayRecoverPhaseCode;
};

type ReplayRecoverState = {
  record: DuelRecordEntity;
  spec: ReplayRecoverSpec;
  responses: Buffer[];
  firstDuelPos?: number;
  seatReversed?: boolean;
};

declare module 'ygopro-msg-encode' {
  interface HostInfo {
    recover?: ReplayRecoverSpec;
    recover_parse_error?: number;
  }
}

declare module '../../room' {
  interface Room {
    recoverState?: ReplayRecoverState;
  }
}

const RECOVER_VALID_PATTERN = '(RC|RECOVER)(\\d+)T(\\d+)(DP|SP|M1|BP|M2|EP)?';
const RECOVER_LIKE_PATTERN = '(RC|RECOVER)[^,，#]*';
const RECOVER_LIKE_RE = /^(RC|RECOVER)/i;

const PHASE_VALUES: Record<ReplayRecoverPhaseCode, number> = {
  DP: OcgcoreCommonConstants.PHASE_DRAW,
  SP: OcgcoreCommonConstants.PHASE_STANDBY,
  M1: OcgcoreCommonConstants.PHASE_MAIN1,
  BP: OcgcoreCommonConstants.PHASE_BATTLE,
  M2: OcgcoreCommonConstants.PHASE_MAIN2,
  EP: OcgcoreCommonConstants.PHASE_END,
};
const TAG_MODE_BIT = 0x2;

class RecoverDeckBadError extends YGOProLFListError {
  constructor() {
    super(YGOProLFListErrorReason.LFLIST, 0);
  }

  toPayload() {
    return 0;
  }
}

export class ReplayRecoverService {
  private logger = this.ctx.createLogger(this.constructor.name);
  private roomManager = this.ctx.get(() => RoomManager);
  private cloudReplayService = this.ctx.get(() => CloudReplayService);
  private clientKeyProvider = this.ctx.get(() => ClientKeyProvider);

  constructor(private ctx: Context) {}

  get enabled() {
    return this.ctx.config.getBoolean('ENABLE_RECOVER') && !!this.ctx.database;
  }

  async init() {
    if (!this.enabled) {
      return;
    }

    this.registerRoomModes();
    this.registerRoomChecks();
    this.registerRecoverDeckCheck();
    this.registerRecoverFlow();
  }

  resolveRecoverRoomPrefix(pass: string | undefined) {
    if (!this.enabled) {
      return undefined;
    }
    const segment = this.resolveRecoverPassSegment(pass);
    if (!segment || !RECOVER_LIKE_RE.test(segment)) {
      return undefined;
    }
    return segment.toUpperCase();
  }

  private registerRoomModes() {
    this.ctx
      .get(() => DefaultHostInfoProvider)
      .registerRoomMode(RECOVER_VALID_PATTERN, ({ regexResult }) => {
        const spec = this.parseRecoverGroups(regexResult);
        if (!spec) {
          return { recover_parse_error: 1 };
        }
        return {
          recover: spec,
          recover_parse_error: 0,
        };
      })
      .registerRoomMode(RECOVER_LIKE_PATTERN, ({ hostinfo }) => {
        if (hostinfo.recover || hostinfo.recover_parse_error) {
          return {};
        }
        return { recover_parse_error: 1 };
      });
  }

  private registerRoomChecks() {
    this.ctx.middleware(RoomCreateCheck, async (event, creator, next) => {
      if (event.value) {
        return next();
      }

      if (event.hostinfo.recover_parse_error) {
        return event.use('#{recover_invalid}');
      }

      const spec = event.hostinfo.recover;
      if (!spec) {
        return next();
      }

      const record = await this.findRecoverRecord(spec.id);
      if (!record || !this.isAllowed(record, creator)) {
        return event.use('#{cloud_replay_no}');
      }

      Object.assign(event.hostinfo, record.hostInfo, {
        recover: spec,
        recover_parse_error: 0,
      });
      return next();
    });

    this.ctx.middleware(RoomJoinCheck, async (event, client, next) => {
      if (
        typeof event.value === 'string' ||
        event.room.duelStage !== DuelStage.Begin ||
        event.value === NetPlayerType.OBSERVER
      ) {
        return next();
      }
      const record = event.room.recoverState?.record;
      if (!record) {
        return next();
      }
      const recordPlayer = this.findRecordPlayerForClient(record, client);
      if (!recordPlayer) {
        return event.use('#{cloud_replay_no}');
      }
      event.use(recordPlayer.pos);
      return next();
    });
  }

  private registerRecoverDeckCheck() {
    this.ctx.middleware(RoomCheckDeck, async (event, client, next) => {
      const current = await next();
      if (event.value || !event.room.recoverState) {
        return current;
      }

      const recordPlayer = this.findRecordPlayerForDeck(
        event.room,
        client,
        event.deck,
      );
      if (!recordPlayer) {
        await client.sendChat('#{deck_incorrect_reconnect}', ChatColor.RED);
        return event.use(new RecoverDeckBadError());
      }

      const currentDeck = decodeDeckBase64(
        recordPlayer.currentDeckBuffer,
        recordPlayer.currentDeckMainc,
      );
      this.mutateDeck(event.deck, currentDeck);
      return current;
    });
  }

  private registerRecoverFlow() {
    this.ctx.middleware(OnRoomCreate, async (event, _client, next) => {
      const spec = event.room.hostinfo.recover;
      if (!spec) {
        return next();
      }

      const record = await this.findRecoverRecord(spec.id);
      if (!record) {
        return next();
      }

      this.restoreRecoverHostInfo(event.room, record.hostInfo);
      event.room.recoverState = {
        record,
        spec,
        responses: decodeResponsesBase64(record.responses),
        firstDuelPos: this.resolveRecordFirstDuelPos(event.room, record),
      };
      event.room.welcome = '#{recover_hint}';
      return next();
    });

    this.ctx.middleware(RoomUseSeed, async (event, _client, next) => {
      const state = event.room.recoverState;
      if (state && event.room.duelRecords.length === 0) {
        return event.use(decodeSeedBase64(state.record.seed));
      }
      return next();
    });

    this.ctx.middleware(RoomDecideFirst, async (event, _client, next) => {
      const state = event.room.recoverState;
      if (
        state &&
        event.room.duelRecords.length === 0 &&
        event.value == null &&
        state.firstDuelPos != null
      ) {
        return event.use(this.resolveRecoverFirstDuelPos(state));
      }
      return next();
    });

    this.ctx.middleware(OnRoomPlayerReady, async (event, client, next) => {
      const state = event.room.recoverState;
      if (state?.seatReversed === undefined && client.startDeck) {
        const recordPlayer = this.findRecordPlayerForCurrentDeck(
          event.room,
          client,
          client.startDeck,
        );
        if (recordPlayer) {
          this.rememberRecoverSeat(event.room, recordPlayer.pos, client.pos);
        }
      }
      return next();
    });

    this.ctx.middleware(OnRoomPlayerUnready, async (event, _client, next) => {
      const state = event.room.recoverState;
      if (state) {
        if (!event.room.playingPlayers.some((player) => !!player.deck)) {
          state.seatReversed = undefined;
        }
      }
      return next();
    });

    this.ctx.middleware(OnRoomDuelStart, async (event, _client, next) => {
      if (event.room.recoverState) {
        await event.room.sendChat('#{recover_start_hint}', ChatColor.BABYBLUE);
      }
      return next();
    });

    this.ctx.middleware(OnRoomWin, async (event, _client, next) => {
      event.room.recoverState = undefined;
      return next();
    });

    this.ctx.middleware(YGOProStocGameMsg, async (msg, client, next) => {
      const room = this.findClientRoom(client);
      const state = room?.recoverState;
      if (!room || !state || !(msg.msg instanceof YGOProMsgResponseBase)) {
        return next();
      }

      const response = state.responses.shift();
      if (!response) {
        await this.finishRecover(room, false);
        return next();
      }

      setImmediate(() => {
        void this.dispatchRecoverResponse(room, client, response);
      });
      return;
    });

    this.ctx.middleware(YGOProMsgNewTurn, async (message, client, next) => {
      const room = this.findClientRoom(client);
      if (room?.recoverState) {
        await this.tryFinishRecoverAtNewTurn(room, message);
      }
      return next();
    });

    this.ctx.middleware(YGOProMsgNewPhase, async (message, client, next) => {
      const room = this.findClientRoom(client);
      if (room?.recoverState) {
        await this.tryFinishRecoverAtNewPhase(room, message);
      }
      return next();
    });

    this.ctx.middleware(YGOProMsgRetry, async (_message, client, _next) => {
      const room = this.findClientRoom(client);
      if (!room?.recoverState) {
        return _next();
      }
      await this.finishRecover(room, true);
      return;
    });
  }

  private parseRecoverGroups(regexResult: RegExpMatchArray) {
    const id = Number.parseInt(regexResult[1], 10);
    const turnCount = Number.parseInt(regexResult[2], 10);
    const phase = regexResult[3]?.toUpperCase() as
      | ReplayRecoverPhaseCode
      | undefined;
    if (
      !Number.isFinite(id) ||
      id <= 0 ||
      !Number.isFinite(turnCount) ||
      turnCount <= 0 ||
      (phase && !PHASE_VALUES[phase])
    ) {
      return undefined;
    }
    return {
      id,
      turnCount,
      phase,
    };
  }

  private resolveRecoverPassSegment(pass: string | undefined) {
    const normalized = (pass || '').trim();
    if (!normalized) {
      return '';
    }
    const [beforeRoomName] = normalized.split('#', 1);
    const [segment] = beforeRoomName.split(/[，,]/, 1);
    return segment || '';
  }

  private async findRecoverRecord(id: number) {
    try {
      return await this.cloudReplayService.findReplayById(id);
    } catch (error) {
      this.logger.warn({ id, error }, 'Failed loading recover replay');
      return undefined;
    }
  }

  private isAllowed(record: DuelRecordEntity, client: Client) {
    return !!this.findRecordPlayerForClient(record, client);
  }

  private findRecordPlayerForClient(record: DuelRecordEntity, client: Client) {
    return (record.players || []).find((player) =>
      this.isSameRecordPlayer(player, client),
    );
  }

  private findRecordPlayerForDeck(
    room: Room,
    client: Client,
    deck: YGOProDeck,
  ) {
    return this.findRecordPlayer(room, client, deck, (player) =>
      decodeDeckBase64(player.startDeckBuffer, player.startDeckMainc),
    );
  }

  private findRecordPlayerForCurrentDeck(
    room: Room,
    client: Client,
    deck: YGOProDeck,
  ) {
    return this.findRecordPlayer(room, client, deck, (player) =>
      decodeDeckBase64(player.currentDeckBuffer, player.currentDeckMainc),
    );
  }

  private findRecordPlayer(
    room: Room,
    client: Client,
    deck: YGOProDeck,
    resolveDeck: (player: DuelRecordPlayer) => YGOProDeck,
  ) {
    const state = room.recoverState;
    if (!state) {
      return undefined;
    }
    return (state.record.players || []).find((player) => {
      if (!this.isSameRecordPlayer(player, client)) {
        return false;
      }
      if (!this.isRecordSeatCompatible(room, player.pos, client.pos)) {
        return false;
      }
      return isUpdateDeckPayloadEqual(deck, resolveDeck(player));
    });
  }

  private isSameRecordPlayer(player: DuelRecordPlayer, client: Client) {
    return player.clientKey === this.getClientKey(client);
  }

  private getClientKey(client: Client) {
    return this.clientKeyProvider.getClientKey(client);
  }

  private isRecordSeatCompatible(
    room: Room,
    recordPos: number,
    currentPos: number,
  ) {
    const state = room.recoverState;
    if (!state) {
      return false;
    }
    if (room.getRelativePos(recordPos) !== room.getRelativePos(currentPos)) {
      return false;
    }

    const seatReversed = this.resolveSeatReversed(room, recordPos, currentPos);
    return (
      state.seatReversed === undefined || state.seatReversed === seatReversed
    );
  }

  private rememberRecoverSeat(
    room: Room,
    recordPos: number,
    currentPos: number,
  ) {
    const state = room.recoverState;
    if (!state) {
      return;
    }
    state.seatReversed = this.resolveSeatReversed(room, recordPos, currentPos);
  }

  private resolveSeatReversed(
    room: Room,
    recordPos: number,
    currentPos: number,
  ) {
    return room.getDuelPos(recordPos) !== room.getDuelPos(currentPos);
  }

  private restoreRecoverHostInfo(room: Room, hostInfo: HostInfo) {
    room.hostinfo.mode = this.replaceTagModeBit(
      room.hostinfo.mode,
      hostInfo.mode,
    );
    room.hostinfo.start_lp = hostInfo.start_lp;
    room.hostinfo.start_hand = hostInfo.start_hand;
    room.hostinfo.draw_count = hostInfo.draw_count;
  }

  private replaceTagModeBit(currentMode: number, recordMode: number) {
    return (currentMode & ~TAG_MODE_BIT) | (recordMode & TAG_MODE_BIT);
  }

  private mutateDeck(target: YGOProDeck, source: YGOProDeck) {
    target.main.splice(0, target.main.length, ...source.main);
    target.extra.splice(0, target.extra.length, ...source.extra);
    target.side.splice(0, target.side.length, ...source.side);
  }

  private resolveRecordFirstDuelPos(room: Room, record: DuelRecordEntity) {
    const firstPlayer = (record.players || []).find((player) => player.isFirst);
    if (!firstPlayer) {
      return undefined;
    }
    return room.getDuelPos(firstPlayer.pos);
  }

  private resolveRecoverFirstDuelPos(state: ReplayRecoverState) {
    if (state.firstDuelPos == null) {
      return undefined;
    }
    if (state.seatReversed === true) {
      return 1 - state.firstDuelPos;
    }
    return state.firstDuelPos;
  }

  private findClientRoom(client: Client) {
    return this.roomManager.findByName(client.roomName);
  }

  private async dispatchRecoverResponse(
    room: Room,
    client: Client,
    response: Buffer,
  ) {
    if (!room.recoverState) {
      return;
    }
    await this.ctx.dispatch(
      new YGOProCtosResponse().fromPartial({
        response,
      }),
      client,
    );
    if (!room.recoverState?.responses.length) {
      await this.finishRecover(room, false);
    }
  }

  private async tryFinishRecoverAtNewTurn(
    room: Room,
    _message: YGOProMsgNewTurn,
  ) {
    const state = room.recoverState;
    if (!state) {
      return;
    }
    if (state.spec.phase) {
      if (room.turnCount > state.spec.turnCount) {
        await this.finishRecover(room, false);
      }
      return;
    }
    if (room.turnCount >= state.spec.turnCount) {
      await this.finishRecover(room, false);
    }
  }

  private async tryFinishRecoverAtNewPhase(
    room: Room,
    message: YGOProMsgNewPhase,
  ) {
    const state = room.recoverState;
    if (!state) {
      return;
    }
    if (!state.spec.phase) {
      if (room.turnCount >= state.spec.turnCount) {
        await this.finishRecover(room, false);
      }
      return;
    }
    if (
      room.turnCount >= state.spec.turnCount &&
      message.phase >= PHASE_VALUES[state.spec.phase]
    ) {
      await this.finishRecover(room, false);
    }
  }

  private async finishRecover(room: Room, fail: boolean) {
    const state = room.recoverState;
    if (!state) {
      return;
    }
    room.recoverState = undefined;
    if (fail) {
      await room.sendChat('#{recover_fail}', ChatColor.RED);
      await room.finalize(true);
      return;
    }
    await room.sendChat('#{recover_success}', ChatColor.BABYBLUE);
  }
}
