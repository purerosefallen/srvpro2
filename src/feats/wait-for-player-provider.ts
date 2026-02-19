import {
  ChatColor,
  NetPlayerType,
  YGOProCtosChat,
  YGOProCtosHandResult,
  YGOProCtosResponse,
  YGOProCtosTpResult,
  YGOProCtosUpdateDeck,
  YGOProMsgResponseBase,
  YGOProMsgRetry,
} from 'ygopro-msg-encode';
import { Context } from '../app';
import { Client } from '../client';
import {
  DuelStage,
  OnRoomFinger,
  OnRoomFinalize,
  OnRoomLeavePlayer,
  OnRoomSelectTp,
  Room,
  RoomManager,
} from '../room';
import { HidePlayerNameProvider } from './hide-player-name-provider';
import { OnClientWaitTimeout } from './random-duel/random-duel-events';

export interface WaitForPlayerConfig {
  roomFilter: (room: Room) => boolean;
  raadyTimeoutMs?: number;
  hangTimeoutMs?: number;
  longAgoBackoffMs: number;
}

declare module '../room' {
  interface Room {
    waitForPlayerPos?: number;
    waitingForPlayerOther?: number[];
    lastActiveTime?: Date;
    waitForPlayerTickRuntimeId?: number;
    waitForPlayerReadyDeadlineMs?: number;
    waitForPlayerReadyWarnRemain?: number;
    waitForPlayerReadyTargetPos?: number;
    waitForPlayerHangWarnElapsed?: number;
  }
}

interface WaitForPlayerTickRuntime {
  id: number;
  options: Required<WaitForPlayerConfig>;
  ticking: boolean;
  timer: ReturnType<typeof setInterval>;
}

export class WaitForPlayerProvider {
  private logger = this.ctx.createLogger(this.constructor.name);
  private roomManager = this.ctx.get(() => RoomManager);
  private hidePlayerNameProvider = this.ctx.get(() => HidePlayerNameProvider);
  private tickRuntimes = new Map<number, WaitForPlayerTickRuntime>();
  private nextTickId = 1;

  constructor(private ctx: Context) {}

