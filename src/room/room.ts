import { Awaitable, MayBeArray, ProtoMiddlewareDispatcher } from 'nfkit';
import { Context } from '../app';
import BetterLock from 'better-lock';
import {
  HostInfo,
  NetPlayerType,
  PlayerChangeState,
  YGOProStocDuelStart,
  YGOProStocHsPlayerChange,
  YGOProStocHsWatchChange,
  YGOProStocJoinGame,
  YGOProCtosHsToObserver,
  YGOProCtosHsToDuelist,
  YGOProCtosKick,
  YGOProCtosHsNotReady,
  YGOProCtosHsStart,
  YGOProStocDeckCount,
  YGOProStocDeckCount_DeckInfo,
  YGOProStocSelectTp,
  YGOProStocSelectHand,
  ChatColor,
  YGOProCtosChat,
  YGOProMsgWin,
  YGOProCtosUpdateDeck,
  OcgcoreCommonConstants,
  YGOProStocErrorMsg,
  ErrorMessageType,
  YGOProStocGameMsg,
  YGOProStocReplay,
  YGOProStocDuelEnd,
  YGOProStocChangeSide,
  YGOProStocWaitingSide,
  YGOProCtosTpResult,
  TurnPlayerResult,
  YGOProCtosHandResult,
  YGOProStocHandResult,
  HandResult,
  YGOProMsgStart,
  YGOProMsgNewTurn,
  YGOProMsgNewPhase,
  YGOProMsgBase,
  YGOProMsgResponseBase,
  YGOProMsgRetry,
  YGOProMsgResetTime,
  RequireQueryLocation,
  RequireQueryCardLocation,
  YGOProMsgUpdateData,
  YGOProMsgUpdateCard,
  CardQuery,
  YGOProCtosResponse,
  YGOProCtosSurrender,
  YGOProCtosTimeConfirm,
  YGOProMsgWaiting,
  YGOProStocTimeLimit,
  YGOProMsgMatchKill,
} from 'ygopro-msg-encode';
import { DefaultHostInfoProvider } from './default-hostinfo-provder';
import {
  CardReaderFinalized,
  OcgcoreMessageType,
  _OcgcoreConstants,
} from 'koishipro-core.js';
import { YGOProResourceLoader } from './ygopro-resource-loader';
import { blankLFList } from '../utility/blank-lflist';
import { Client } from '../client';
import { RoomMethod } from '../utility/decorators';
import { YGOProCtosDisconnect } from '../utility/ygopro-ctos-disconnect';
import { DuelStage } from './duel-stage';
import { OnRoomJoin } from './room-event/on-room-join';
import { OnRoomLeave } from './room-event/on-room-leave';
import { OnRoomWin } from './room-event/on-room-win';
import { OnRoomJoinPlayer } from './room-event/on-room-join-player';
import { OnRoomJoinObserver } from './room-event/on-room-join-observer';
import { OnRoomLeavePlayer } from './room-event/on-room-leave-player';
import { OnRoomLeaveObserver } from './room-event/on-room-leave-observer';
import { OnRoomMatchStart } from './room-event/on-room-match-start';
import { OnRoomGameStart } from './room-event/on-room-game-start';
import YGOProDeck from 'ygopro-deck-encode';
import { checkDeck, checkChangeSide } from '../utility/check-deck';
import { DuelRecord } from './duel-record';
import { generateSeed } from '../utility/generate-seed';
import { OnRoomDuelStart } from './room-event/on-room-duel-start';
import { OcgcoreWorker } from '../ocgcore-worker/ocgcore-worker';
import { initWorker } from 'yuzuthread';
import {
  getZoneQueryFlag,
  splitRefreshLocations,
} from '../utility/refresh-query';
import { shuffleDecksBySeed } from '../utility/shuffle-decks-by-seed';
import { isUpdateMessage } from '../utility/is-update-message';
import { getMessageIdentifier } from '../utility/get-message-identifier';
import { canIncreaseTime } from '../utility/can-increase-time';
import { TimerState } from './timer-state';
import { makeArray } from 'aragami/dist/src/utility/utility';
import path from 'path';
import { OnRoomCreate } from './room-event/on-room-create';
import { OnRoomFinalize } from './room-event/on-room-finalize';
import { OnRoomSidingStart } from './room-event/on-room-siding-start';
import { OnRoomSidingReady } from './room-event/on-room-siding-ready';
import { OnRoomFinger } from './room-event/on-room-finger';
import { OnRoomSelectTp } from './room-event/on-room-select-tp';

const { OcgcoreScriptConstants } = _OcgcoreConstants;

export type RoomFinalizor = (self: Room) => Awaitable<any>;

export class Room {
  constructor(
    private ctx: Context,
    public name: string,
    private partialHostinfo: Partial<HostInfo> = {},
  ) {}

  private logger = this.ctx.createLogger(`Room:${this.name}`);

  hostinfo = this.ctx
    .get(() => DefaultHostInfoProvider)
    .parseHostinfo(this.name, this.partialHostinfo);

  get winMatchCount() {
    const firstbit = this.hostinfo.mode & 0x1;
    const remainingBits = (this.hostinfo.mode & 0xfc) >>> 1;
    return (firstbit | remainingBits) + 1;
  }

  get isTag() {
    return (this.hostinfo.mode & 0x2) !== 0;
  }

  noHost = false;
  players = new Array<Client | undefined>(this.isTag ? 4 : 2);
  watchers = new Set<Client>();
  get playingPlayers() {
    return this.players.filter((p) => p) as Client[];
  }
  get allPlayers() {
    return [...this.playingPlayers, ...this.watchers];
  }

  private get resourceLoader() {
    return this.ctx.get(() => YGOProResourceLoader);
  }
  private _cardReader?: CardReaderFinalized;
  private cardReaderLock = new BetterLock();
  private async getCardReader() {
    return this.cardReaderLock.acquire(async () => {
      if (!this._cardReader) {
        this._cardReader = await this.resourceLoader.getCardReader();
      }
      return this._cardReader;
    });
  }
  private lflist = blankLFList;

  private async findLFList() {
    const isTCG = this.hostinfo.rule === 1 && this.hostinfo.lflist === 0;
    let index = 0;
    for await (const lflist of this.resourceLoader.getLFLists()) {
      if (isTCG) {
        if (lflist.name?.includes(' TCG')) {
          return lflist;
        }
      } else {
        if (index === this.hostinfo.lflist) {
          return lflist;
        } else if (index > this.hostinfo.lflist) {
          return undefined;
        }
      }
      ++index;
    }
  }

  async init() {
    // Start loading cardReader in background (don't await)
    this.getCardReader();
    if (this.hostinfo.lflist >= 0) {
      this.lflist = (await this.findLFList()) || blankLFList;
    }
    await this.ctx.dispatch(new OnRoomCreate(this), undefined as any);
    return this;
  }

  private async cleanPlayers(sendDuelEnd = false) {
    await Promise.all([
      ...this.playingPlayers.map(async (p) => {
        await this.kick(p, sendDuelEnd);
        if (p.pos < NetPlayerType.OBSERVER) {
          this.players[p.pos] = undefined;
        }
      }),
      Promise.all(
        [...this.watchers].map(async (p) => await this.kick(p, sendDuelEnd)),
      ).then(() => this.watchers.clear()),
    ]);
  }

  private finalizors: RoomFinalizor[] = [() => this.disposeOcgcore()];