  async init() {
    this.ctx.middleware(
      YGOProMsgResponseBase,
      async (msg, client, next) => {
        const room = this.getRoom(client);
        if (!room || !this.hasTickForRoom(room)) {
          return next();
        }
        try {
          return await next();
        } finally {
          const operatePlayer = room.getIngameOperatingPlayer(
            msg.responsePlayer(),
          );
          this.setWaitForPlayer(room, operatePlayer);
          this.refreshLastActiveTime(room);
        }
      },
      true,
    );

    this.ctx.middleware(
      YGOProMsgRetry,
      async (msg, client, next) => {
        const room = this.getRoom(client);
        if (!room || !this.hasTickForRoom(room)) {
          return next();
        }
        try {
          return await next();
        } finally {
          const operatePlayer = room.responsePlayer;
          if (operatePlayer) this.setWaitForPlayer(room, operatePlayer);
          this.refreshLastActiveTime(room);
        }
      },
      true,
    );

    this.ctx.middleware(
      YGOProCtosResponse,
      async (_msg, client, next) => {
        const room = this.getRoom(client);
        if (!room || !this.hasTickForRoom(room)) {
          return next();
        }
        try {
          return await next();
        } finally {
          this.refreshLastActiveTime(room);
        }
      },
      true,
    );

    this.ctx.middleware(
      YGOProCtosHandResult,
      async (_msg, client, next) => {
        const room = this.getRoom(client);
        if (!room || !this.hasTickForRoom(room)) {
          return next();
        }
        try {
          return await next();
        } finally {
          if (room.duelStage === DuelStage.Finger) {
            this.resolveWaitForPlayer(room, client);
          }
          this.refreshLastActiveTime(room, this.getLongAgoBackoffMs(room));
        }
      },
      true,
    );

    this.ctx.middleware(
      YGOProCtosTpResult,
      async (_msg, client, next) => {
        const room = this.getRoom(client);
        if (!room || !this.hasTickForRoom(room)) {
          return next();
        }
        try {
          return await next();
        } finally {
          if (room.duelStage === DuelStage.FirstGo) {
            this.resolveWaitForPlayer(room, client);
          }
          this.refreshLastActiveTime(room);
        }
      },
      true,
    );

    this.ctx.middleware(
      YGOProCtosUpdateDeck,
      async (_msg, client, next) => {
        const room = this.getRoom(client);
        if (
          !room ||
          !this.hasTickForRoom(room) ||
          room.duelStage !== DuelStage.Begin
        ) {
          return next();
        }
        try {
          return await next();
        } finally {
          this.resolveWaitForPlayer(room, client);
          this.refreshLastActiveTime(room);
        }
      },
      true,
    );

    this.ctx.middleware(
      YGOProCtosChat,
      async (msg, client, next) => {
        const room = this.getRoom(client);
        if (!room || !this.hasTickForRoom(room)) {
          return next();
        }
        const text = (msg.msg || '').trim();
        if (text.startsWith('/')) {
          return next();
        }
        if (
          [DuelStage.Finger, DuelStage.FirstGo, DuelStage.Siding].includes(
            room.duelStage,
          )
        ) {
          return next();
        }
        try {
          return await next();
        } finally {
          this.refreshLastActiveTime(room);
        }
      },
      true,
    );

    this.ctx.middleware(OnRoomFinger, async (event, _client, next) => {
      const room = event.room;
      if (!this.hasTickForRoom(room)) {
        return next();
      }
      this.setWaitForPlayer(room, ...event.fingerPlayers);
      this.refreshLastActiveTime(room, this.getLongAgoBackoffMs(room));
      return next();
    });

    this.ctx.middleware(OnRoomSelectTp, async (event, _client, next) => {
      const room = event.room;
      if (!this.hasTickForRoom(room)) {
        return next();
      }
      this.setWaitForPlayer(room, event.selector);
      this.refreshLastActiveTime(room);
      return next();
    });

    this.ctx.middleware(OnRoomLeavePlayer, async (event, _client, next) => {
      const room = event.room;
      if (!this.hasTickForRoom(room)) {
        return next();
      }
      if (room.waitForPlayerPos === event.oldPos) {
        room.waitForPlayerPos = undefined;
      }
      room.waitingForPlayerOther = (room.waitingForPlayerOther || []).filter(
        (pos) => pos !== event.oldPos,
      );
      return next();
    });

    this.ctx.middleware(OnRoomFinalize, async (event, _client, next) => {
      const room = event.room;
      this.clearTickRoomState(room);
      room.waitForPlayerPos = undefined;
      room.waitingForPlayerOther = undefined;
      room.lastActiveTime = undefined;
      return next();
    });
  }

  registerTick(options: WaitForPlayerConfig) {
    const runtimeOptions: Required<WaitForPlayerConfig> = {
      roomFilter: options.roomFilter,
      raadyTimeoutMs: Math.max(0, options.raadyTimeoutMs || 0),
      hangTimeoutMs: Math.max(0, options.hangTimeoutMs || 0),
      longAgoBackoffMs: Math.max(0, options.longAgoBackoffMs || 0),
    };
    const id = this.nextTickId;
    this.nextTickId += 1;
    const runtime: WaitForPlayerTickRuntime = {
      id,
      options: runtimeOptions,
      ticking: false,
      timer: setInterval(() => {
        void this.tickRuntime(id).catch((error) => {
          this.logger.warn({ error, id }, 'Failed to tick wait-for-player');
        });
      }, 1000),
    };
    this.tickRuntimes.set(id, runtime);
    return id;
  }

  private getRoom(client: Client): Room | undefined {
    if (!client.roomName) {
      return undefined;
    }
    return this.roomManager.findByName(client.roomName);
  }

  private getLongAgoBackoffMs(room: Room) {
    return this.getFirstMatchedRuntime(room)?.options.longAgoBackoffMs || 0;
  }

  private getMatchedTickRuntimes(room: Room) {
    return [...this.tickRuntimes.values()].filter((runtime) =>
      runtime.options.roomFilter(room),
    );
  }

  private getFirstMatchedRuntime(room: Room) {
    return this.getMatchedTickRuntimes(room)[0];
  }

  private hasTickForRoom(room: Room) {
    return !!this.getFirstMatchedRuntime(room);
  }