  addFinalizor(finalizor: RoomFinalizor, atEnd = false) {
    if (atEnd) {
      this.finalizors.unshift(finalizor);
    } else {
      this.finalizors.push(finalizor);
    }
    return this;
  }

  finalizing = false;
  async finalize(sendReplays = false) {
    if (this.finalizing) {
      return;
    }
    this.finalizing = true;
    this.resetResponseState();
    this.logger.debug(
      {
        playerCount: this.playingPlayers.length,
        watcherCount: this.watchers.size,
      },
      'Finalizing room',
    );
    await this.ctx.dispatch(new OnRoomFinalize(this), this.allPlayers[0]);
    await this.cleanPlayers(sendReplays);
    while (this.finalizors.length) {
      const finalizor = this.finalizors.pop()!;
      await finalizor(this);
    }
  }

  get joinGameMessage() {
    return new YGOProStocJoinGame().fromPartial({
      info: {
        ...this.hostinfo,
        lflist: this.lflist === blankLFList ? 0 : this.lflist.getHash(),
        mode:
          this.hostinfo.mode > 2 ? (this.isTag ? 2 : 1) : this.hostinfo.mode,
      },
    });
  }

  private get watcherSizeMessage() {
    return new YGOProStocHsWatchChange().fromPartial({
      watch_count: this.watchers.size,
    });
  }

  private resolvePos(clientOrPos: Client | number) {
    return typeof clientOrPos === 'number' ? clientOrPos : clientOrPos.pos;
  }

  getTeammates(clientOrPos: Client | number) {
    const pos = this.resolvePos(clientOrPos);
    if (pos === NetPlayerType.OBSERVER) {
      return [];
    }
    if (this.isTag) {
      const teamBit = (c: Client) => c.pos & 0x1;
      return this.playingPlayers.filter((p) => teamBit(p) === (pos & 0x1));
    }
    return [];
  }

  getOpponents(clientOrPos: Client | number) {
    const pos = this.resolvePos(clientOrPos);
    if (pos === NetPlayerType.OBSERVER) {
      return [];
    }
    const teammates = new Set<Client>(this.getTeammates(pos));
    return this.playingPlayers.filter((p) => !teammates.has(p));
  }

  private get teamOffsetBit() {
    return this.isTag ? 1 : 0;
  }

  getDuelPos(clientOrPos: Client | number) {
    const pos = this.resolvePos(clientOrPos);
    if (pos === NetPlayerType.OBSERVER) {
      return -1;
    }
    return (pos & (0x1 << this.teamOffsetBit)) >>> this.teamOffsetBit;
  }

  isPosSwapped = false;
  getIngamePos(clientOrPos: Client | number) {
    const pos = this.resolvePos(clientOrPos);
    if (pos === NetPlayerType.OBSERVER || !this.isPosSwapped) {
      return pos;
    }
    return pos ^ (0x1 << this.teamOffsetBit);
  }

  getIngameDuelPosByDuelPos(duelPos: number) {
    if ([0, 1].includes(duelPos) && this.isPosSwapped) {
      return 1 - duelPos;
    }
    return duelPos;
  }

  getIngameDuelPos(clientOrPos: Client | number) {
    const duelPos = this.getDuelPos(clientOrPos);
    return this.getIngameDuelPosByDuelPos(duelPos);
  }

  getDuelPosPlayers(duelPos: number) {
    if (duelPos === NetPlayerType.OBSERVER) {
      return [...this.watchers];
    }
    return this.playingPlayers.filter((p) => this.getDuelPos(p) === duelPos);
  }

  getIngameDuelPosPlayers(duelPos: number) {
    const swappedDuelPos = this.getIngameDuelPosByDuelPos(duelPos);
    return this.getDuelPosPlayers(swappedDuelPos);
  }

  private async sendPostWatchMessages(client: Client) {
    await client.send(new YGOProStocDuelStart());

    // 在 SelectHand / SelectTp 阶段发送 DeckCount
    // Siding 阶段不发 DeckCount
    if (
      this.duelStage === DuelStage.Finger ||
      this.duelStage === DuelStage.FirstGo
    ) {
      await client.send(this.prepareStocDeckCount(client.pos));
    }

    if (this.duelStage === DuelStage.Siding) {
      await client.send(new YGOProStocWaitingSide());
    } else if (this.duelStage === DuelStage.Dueling) {
      // Dueling 阶段不发 DeckCount，直接发送观战消息
      const observerMessages =
        this.lastDuelRecord?.messages.filter(
          (msg) =>
            !(msg instanceof YGOProMsgResponseBase) &&
            msg.getSendTargets().includes(NetPlayerType.OBSERVER),
        ) || [];
      for (const message of observerMessages) {
        await client.send(
          new YGOProStocGameMsg().fromPartial({
            msg: message.observerView(),
          }),
        );
      }
    }
  }

  async join(client: Client) {
    client.roomName = this.name;
    client.isHost = this.noHost ? false : !this.allPlayers.length;
    const firstEmptyPlayerSlot = this.players.findIndex((p) => !p);
    const isPlayer =
      firstEmptyPlayerSlot >= 0 && this.duelStage === DuelStage.Begin;

    if (isPlayer) {
      this.players[firstEmptyPlayerSlot] = client;
      client.pos = firstEmptyPlayerSlot;
    } else {
      this.watchers.add(client);
      client.pos = NetPlayerType.OBSERVER;
    }

    // send to client
    await client.send(this.joinGameMessage);
    await client.sendTypeChange();
    for (const p of this.playingPlayers) {
      await client.send(p.prepareEnterPacket());
      if (p.deck) {
        await client.send(p.prepareChangePacket());
      }
    }
    if (this.watchers.size && this.duelStage === DuelStage.Begin) {
      await client.send(this.watcherSizeMessage);
    }

    // send to other players
    if (isPlayer) {
      const enterMessage = client.prepareEnterPacket();
      await Promise.all(
        this.allPlayers
          .filter((p) => p !== client)
          .map((p) => p.send(enterMessage)),
      );
    } else if (this.watchers.size && this.duelStage === DuelStage.Begin) {
      await client.send(this.watcherSizeMessage);
    }

    await this.ctx.dispatch(new OnRoomJoin(this), client);

    // 触发具体的加入事件
    if (isPlayer) {
      await this.ctx.dispatch(new OnRoomJoinPlayer(this), client);
    } else {
      await this.ctx.dispatch(new OnRoomJoinObserver(this), client);
    }

    if (this.duelStage !== DuelStage.Begin) {
      await this.sendPostWatchMessages(client);
    }

    return undefined;
  }

  duelStage = DuelStage.Begin;
  duelRecords: DuelRecord[] = [];
  private overrideScore?: [number | undefined, number | undefined];

  setOverrideScore(duelPos: 0 | 1, value: number) {
    this.overrideScore = this.overrideScore || [undefined, undefined];
    this.overrideScore[duelPos] = value;
  }

  get score() {
    const score: [number, number] = [0, 0];
    for (const duelRecord of this.duelRecords) {
      if (duelRecord.winPosition === 0 || duelRecord.winPosition === 1) {
        score[duelRecord.winPosition] += 1;
      }
    }
    for (const duelPos of [0, 1] as const) {
      const override = this.overrideScore?.[duelPos];
      if (override != null) {
        score[duelPos] = override;
      }
    }
    return score;
  }

  private async sendReplays(client: Client) {
    if (client.isInternal) {
      return;
    }
    for (let i = 0; i < this.duelRecords.length; i++) {
      const duelRecord = this.duelRecords[i];
      await client.sendChat(
        `#{replay_hint_part1}${i + 1}#{replay_hint_part2}`,
        ChatColor.BABYBLUE,
      );
      await client.send(
        new YGOProStocReplay().fromPartial({
          replay: duelRecord.toYrp(this),
        }),
      );
    }
  }

  private async changeSide() {
    if (this.duelStage === DuelStage.Siding) {
      return;
    }
    this.duelStage = DuelStage.Siding;
    for (const p of this.playingPlayers) {
      p.deck = undefined;
      p.send(new YGOProStocChangeSide());
    }
    for (const p of this.watchers) {
      p.send(new YGOProStocWaitingSide());
    }
    await this.ctx.dispatch(
      new OnRoomSidingStart(this),
      this.playingPlayers[0],
    );
  }

  get lastDuelRecord() {
    return this.duelRecords[this.duelRecords.length - 1];
  }

  private disposeOcgcore() {
    try {
      this.ocgcore?.dispose().catch();
      this.ocgcore = undefined;
    } catch {}
  }

  async win(winMsg: Partial<YGOProMsgWin>, forceWinMatch?: number) {
    this.resetResponseState();
    this.disposeOcgcore();
    this.ocgcore = undefined;
    if (this.duelStage === DuelStage.Siding) {
      await Promise.all(
        this.playingPlayers
          .filter((p) => !p.deck)
          .map((p) => p.send(new YGOProStocDuelStart())),
      );
    }
    const duelPos = this.getIngameDuelPosByDuelPos(winMsg.player!);
    this.isPosSwapped = false;
    await Promise.all(
      this.allPlayers.map((p) =>
        p.send(
          new YGOProStocGameMsg().fromPartial({
            msg: new YGOProMsgWin().fromPartial(winMsg),
          }),
        ),
      ),
    );
    const exactWinMsg = new YGOProMsgWin().fromPartial({
      ...winMsg,
      player: duelPos,
    });
    const lastDuelRecord = this.lastDuelRecord;
    if (lastDuelRecord) {
      lastDuelRecord.winPosition = duelPos;
    }
    if (typeof forceWinMatch === 'number') {
      const loseDuelPos = (1 - duelPos) as 0 | 1;
      this.setOverrideScore(loseDuelPos, -Math.abs(forceWinMatch));
    }
    const score = this.score;
    this.logger.debug(
      `Player ${duelPos} wins the duel. Current score: ${score.join('-')}`,
    );
    const winMatch =
      forceWinMatch != null || score[duelPos] >= this.winMatchCount;
    if (!winMatch) {
      await this.changeSide();
    }
    await this.ctx.dispatch(
      new OnRoomWin(this, exactWinMsg, winMatch),
      this.getDuelPosPlayers(duelPos)[0],
    );
    if (winMatch) {
      return this.finalize(true);
    }
  }

  async kick(client: Client, sendDuelEnd = false) {
    await this.sendReplays(client);
    if (
      sendDuelEnd &&
      this.duelStage !== DuelStage.Begin &&
      // don't send duel end when client didn't finish siding
      !(
        this.duelStage === DuelStage.Siding &&
        !client.deck &&
        client.pos < NetPlayerType.OBSERVER
      )
    ) {
      await client.send(new YGOProStocDuelEnd());
    }
    return client.disconnect();
  }

  @RoomMethod()
  private async onDisconnect(client: Client, _msg: YGOProCtosDisconnect) {
    if (this.finalizing) {
      return;
    }
    const wasObserver = client.pos === NetPlayerType.OBSERVER;
    const oldPos = client.pos;

    if (wasObserver) {
      this.watchers.delete(client);
      for (const p of this.allPlayers) {
        p.send(this.watcherSizeMessage);
      }
    } else if (this.duelStage === DuelStage.Begin) {
      this.players[client.pos] = undefined;
      this.allPlayers.forEach((p) => {
        p.send(client.prepareChangePacket(PlayerChangeState.LEAVE));
      });
    } else {
      await this.win(
        { player: 1 - this.getIngameDuelPos(client), type: 0x4 },
        9,
      );
    }
    if (client.isHost) {
      const nextHost = this.allPlayers.find((p) => p !== client);
      if (nextHost) {
        nextHost.isHost = true;
        await nextHost.sendTypeChange();
        // 如果游戏还在准备阶段，重置新房主的准备状态
        if (this.duelStage === DuelStage.Begin && nextHost.deck) {
          nextHost.deck = undefined;
          // 发送 PlayerChange NOTREADY 给所有人
          await Promise.all(
            this.allPlayers.map((p) =>
              p.send(nextHost.prepareChangePacket(PlayerChangeState.NOTREADY)),
            ),
          );
        }
      }
    }

    await this.ctx.dispatch(new OnRoomLeave(this), client);

    // 触发具体的离开事件
    if (wasObserver) {
      await this.ctx.dispatch(new OnRoomLeaveObserver(this), client);
    } else {
      await this.ctx.dispatch(new OnRoomLeavePlayer(this, oldPos), client);
    }

    client.roomName = undefined;

    if (!this.allPlayers.find((p) => !p.isInternal)) {
      return this.finalize();
    }
  }

  @RoomMethod()
  private async onToObserver(client: Client, _msg: YGOProCtosHsToObserver) {
    // 游戏已经开始，不允许切换
    if (this.duelStage !== DuelStage.Begin) {
      return;
    }

    // 如果已经是观战者，直接返回
    if (client.pos === NetPlayerType.OBSERVER) {
      return;
    }

    // 保存原位置
    const oldPos = client.pos;

    // 发送 PlayerChange 给所有人
    const changeMsg = new YGOProStocHsPlayerChange().fromPartial({
      playerPosition: oldPos,
      playerState: PlayerChangeState.OBSERVE,
    });
    this.allPlayers.forEach((p) => p.send(changeMsg));

    // 从 players 移除
    this.players[client.pos] = undefined;
    client.pos = NetPlayerType.OBSERVER;

    // 添加到观战者
    this.watchers.add(client);

    // 发送 TypeChange 给客户端
    await client.sendTypeChange();

    // 发送观战者数量更新
    this.allPlayers.forEach((p) => p.send(this.watcherSizeMessage));

    // 触发事件
    await this.ctx.dispatch(new OnRoomLeavePlayer(this, oldPos), client);
    await this.ctx.dispatch(new OnRoomJoinObserver(this), client);
  }