  private async tickRuntime(id: number) {
    const runtime = this.tickRuntimes.get(id);
    if (!runtime || runtime.ticking) {
      return;
    }
    runtime.ticking = true;
    try {
      const nowMs = Date.now();
      for (const room of this.roomManager.allRooms()) {
        const firstMatchedRuntime = this.getFirstMatchedRuntime(room);
        if (firstMatchedRuntime?.id !== id) {
          if (room.waitForPlayerTickRuntimeId === id) {
            this.clearRoomState(room);
          }
          continue;
        }
        if (room.waitForPlayerTickRuntimeId !== id) {
          this.clearRoomState(room);
          room.waitForPlayerTickRuntimeId = id;
        }
        await this.tickReadyTimeout(runtime, room, nowMs);
        await this.tickHangTimeout(runtime, room, nowMs);
      }
    } finally {
      runtime.ticking = false;
    }
  }

  private clearTickRoomState(room: Room) {
    this.clearRoomState(room);
  }

  private clearRoomState(room: Room) {
    this.clearReadyState(room);
    room.waitForPlayerHangWarnElapsed = undefined;
    room.waitForPlayerTickRuntimeId = undefined;
  }

  private clearReadyState(room: Room) {
    room.waitForPlayerReadyDeadlineMs = undefined;
    room.waitForPlayerReadyWarnRemain = undefined;
    room.waitForPlayerReadyTargetPos = undefined;
  }

  private getDisconnectedCount(room: Room) {
    return room.playingPlayers.filter((player) => !!player.disconnected).length;
  }

  private getReadyTimeoutTarget(room: Room) {
    const players = room.playingPlayers;
    const requiredPlayerCount = room.players.length;
    if (players.length < requiredPlayerCount) {
      return undefined;
    }
    const unreadyPlayers = players.filter((player) => !player.deck);
    if (unreadyPlayers.length !== 1) {
      return undefined;
    }
    return unreadyPlayers[0];
  }

  private async tickReadyTimeout(
    runtime: WaitForPlayerTickRuntime,
    room: Room,
    nowMs: number,
  ) {
    if (
      runtime.options.raadyTimeoutMs <= 0 ||
      room.duelStage !== DuelStage.Begin ||
      this.getDisconnectedCount(room) > 0
    ) {
      this.clearReadyState(room);
      return;
    }

    const target = this.getReadyTimeoutTarget(room);
    if (!target) {
      this.clearReadyState(room);
      return;
    }

    if (room.waitForPlayerReadyTargetPos !== target.pos) {
      room.waitForPlayerReadyTargetPos = target.pos;
      room.waitForPlayerReadyDeadlineMs =
        nowMs + runtime.options.raadyTimeoutMs;
      room.waitForPlayerReadyWarnRemain = undefined;
    }

    const readyDeadlineMs = room.waitForPlayerReadyDeadlineMs;
    if (!readyDeadlineMs) {
      this.clearReadyState(room);
      return;
    }

    const remainSeconds = Math.ceil((readyDeadlineMs - nowMs) / 1000);
    if (remainSeconds > 0) {
      if (
        remainSeconds % 5 === 0 &&
        room.waitForPlayerReadyWarnRemain !== remainSeconds
      ) {
        room.waitForPlayerReadyWarnRemain = remainSeconds;
        await room.sendChat(
          (sightPlayer) =>
            `${this.hidePlayerNameProvider.getHidPlayerName(target, sightPlayer)} ${remainSeconds} #{kick_count_down}`,
          remainSeconds <= 9 ? ChatColor.RED : ChatColor.LIGHTBLUE,
        );
      }
      return;
    }

    const latestTarget = this.getReadyTimeoutTarget(room);
    this.clearReadyState(room);
    if (
      !latestTarget ||
      latestTarget.pos !== target.pos ||
      latestTarget.disconnected ||
      latestTarget.roomName !== room.name ||
      !!latestTarget.deck
    ) {
      return;
    }
    await room.sendChat(
      (sightPlayer) =>
        `${this.hidePlayerNameProvider.getHidPlayerName(latestTarget, sightPlayer)} #{kicked_by_system}`,
      ChatColor.RED,
    );
    await this.ctx.dispatch(
      new OnClientWaitTimeout(room, latestTarget, 'ready'),
      latestTarget,
    );
    latestTarget.disconnect();
  }