  @RoomMethod()
  private async onToDuelist(client: Client, _msg: YGOProCtosHsToDuelist) {
    // 游戏已经开始，不允许切换
    if (this.duelStage !== DuelStage.Begin) {
      return;
    }

    // 查找空位
    const firstEmptyPlayerSlot = this.players.findIndex((p) => !p);
    if (firstEmptyPlayerSlot < 0) {
      // 没有空位
      return;
    }

    if (client.pos === NetPlayerType.OBSERVER) {
      // 从观战者切换到玩家
      this.watchers.delete(client);

      // 添加到玩家
      this.players[firstEmptyPlayerSlot] = client;
      client.pos = firstEmptyPlayerSlot;

      // 发送 PlayerEnter 给所有人
      const enterMsg = client.prepareEnterPacket();
      this.allPlayers.forEach((p) => p.send(enterMsg));

      // 发送 TypeChange 给客户端
      await client.sendTypeChange();

      // 发送观战者数量更新
      this.allPlayers.forEach((p) => p.send(this.watcherSizeMessage));

      // 触发事件
      await this.ctx.dispatch(new OnRoomLeaveObserver(this), client);
      await this.ctx.dispatch(new OnRoomJoinPlayer(this), client);
    } else if (this.isTag) {
      // TAG 模式下，已经是玩家，切换到另一个空位
      // 如果已经 ready，不允许切换
      if (client.deck) {
        return;
      }

      const oldPos = client.pos;

      // 从当前位置的下一个位置开始循环查找空位
      let nextPos = (oldPos + 1) % 4;
      while (this.players[nextPos]) {
        nextPos = (nextPos + 1) % 4;
      }

      // 移动到新位置
      this.players[oldPos] = undefined;
      this.players[nextPos] = client;
      client.pos = nextPos;

      // 发送 PlayerChange 给所有人
      const changeMsg = new YGOProStocHsPlayerChange().fromPartial({
        playerPosition: oldPos,
        playerState: nextPos,
      });
      this.allPlayers.forEach((p) => p.send(changeMsg));

      // 发送 TypeChange 给客户端
      await client.sendTypeChange();

      // 触发事件 (玩家切换位置)
      await this.ctx.dispatch(new OnRoomLeavePlayer(this, oldPos), client);
      await this.ctx.dispatch(new OnRoomJoinPlayer(this), client);
    }
  }

  @RoomMethod()
  private async onKick(client: Client, msg: YGOProCtosKick) {
    // 游戏已经开始，不允许踢人
    if (this.duelStage !== DuelStage.Begin) {
      return;
    }

    // 只有 host 可以踢人
    if (!client.isHost) {
      return;
    }

    // 不能踢自己
    if (client.pos === msg.pos) {
      return;
    }

    // 获取要踢的玩家
    const targetPlayer = this.players[msg.pos];
    if (!targetPlayer) {
      return;
    }

    // 踢出玩家
    return this.kick(targetPlayer);
  }

  @RoomMethod({ allowInDuelStages: [DuelStage.Begin, DuelStage.Siding] })
  private async onUpdateDeck(client: Client, msg: YGOProCtosUpdateDeck) {
    // 只有玩家可以更新卡组
    if (client.pos === NetPlayerType.OBSERVER) {
      return;
    }

    // 已经 ready（有 deck）的玩家不能再更新
    if (client.deck) {
      return;
    }

    const deck = new YGOProDeck({
      main: [],
      extra: [],
      side: msg.deck.side,
    });
    // we have to distinguish main and extra deck cards
    const cardReader = await this.getCardReader();
    for (const card of msg.deck.main) {
      const cardEntry = cardReader.apply(card);
      if (
        cardEntry?.type &&
        cardEntry.type & OcgcoreCommonConstants.TYPES_EXTRA_DECK
      ) {
        deck.extra.push(card);
      } else {
        deck.main.push(card);
      }
    }

    // Check deck based on stage
    if (this.duelStage === DuelStage.Begin) {
      // Begin stage: check deck validity (lflist, etc.) if no_check_deck is false
      if (!this.hostinfo.no_check_deck) {
        const deckError = checkDeck(deck, cardReader, {
          ot: this.hostinfo.rule,
          lflist: this.lflist,
          minMain: this.ctx.config.getInt('DECK_MAIN_MIN'),
          maxMain: this.ctx.config.getInt('DECK_MAIN_MAX'),
          maxExtra: this.ctx.config.getInt('DECK_EXTRA_MAX'),
          maxSide: this.ctx.config.getInt('DECK_SIDE_MAX'),
          maxCopies: this.ctx.config.getInt('DECK_MAX_COPIES'),
        });

        this.logger.debug(
          {
            deckError,
            name: client.name,
            deckErrorPayload: deckError?.toPayload(),
          },
          'Deck check result',
        );

        if (deckError) {
          // 先发送 PlayerChange NotReady 给自己 (client.deck 未设置，自动为 NOTREADY)
          await client.send(client.prepareChangePacket());
          // 然后发送错误消息给自己
          await client.send(
            new YGOProStocErrorMsg().fromPartial({
              msg: ErrorMessageType.DECKERROR,
              code: deckError.toPayload(),
            }),
          );
          return;
        }
      }
    } else if (this.duelStage === DuelStage.Siding) {
      // Siding stage: ALWAYS check if cards match original deck (无条件检查)
      if (!client.startDeck) {
        return;
      }

      if (!checkChangeSide(client.startDeck, deck)) {
        await client.send(
          new YGOProStocErrorMsg().fromPartial({
            msg: ErrorMessageType.SIDEERROR,
            code: 0,
          }),
        );
        return;
      }
    }

    // Save deck
    client.deck = deck;

    // In Begin stage, also save as startDeck for side deck checking
    if (this.duelStage === DuelStage.Begin) {
      client.startDeck = deck;

      // Auto-ready: send PlayerChange READY to all players (client.deck 已设置，自动为 READY)
      const changeMsg = client.prepareChangePacket();
      this.allPlayers.forEach((p) => p.send(changeMsg));
      if (this.noHost) {
        const allReadyAndFull = this.players.every((player) => !!player?.deck);
        if (allReadyAndFull) {
          await this.startGame();
        }
      }
    } else if (this.duelStage === DuelStage.Siding) {
      // In Siding stage, send DUEL_START to the player who submitted deck
      // Siding 阶段不发 DeckCount
      client.send(new YGOProStocDuelStart());
      await this.ctx.dispatch(new OnRoomSidingReady(this), client);

      // Check if all players have submitted their decks
      const allReady = this.playingPlayers.every((p) => p.deck);
      if (allReady) {
        return this.startGame(
          this.duelRecords[this.duelRecords.length - 1]?.winPosition,
        );
      }
    }
  }

  @RoomMethod({ allowInDuelStages: DuelStage.Begin })
  private async onUnready(client: Client, _msg: YGOProCtosHsNotReady) {
    // 只有玩家可以取消准备
    if (client.pos === NetPlayerType.OBSERVER) {
      return;
    }

    // 清除 deck
    client.deck = undefined;
    client.startDeck = undefined;

    // 发送 PlayerChange 给所有人 (client.deck 已清除，自动为 NOTREADY)
    const changeMsg = client.prepareChangePacket();
    this.allPlayers.forEach((p) => p.send(changeMsg));
  }

  @RoomMethod({ allowInDuelStages: DuelStage.Begin })
  private async onHsStart(client: Client, _msg: YGOProCtosHsStart) {
    // 只有房主可以开始游戏
    if (!client.isHost) {
      return;
    }

    // 检查所有玩家是否都 ready
    const allReady = this.playingPlayers.every((p) => p.deck);
    if (!allReady) {
      return;
    }

    // 开始游戏（startGame 会自动转到 Finger 阶段）
    await this.startGame();
  }

  @RoomMethod()
  private async onChat(client: Client, msg: YGOProCtosChat) {
    return this.sendChat(msg.msg, this.getIngamePos(client));
  }

  async sendChat(msg: string, type: number = ChatColor.BABYBLUE) {
    return Promise.all(this.allPlayers.map((p) => p.sendChat(msg, type)));
  }

  firstgoPos?: number;
  handResult = [0, 0];

  prepareStocDeckCount(pos: number) {
    const toDeckCount = (d: YGOProDeck | undefined) => {
      const res = new YGOProStocDeckCount_DeckInfo();
      if (!d) {
        res.main = 0;
        res.extra = 0;
        res.side = 0;
      } else {
        res.main = d.main.length;
        res.extra = d.extra.length;
        res.side = d.side.length;
      }
      return res;
    };

    const displayCountDecks: (YGOProDeck | undefined)[] = [0, 1].map((p) => {
      const player = this.getDuelPosPlayers(p)[0];
      // 优先使用 deck，如果不存在则使用 startDeck 兜底
      return player?.deck || player?.startDeck;
    });

    // 如果是观战者或者其他特殊位置，直接按顺序显示
    if (pos >= NetPlayerType.OBSERVER) {
      return new YGOProStocDeckCount().fromPartial({
        player0DeckCount: toDeckCount(displayCountDecks[0]),
        player1DeckCount: toDeckCount(displayCountDecks[1]),
      });
    }

    // 对于玩家，自己的卡组在前，对方的在后
    const duelPos = this.getDuelPos(pos);
    const selfDeck = displayCountDecks[duelPos];
    const otherDeck = displayCountDecks[1 - duelPos];

    return new YGOProStocDeckCount().fromPartial({
      player0DeckCount: toDeckCount(selfDeck),
      player1DeckCount: toDeckCount(otherDeck),
    });
  }

  private async toFirstGo(firstgoPos: number) {
    this.firstgoPos = firstgoPos;
    this.duelStage = DuelStage.FirstGo;
    const firstgoPlayer = this.getDuelPosPlayers(firstgoPos)[0];
    if (!firstgoPlayer) {
      return;
    }
    firstgoPlayer.send(new YGOProStocSelectTp());
    await this.ctx.dispatch(
      new OnRoomSelectTp(this, firstgoPlayer),
      firstgoPlayer,
    );
  }

  private async toFinger() {
    this.duelStage = DuelStage.Finger;
    // 只有每方的第一个玩家猜拳
    const duelPos0 = this.getDuelPosPlayers(0)[0];
    const duelPos1 = this.getDuelPosPlayers(1)[0];
    if (!duelPos0 || !duelPos1) {
      return;
    }
    duelPos0.send(new YGOProStocSelectHand());
    duelPos1.send(new YGOProStocSelectHand());
    await this.ctx.dispatch(
      new OnRoomFinger(this, [duelPos0, duelPos1]),
      duelPos0,
    );
  }

  @RoomMethod({ allowInDuelStages: DuelStage.Finger })
  private async onHandResult(client: Client, msg: YGOProCtosHandResult) {
    // 检查 res 是否有效
    if (msg.res < HandResult.ROCK || msg.res > HandResult.PAPER) {
      return;
    }

    // 获取客户端的对战位置（0 或 1）
    const duelPos = this.getDuelPos(client);
    if (duelPos < 0 || duelPos > 1) {
      return;
    }

    // 保存猜拳结果
    this.handResult[duelPos] = msg.res;

    // 检查是否两个玩家都已出拳
    if (!this.handResult[0] || !this.handResult[1]) {
      return;
    }

    // 发送猜拳结果给玩家 0 及其队友（自己的结果在前）
    const result0 = new YGOProStocHandResult().fromPartial({
      res1: this.handResult[0],
      res2: this.handResult[1],
    });
    this.getDuelPosPlayers(0).forEach((p) => p.send(result0));
    // 也发送给观众（观众看到的是玩家0的视角）
    this.watchers.forEach((w) => w.send(result0));

    // 发送猜拳结果给玩家 1 及其队友（自己的结果在前）
    const result1 = new YGOProStocHandResult().fromPartial({
      res1: this.handResult[1],
      res2: this.handResult[0],
    });
    this.getDuelPosPlayers(1).forEach((p) => p.send(result1));

    // 如果平局，重新猜拳
    if (this.handResult[0] === this.handResult[1]) {
      this.handResult = [0, 0];
      await this.toFinger();
      return;
    }

    // 判断谁赢了（按照 C++ 的逻辑）
    let winnerPos: number;
    if (
      (this.handResult[0] === 1 && this.handResult[1] === 2) ||
      (this.handResult[0] === 2 && this.handResult[1] === 3) ||
      (this.handResult[0] === 3 && this.handResult[1] === 1)
    ) {
      // 玩家 1 赢了，玩家 1 选先后攻
      winnerPos = 1;
    } else {
      // 玩家 0 赢了，玩家 0 选先后攻
      winnerPos = 0;
    }

    // 清空猜拳结果
    this.handResult = [0, 0];

    // 进入先后攻选择阶段
    await this.toFirstGo(winnerPos);
  }

  async startGame(firstgoPos?: number) {
    if (![DuelStage.Begin, DuelStage.Siding].includes(this.duelStage)) {
      return false;
    }
    if (this.playingPlayers.some((p) => !p.deck)) {
      return false;
    }

    if (this.duelRecords.length === 0) {
      this.allPlayers.forEach((p) => {
        p.send(new YGOProStocDuelStart());
        p.send(this.prepareStocDeckCount(p.pos));
      });
    }

    if (firstgoPos != null && firstgoPos >= 0 && firstgoPos <= 1) {
      await this.toFirstGo(firstgoPos);
    } else {
      await this.toFinger();
    }

    // 触发事件
    if (this.duelRecords.length === 0) {
      // 触发比赛开始事件（第一局）
      await this.ctx.dispatch(
        new OnRoomMatchStart(this),
        this.playingPlayers[0],
      );
    }

    // 触发游戏开始事件（每局游戏）
    await this.ctx.dispatch(new OnRoomGameStart(this), this.playingPlayers[0]);

    return true;
  }

  ocgcore?: OcgcoreWorker;
  private registry: Record<string, string> = {};
  turnCount = 0;
  turnIngamePos = 0;
  phase = undefined;
  timerState = new TimerState();
  lastResponseRequestMsg?: YGOProMsgResponseBase;
  isRetrying = false;
  private get hasTimeLimit() {
    return this.hostinfo.time_limit > 0;
  }

  private resetResponseRequestState() {
    const initialTime = this.hasTimeLimit
      ? Math.max(0, this.hostinfo.time_limit) * 1000
      : 0;
    this.timerState.reset(initialTime);
    this.lastResponseRequestMsg = undefined;
    this.isRetrying = false;
  }

  private clearResponseTimer(settleElapsed = false) {
    this.timerState.clear(settleElapsed);
  }

  private resetResponseState(options: { timedOutPlayer?: number } = {}) {
    this.clearResponseTimer();
    if (
      options.timedOutPlayer != null &&
      [0, 1].includes(options.timedOutPlayer)
    ) {
      this.timerState.leftMs[options.timedOutPlayer] = 0;
    }
    this.responsePos = undefined;
  }

  private increaseResponseTime(
    originalDuelPos: number,
    gameMsg: number,
    response?: Buffer,
  ) {
    const maxTimeMs = Math.max(0, this.hostinfo.time_limit || 0) * 1000;
    if (
      !this.hasTimeLimit ||
      ![0, 1].includes(originalDuelPos) ||
      this.timerState.backedMs[originalDuelPos] <= 0 ||
      this.timerState.leftMs[originalDuelPos] >= maxTimeMs ||
      !canIncreaseTime(gameMsg, response)
    ) {
      return;
    }
    this.timerState.leftMs[originalDuelPos] = Math.min(
      maxTimeMs,
      this.timerState.leftMs[originalDuelPos] + 1000,
    );
    this.timerState.compensatorMs[originalDuelPos] += 1000;
    this.timerState.backedMs[originalDuelPos] -= 1000;
  }