  private async tickHangTimeout(
    runtime: WaitForPlayerTickRuntime,
    room: Room,
    nowMs: number,
  ) {
    if (
      runtime.options.hangTimeoutMs <= 0 ||
      room.duelStage === DuelStage.Begin ||
      room.duelStage === DuelStage.Siding
    ) {
      room.waitForPlayerHangWarnElapsed = undefined;
      return;
    }
    if (this.getDisconnectedCount(room) > 0) {
      return;
    }
    const waitingPos = room.waitForPlayerPos;
    if (waitingPos == null) {
      room.waitForPlayerHangWarnElapsed = undefined;
      return;
    }
    const waitingPlayer = room.players[waitingPos];
    if (
      !waitingPlayer ||
      waitingPlayer.pos !== waitingPos ||
      waitingPlayer.pos >= NetPlayerType.OBSERVER ||
      waitingPlayer.disconnected ||
      waitingPlayer.roomName !== room.name
    ) {
      room.waitForPlayerHangWarnElapsed = undefined;
      return;
    }
    if (!room.lastActiveTime) {
      return;
    }

    const elapsedMs = nowMs - room.lastActiveTime.getTime();
    if (elapsedMs >= runtime.options.hangTimeoutMs) {
      room.lastActiveTime = new Date(nowMs);
      room.waitForPlayerHangWarnElapsed = undefined;
      await room.sendChat(
        (sightPlayer) =>
          `${this.hidePlayerNameProvider.getHidPlayerName(waitingPlayer, sightPlayer)} #{kicked_by_system}`,
        ChatColor.RED,
      );
      await this.ctx.dispatch(
        new OnClientWaitTimeout(room, waitingPlayer, 'hang'),
        waitingPlayer,
      );
      waitingPlayer.disconnect();
      return;
    }

    const elapsedSeconds = Math.floor(elapsedMs / 1000);
    if (
      elapsedMs >= runtime.options.hangTimeoutMs - 20_000 &&
      elapsedSeconds % 10 === 0 &&
      room.waitForPlayerHangWarnElapsed !== elapsedSeconds
    ) {
      room.waitForPlayerHangWarnElapsed = elapsedSeconds;
      const remainSeconds = Math.ceil(
        (runtime.options.hangTimeoutMs - elapsedMs) / 1000,
      );
      if (remainSeconds > 0) {
        await room.sendChat(
          (sightPlayer) =>
            `${this.hidePlayerNameProvider.getHidPlayerName(waitingPlayer, sightPlayer)} #{afk_warn_part1}${remainSeconds}#{afk_warn_part2}`,
          ChatColor.RED,
        );
      }
    }
  }

  private setWaitForPlayer(room: Room, ...clients: (Client | undefined)[]) {
    const playerPoses = clients
      .filter(
        (client): client is Client =>
          !!client && client.pos < NetPlayerType.OBSERVER,
      )
      .map((client) => client.pos);
    const uniquePoses = Array.from(new Set(playerPoses));
    room.waitForPlayerPos = uniquePoses[0];
    room.waitingForPlayerOther = uniquePoses.slice(1);
    this.logger.debug(
      {
        roomName: room.name,
        waitForPlayerPos: room.waitForPlayerPos,
        waitingForPlayerOther: room.waitingForPlayerOther,
      },
      'Set wait for player',
    );
  }

  private resolveWaitForPlayer(room: Room, client: Client) {
    const waitingOthers = [...(room.waitingForPlayerOther || [])];
    if (client.pos === room.waitForPlayerPos) {
      room.waitForPlayerPos = waitingOthers.shift();
      room.waitingForPlayerOther = waitingOthers;
      return;
    }
    const otherIndex = waitingOthers.indexOf(client.pos);
    if (otherIndex >= 0) {
      waitingOthers.splice(otherIndex, 1);
      room.waitingForPlayerOther = waitingOthers;
    }
    this.logger.debug(
      {
        roomName: room.name,
        waitForPlayerPos: room.waitForPlayerPos,
        waitingForPlayerOther: room.waitingForPlayerOther,
      },
      'Resolved wait for player',
    );
  }

  private refreshLastActiveTime(room: Room, backoffMs = 0) {
    room.lastActiveTime = new Date(Date.now() - Math.max(0, backoffMs));
    this.logger.debug(
      {
        roomName: room.name,
        lastActiveTime: room.lastActiveTime,
      },
      'Refreshed last active time for wait for player',
    );
  }
}