  private async sendTimeLimit(originalDuelPos: number) {
    if (!this.hasTimeLimit || ![0, 1].includes(originalDuelPos)) {
      return;
    }
    const leftTime = Math.max(0, this.timerState.leftMs[originalDuelPos] || 0);
    const ingameDuelPos = this.getIngameDuelPosByDuelPos(originalDuelPos);
    const msg = new YGOProStocTimeLimit().fromPartial({
      player: ingameDuelPos,
      left_time: Math.ceil(leftTime / 1000),
    });
    await Promise.all(this.playingPlayers.map((p) => p.send(msg)));
  }

  private async onResponseTimeout(originalDuelPos: number) {
    if (this.timerState.runningPos !== originalDuelPos || this.finalizing) {
      return;
    }
    this.resetResponseState({ timedOutPlayer: originalDuelPos });
    const winnerOriginalDuelPos = 1 - originalDuelPos;
    await this.win({
      player: this.getIngameDuelPosByDuelPos(winnerOriginalDuelPos),
      type: 0x3,
    });
  }

  private async setResponseTimer(
    originalDuelPos: number,
    options: {
      settlePrevious?: boolean;
      sendTimeLimit?: boolean;
      awaitingConfirm?: boolean;
    } = {},
  ) {
    const {
      settlePrevious = true,
      sendTimeLimit = true,
      awaitingConfirm = true,
    } = options;
    this.clearResponseTimer(settlePrevious);
    if (!this.hasTimeLimit || ![0, 1].includes(originalDuelPos)) {
      return;
    }
    const leftTime = Math.max(0, this.timerState.leftMs[originalDuelPos] || 0);
    if (sendTimeLimit) {
      await this.sendTimeLimit(originalDuelPos);
    }
    if (leftTime <= 0) {
      return this.onResponseTimeout(originalDuelPos);
    }
    this.timerState.schedule(originalDuelPos, leftTime, awaitingConfirm, () => {
      void this.onResponseTimeout(originalDuelPos).catch((error) => {
        this.logger.warn({ error }, 'Failed to handle response timeout');
      });
    });
  }

  private async handleResetTime(message: YGOProMsgResetTime) {
    const player = this.getIngameDuelPosByDuelPos(message.player);
    if (!this.hasTimeLimit || ![0, 1].includes(player)) {
      return;
    }
    this.timerState.leftMs[player] = message.time
      ? message.time * 1000
      : Math.max(0, this.hostinfo.time_limit) * 1000;
    if (this.timerState.runningPos === player) {
      await this.setResponseTimer(player, {
        settlePrevious: false,
        sendTimeLimit: false,
        awaitingConfirm: this.timerState.awaitingConfirm,
      });
    }
  }

  @RoomMethod({ allowInDuelStages: DuelStage.FirstGo })
  private async onDuelStart(client: Client, msg: YGOProCtosTpResult) {
    // 检查是否是该玩家选先后手（duelPos 的第一个玩家）
    const duelPos = this.getDuelPos(client);
    if (duelPos !== this.firstgoPos) {
      return;
    }
    const firstgoPlayers = this.getDuelPosPlayers(duelPos);
    if (client !== firstgoPlayers[0]) {
      return;
    }
    this.isPosSwapped =
      (msg.res === TurnPlayerResult.FIRST) !== (this.getDuelPos(client) === 0);
    const duelRecord = new DuelRecord(
      generateSeed(),
      this.playingPlayers.map((p) => ({ name: p.name, deck: p.deck! })),
    );
    if (this.isPosSwapped) {
      this.playingPlayers.forEach((p) => {
        // Keep full seat order (0/1/2/3 in tag), matching tag_duel.cpp swap:
        // swap(0,2) and swap(1,3)
        duelRecord.players[this.getIngamePos(p)] = {
          name: p.name,
          deck: p.deck!,
        };
      });
    }
    if (!this.hostinfo.no_shuffle_deck) {
      const shuffledDecks = shuffleDecksBySeed(
        duelRecord.players.map((p) => p.deck),
        duelRecord.seed,
      );
      duelRecord.players = duelRecord.players.map((player, index) => ({
        ...player,
        deck: shuffledDecks[index],
      }));
    }
    this.duelRecords.push(duelRecord);

    const extraScriptPaths = [
      './script/patches/entry.lua',
      './script/special.lua',
      './script/init.lua',
      ...this.resourceLoader.extraScriptPaths,
    ];

    const isMatchMode = this.winMatchCount > 1;
    const duelMode = this.isTag ? 'tag' : isMatchMode ? 'match' : 'single';
    const registry: Record<string, string> = {
      ...this.registry,
      duel_mode: duelMode,
      start_lp: String(this.hostinfo.start_lp),
      start_hand: String(this.hostinfo.start_hand),
      draw_count: String(this.hostinfo.draw_count),
      player_type_0: this.isPosSwapped ? '1' : '0',
      player_type_1: this.isPosSwapped ? '0' : '1',
    };
    if (isMatchMode) {
      // Match mode uses completed duel count in gframe (before current duel result).
      registry.duel_count = String(this.duelRecords.length - 1);
    }
    duelRecord.players.forEach((player, i) => {
      registry[`player_name_${i}`] = player.name;
    });

    this.logger.debug(
      { seed: duelRecord.seed, registry, hostinfo: this.hostinfo },
      'Initializing OCGCoreWorker',
    );

    const ocgcoreWasmPathConfig =
      this.ctx.config.getString('OCGCORE_WASM_PATH');
    const ocgcoreWasmPath = ocgcoreWasmPathConfig
      ? path.resolve(process.cwd(), ocgcoreWasmPathConfig)
      : undefined;

    this.ocgcore = await initWorker(OcgcoreWorker, {
      seed: duelRecord.seed,
      hostinfo: this.hostinfo,
      ygoproPaths: this.resourceLoader.ygoproPaths,
      extraScriptPaths,
      ocgcoreWasmPath,
      registry,
      decks: duelRecord.players.map((p) => p.deck),
    });

    const [
      player0DeckCount,
      player0ExtraCount,
      player1DeckCount,
      player1ExtraCount,
    ] = await Promise.all([
      this.ocgcore.queryFieldCount({
        player: 0,
        location: OcgcoreScriptConstants.LOCATION_DECK,
      }),
      this.ocgcore.queryFieldCount({
        player: 0,
        location: OcgcoreScriptConstants.LOCATION_EXTRA,
      }),
      this.ocgcore.queryFieldCount({
        player: 1,
        location: OcgcoreScriptConstants.LOCATION_DECK,
      }),
      this.ocgcore.queryFieldCount({
        player: 1,
        location: OcgcoreScriptConstants.LOCATION_EXTRA,
      }),
    ]);

    const createStartMsg = (playerType: number) =>
      new YGOProStocGameMsg().fromPartial({
        msg: new YGOProMsgStart().fromPartial({
          playerType,
          duelRule: this.hostinfo.duel_rule,
          startLp0: this.hostinfo.start_lp,
          startLp1: this.hostinfo.start_lp,
          player0: {
            deckCount: player0DeckCount,
            extraCount: player0ExtraCount,
          },
          player1: {
            deckCount: player1DeckCount,
            extraCount: player1ExtraCount,
          },
        }),
      });

    const duelPos0Clients = this.getIngameDuelPosPlayers(0);
    const duelPos1Clients = this.getIngameDuelPosPlayers(1);
    const watcherMsg = createStartMsg(this.isPosSwapped ? 0x11 : 0x10);
    await Promise.all([
      ...duelPos0Clients.map((p) => p.send(createStartMsg(0))),
      ...duelPos1Clients.map((p) => p.send(createStartMsg(1))),
      ...[...this.watchers].map((p) => p.send(watcherMsg)),
    ]);

    this.duelStage = DuelStage.Dueling;

    this.ocgcore.message$.subscribe((msg) => {
      if (
        msg.type === OcgcoreMessageType.DebugMessage &&
        !this.ctx.config.getBoolean('OCGCORE_DEBUG_LOG')
      ) {
        return;
      }
      this.allPlayers.forEach((p) => p.sendChat(`Debug: ${msg.message}`));
    });
    this.ocgcore.registry$.subscribe((registry) => {
      Object.assign(this.registry, registry);
    });

    this.turnCount = 0;
    this.turnIngamePos = 0;
    this.phase = undefined;
    this.resetResponseRequestState();

    await this.dispatchGameMsg(watcherMsg.msg);
    await this.ctx.dispatch(
      new OnRoomDuelStart(this),
      this.getIngameOperatingPlayer(this.turnIngamePos),
    );

    await Promise.all([
      this.refreshLocations({
        player: 0,
        location: OcgcoreScriptConstants.LOCATION_EXTRA,
      }),
      this.refreshLocations({
        player: 1,
        location: OcgcoreScriptConstants.LOCATION_EXTRA,
      }),
    ]);

    return this.advance();
  }

  private async onNewTurn(tp: number) {
    ++this.turnCount;
    this.turnIngamePos = tp;
    if (!this.hasTimeLimit) {
      return;
    }
    const recoverMs = Math.max(0, this.hostinfo.time_limit) * 1000;
    for (const player of [0, 1] as const) {
      this.timerState.leftMs[player] = recoverMs;
      this.timerState.compensatorMs[player] = recoverMs;
      this.timerState.backedMs[player] = recoverMs;
    }
  }

  private async onNewPhase(phase: number) {
    this.phase = phase;
  }

  getIngameOperatingPlayer(ingameDuelPos: number): Client | undefined {
    const players = this.getIngameDuelPosPlayers(ingameDuelPos);
    if (!this.isTag) {
      return players[0];
    }
    if (players.length === 1) {
      return players[0];
    }

    // tag_duel.cpp cur_player equivalent, computed from turnCount:
    // duelPos 0: start from players[0], toggle every two turns from turn 3
    // duelPos 1: start from players[1], toggle every two turns from turn 2
    const tc = Math.max(0, this.turnCount);
    if (ingameDuelPos === 0) {
      const idx = Math.floor(Math.max(0, tc - 1) / 2) % 2;
      return players[idx];
    }
    if (ingameDuelPos === 1) {
      const idx = 1 - (Math.floor(tc / 2) % 2);
      return players[idx];
    }

    return players[0];
  }

  async refreshLocations(
    refresh: RequireQueryLocation,
    options: {
      queryFlag?: number;
      sendToClient?: MayBeArray<Client>;
      useCache?: number;
    } = {},
  ) {
    if (!this.ocgcore) {
      return;
    }
    const locations = splitRefreshLocations(refresh.location);
    for (const location of locations) {
      const { cards } = await this.ocgcore.queryFieldCard({
        player: refresh.player,
        location,
        queryFlag: options.queryFlag ?? getZoneQueryFlag(location),
        useCache: options.useCache ?? 1,
      });
      await this.dispatchGameMsg(
        new YGOProMsgUpdateData().fromPartial({
          player: refresh.player,
          location,
          cards: cards ?? [],
        }),
        { sendToClient: options.sendToClient, route: true },
      );
    }
  }

  async refreshSingle(
    refresh: RequireQueryCardLocation,
    options: { queryFlag?: number; sendToClient?: MayBeArray<Client> } = {},
  ) {
    if (!this.ocgcore) {
      return;
    }
    const locations = splitRefreshLocations(refresh.location);
    for (const location of locations) {
      const { card } = await this.ocgcore.queryCard({
        player: refresh.player,
        location,
        sequence: refresh.sequence,
        queryFlag:
          (options.queryFlag ?? 0xf81fff) |
          OcgcoreCommonConstants.QUERY_CODE |
          OcgcoreCommonConstants.QUERY_POSITION,
        useCache: 0,
      });
      await this.dispatchGameMsg(
        new YGOProMsgUpdateCard().fromPartial({
          controller: refresh.player,
          location,
          sequence: refresh.sequence,
          card:
            card ??
            (() => {
              const empty = new CardQuery();
              empty.flags = 0;
              empty.empty = true;
              return empty;
            })(),
        }),
        { sendToClient: options.sendToClient, route: true },
      );
    }
  }

  private async refreshForMessage(message: YGOProMsgBase) {
    await Promise.all([
      ...message.getRequireRefreshCards().map((loc) => this.refreshSingle(loc)),
      ...message
        .getRequireRefreshZones()
        .map((loc) => this.refreshLocations(loc)),
    ]);
  }

  private async sendWaitingToNonOperator(ingameDuelPos: number) {
    const operatingPlayer = this.getIngameOperatingPlayer(ingameDuelPos);
    const noOps = this.playingPlayers.filter((p) => p !== operatingPlayer);
    await Promise.all(
      noOps.map((p) =>
        p.send(
          new YGOProStocGameMsg().fromPartial({
            msg: new YGOProMsgWaiting(),
          }),
        ),
      ),
    );
  }

  private async routeGameMsg(
    message: YGOProMsgBase,
    options: { sendToClient?: MayBeArray<Client> } = {},
  ) {
    if (!message) {
      return;
    }
    const shouldRefreshFirst =
      message instanceof YGOProMsgResponseBase && !isUpdateMessage(message);
    if (shouldRefreshFirst) {
      await this.refreshForMessage(message);
    }

    const sendTargets = message.getSendTargets();
    const sendGameMsg = (c: Client, msg: YGOProMsgBase) =>
      c.send(new YGOProStocGameMsg().fromPartial({ msg }));
    const sendToClients = options.sendToClient
      ? new Set(makeArray(options.sendToClient))
      : undefined;
    await Promise.all(
      sendTargets.map(async (pos) => {
        if (pos === NetPlayerType.OBSERVER) {
          const observerView = message.observerView();
          await Promise.all(
            [...this.watchers].map((w) => sendGameMsg(w, observerView)),
          );
        } else {
          const players = this.getIngameDuelPosPlayers(pos);
          await Promise.all(
            players.map(async (c) => {
              if (sendToClients && !sendToClients.has(c)) {
                return;
              }
              const duelPos = this.getIngameDuelPos(c);
              const playerView = message.playerView(duelPos);
              const operatingPlayer = this.getIngameOperatingPlayer(duelPos);
              if (
                message instanceof YGOProMsgResponseBase &&
                c !== operatingPlayer
              ) {
                return;
              }
              return sendGameMsg(
                c,
                c === operatingPlayer ? playerView : playerView.teammateView(),
              );
            }),
          );
        }
      }),
    );
    if (!isUpdateMessage(message) && !shouldRefreshFirst) {
      await this.refreshForMessage(message);
    }

    if (message instanceof YGOProMsgResponseBase) {
      this.lastResponseRequestMsg = message;
      this.isRetrying = false;
      this.responsePos = this.getIngameDuelPosByDuelPos(
        message.responsePlayer(),
      );
      await this.sendWaitingToNonOperator(message.responsePlayer());
      await this.setResponseTimer(this.responsePos);
      return;
    }
    if (message instanceof YGOProMsgRetry && this.responsePos != null) {
      if (this.lastDuelRecord.responses.length > 0) {
        this.lastDuelRecord.responses.pop();
      }
      this.isRetrying = true;
      await this.sendWaitingToNonOperator(
        this.getIngameDuelPosByDuelPos(this.responsePos),
      );
      await this.setResponseTimer(this.responsePos);
      return;
    }
    if (
      this.responsePos != null &&
      !this.lastResponseRequestMsg &&
      !(message instanceof YGOProMsgResponseBase)
    ) {
      this.responsePos = undefined;
    }
  }

  async dispatchGameMsg(
    message: YGOProMsgBase,
    options: { sendToClient?: MayBeArray<Client>; route?: boolean } = {},
  ) {
    if (!options.sendToClient) {
      message = await this.localGameMsgDispatcher.dispatch(message);
      message = await this.ctx.dispatch(
        message,
        this.getIngameOperatingPlayer(this.turnIngamePos),
      );
    }
    if (options.route) {
      await this.routeGameMsg(message, {
        sendToClient: options.sendToClient,
      });
    }
    return message;
  }

  localGameMsgDispatcher = new ProtoMiddlewareDispatcher({
    acceptResult: () => true,
  })
    .middleware(YGOProMsgBase, async (message, next) => {
      if (!isUpdateMessage(message)) {
        this.logger.debug(
          { msgName: message.constructor.name },
          'Received game message',
        );
      }
      return next();
    })
    .middleware(YGOProMsgNewTurn, async (message, next) => {
      // check new turn
      const player = message.player;
      if (!(player & 0x2)) {
        await this.onNewTurn(player & 0x1);
      }
      return next();
    })
    .middleware(YGOProMsgNewPhase, async (message, next) => {
      // check new phase
      await this.onNewPhase(message.phase);
      return next();
    })
    .middleware(YGOProMsgResetTime, async (message, next) => {
      await this.handleResetTime(message);
      return next();
    })
    .middleware(YGOProMsgBase, async (message, next) => {
      // record messages for replay
      if (!(message instanceof YGOProMsgRetry)) {
        this.lastDuelRecord.messages.push(message);
      }
      return next();
    })
    .middleware(YGOProMsgRetry, async (message, next) => {
      if (this.responsePos != null) {
        const op = this.getIngameOperatingPlayer(
          this.getIngameDuelPosByDuelPos(this.responsePos),
        );
        await op.send(
          new YGOProStocGameMsg().fromPartial({
            msg: message,
          }),
        );
      }
      return next();
    })
    .middleware(YGOProMsgMatchKill, async (message, next) => {
      this.matchKilled = true;
      return next();
    });

  private matchKilled = false;
  private responsePos?: number;

  private async advance() {
    if (!this.ocgcore) {
      return;
    }

    try {
      for await (const {
        status,
        message,
        encodeError,
      } of this.ocgcore.advance()) {
        if (encodeError) {
          this.logger.warn(
            { encodeError, status },
            'Failed to decode game message in worker transport',
          );
        }
        if (!message) {
          this.logger.warn({ message }, 'Received empty message from ocgcore');
          if (status) {
            throw new Error(
              'Cannot continue ocgcore because received empty message with non-advancing status ' +
                status,
            );
          }
        }

        if (message instanceof YGOProMsgUpdateCard) {
          await this.refreshSingle({
            player: message.controller,
            location: message.location,
            sequence: message.sequence,
          });
          continue;
        }

        const handled = await this.dispatchGameMsg(message);
        if (handled instanceof YGOProMsgWin) {
          return this.win(handled, this.matchKilled ? 1 : undefined);
        }
        await this.routeGameMsg(handled);
      }
    } catch (e) {
      this.logger.warn({ error: e }, 'Error while advancing ocgcore');
      return this.finalize();
    }
  }

  @RoomMethod({
    allowInDuelStages: DuelStage.Dueling,
  })
  private async onTimeConfirm(client: Client, _msg: YGOProCtosTimeConfirm) {
    if (
      !this.hasTimeLimit ||
      this.responsePos == null ||
      this.timerState.runningPos == null ||
      !this.timerState.awaitingConfirm
    ) {
      return;
    }
    if (this.timerState.runningPos !== this.responsePos) {
      return;
    }
    if (
      client !==
      this.getIngameOperatingPlayer(
        this.getIngameDuelPosByDuelPos(this.responsePos),
      )
    ) {
      return;
    }

    const elapsedMs = this.timerState.elapsedMs();
    const player = this.timerState.runningPos;
    if (
      elapsedMs < 10_000 &&
      elapsedMs <= this.timerState.compensatorMs[player]
    ) {
      this.timerState.compensatorMs[player] -= elapsedMs;
    } else {
      this.timerState.leftMs[player] = Math.max(
        0,
        this.timerState.leftMs[player] - elapsedMs,
      );
    }
    this.timerState.awaitingConfirm = false;
    await this.setResponseTimer(player, {
      settlePrevious: false,
      sendTimeLimit: false,
      awaitingConfirm: false,
    });
  }

  @RoomMethod({
    allowInDuelStages: DuelStage.Dueling,
  })
  private async onResponse(client: Client, msg: YGOProCtosResponse) {
    if (
      this.responsePos == null ||
      client !==
        this.getIngameOperatingPlayer(
          this.getIngameDuelPosByDuelPos(this.responsePos),
        ) ||
      !this.ocgcore
    ) {
      return;
    }
    const responsePos = this.responsePos;
    const responseRequestMsg = this.lastResponseRequestMsg;
    const response = Buffer.from(msg.response);
    this.lastDuelRecord.responses.push(response);
    if (this.hasTimeLimit) {
      this.clearResponseTimer(true);
      const msgType = this.isRetrying
        ? OcgcoreCommonConstants.MSG_RETRY
        : responseRequestMsg
          ? getMessageIdentifier(responseRequestMsg)
          : 0;
      this.increaseResponseTime(responsePos, msgType, response);
    }
    this.lastResponseRequestMsg = undefined;
    this.isRetrying = false;
    await this.ocgcore.setResponse(msg.response);
    return this.advance();
  }

  @RoomMethod({
    allowInDuelStages: DuelStage.Dueling,
  })
  private async onSurrender(client: Client, _msg: YGOProCtosSurrender) {
    if (client.pos === NetPlayerType.OBSERVER) {
      return;
    }
    // TODO: teammate surrender in tag duel
    return this.win({ player: 1 - this.getIngameDuelPos(client), type: 0x0 });
  }

  async getLP(player: number): Promise<number | undefined> {
    if (!this.ocgcore) {
      return undefined;
    }
    const info = await this.ocgcore.queryFieldInfo();
    return info.field.players[this.getIngameDuelPosByDuelPos(player)].lp;
  }
}
