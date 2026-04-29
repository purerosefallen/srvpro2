import {
  ChatColor,
  OcgcoreCommonConstants,
  YGOProMsgNewPhase,
  YGOProMsgNewTurn,
  YGOProMsgSelectYesNo,
  YGOProStocGameMsg,
} from 'ygopro-msg-encode';
import {
  DefaultHostInfoProvider,
  RoomCreateCheck,
  RoomDecideFirst,
  RoomJoinCheck,
  RoomUseSeed,
} from '../src/room';
import { DefaultHostinfo } from '../src/room/default-hostinfo';
import {
  CloudReplayService,
  ReplayRecoverService,
} from '../src/feats/cloud-replay';
import { RoomManager } from '../src/room';

function createLogger() {
  return {
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  };
}

function makeRecord(overrides: Partial<any> = {}) {
  return {
    id: 42,
    roomIdentifier: 'inactive',
    hostInfo: {
      ...DefaultHostinfo,
      lflist: -1,
      mode: 1,
    },
    seed: Buffer.alloc(32).toString('base64'),
    responses: '',
    players: [
      {
        realName: 'Alice',
        isFirst: true,
        pos: 0,
      },
      {
        realName: 'Bob',
        isFirst: false,
        pos: 1,
      },
    ],
    ...overrides,
  };
}

function makeCtx(record: any, activeRooms: any[] = []) {
  const middlewares = new Map<unknown, any[]>();
  const activeIdentifiers = new Set(activeRooms.map((room) => room.identifier));
  const cloudReplayService = {
    findReplayById: jest.fn(async (id: number) => {
      if (!record || record.id !== id) {
        return undefined;
      }
      if (activeIdentifiers.has(record.roomIdentifier)) {
        return undefined;
      }
      return record;
    }),
  };
  const ctx: any = {
    createLogger,
    database: {},
    config: {
      getBoolean: (key: string) => key === 'ENABLE_CLOUD_REPLAY',
      getString: (key: string) => (key === 'HOSTINFO_LFLIST' ? '-1' : ''),
      getInt: () => 0,
    },
    middleware: (cls: unknown, handler: unknown) => {
      const handlers = middlewares.get(cls) || [];
      handlers.push(handler);
      middlewares.set(cls, handlers);
    },
  };
  const hostInfoProvider = new DefaultHostInfoProvider(ctx);
  const roomManager = {
    allRooms: () => activeRooms,
    findByName: jest.fn(),
  };
  ctx.get = jest.fn((factory: () => unknown) => {
    const token = factory();
    if (token === DefaultHostInfoProvider) {
      return hostInfoProvider;
    }
    if (token === RoomManager) {
      return roomManager;
    }
    if (token === CloudReplayService) {
      return cloudReplayService;
    }
    return undefined;
  });
  return { ctx, middlewares, hostInfoProvider, roomManager, cloudReplayService };
}

async function initRecoverService(ctx: any) {
  const service = new ReplayRecoverService(ctx);
  await service.init();
  return service;
}

describe('ReplayRecoverService create checks', () => {
  test('rejects invalid recover syntax', async () => {
    const { ctx, middlewares, hostInfoProvider } = makeCtx(makeRecord());
    await initRecoverService(ctx);
    const hostinfo = hostInfoProvider.parseHostinfo('RC42T0#room');
    const event = new RoomCreateCheck(hostinfo, 'RC42T0#room');
    const next = jest.fn();

    await middlewares.get(RoomCreateCheck)![0](
      event,
      { name_vpass: 'Alice' },
      next,
    );

    expect(event.value).toBe('#{recover_invalid}');
    expect(next).not.toHaveBeenCalled();
  });

  test('rejects missing records', async () => {
    const { ctx, middlewares, hostInfoProvider } = makeCtx(undefined);
    await initRecoverService(ctx);
    const event = new RoomCreateCheck(
      hostInfoProvider.parseHostinfo('RC42T1#room'),
      'RC42T1#room',
    );

    await middlewares.get(RoomCreateCheck)![0](
      event,
      { name_vpass: 'Alice' },
      jest.fn(),
    );

    expect(event.value).toBe('#{cloud_replay_no}');
  });

  test('rejects records that still belong to active rooms', async () => {
    const record = makeRecord({ roomIdentifier: 'active' });
    const { ctx, middlewares, hostInfoProvider } = makeCtx(record, [
      { identifier: 'active' },
    ]);
    await initRecoverService(ctx);
    const event = new RoomCreateCheck(
      hostInfoProvider.parseHostinfo('RC42T1#room'),
      'RC42T1#room',
    );

    await middlewares.get(RoomCreateCheck)![0](
      event,
      { name_vpass: 'Alice' },
      jest.fn(),
    );

    expect(event.value).toBe('#{cloud_replay_no}');
  });

  test('rejects creators who are not replay players', async () => {
    const { ctx, middlewares, hostInfoProvider } = makeCtx(makeRecord());
    await initRecoverService(ctx);
    const event = new RoomCreateCheck(
      hostInfoProvider.parseHostinfo('RC42T1#room'),
      'RC42T1#room',
    );

    await middlewares.get(RoomCreateCheck)![0](
      event,
      { name_vpass: 'Mallory' },
      jest.fn(),
    );

    expect(event.value).toBe('#{cloud_replay_no}');
  });

  test('allows replay players and restores original hostinfo', async () => {
    const { ctx, middlewares, hostInfoProvider } = makeCtx(makeRecord());
    await initRecoverService(ctx);
    const event = new RoomCreateCheck(
      hostInfoProvider.parseHostinfo('RC42T1BP#room'),
      'RC42T1BP#room',
    );
    const next = jest.fn();

    await middlewares.get(RoomCreateCheck)![0](
      event,
      { name_vpass: 'Alice' },
      next,
    );

    expect(event.value).toBe('');
    expect(event.hostinfo.mode).toBe(1);
    expect(event.hostinfo.recover).toEqual({
      id: 42,
      turnCount: 1,
      phase: 'BP',
    });
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('ReplayRecoverService join checks', () => {
  test('allows only replay players into recover rooms', async () => {
    const record = makeRecord();
    const { ctx, middlewares } = makeCtx(record);
    await initRecoverService(ctx);
    const room: any = {
      hostinfo: {
        recover: { id: 42, turnCount: 1 },
      },
      recoverState: {
        record,
      },
    };
    const event = new RoomJoinCheck(room, 0, false);

    await middlewares.get(RoomJoinCheck)![0](
      event,
      { name_vpass: 'Mallory' },
      jest.fn(),
    );

    expect(event.value).toBe('#{cloud_replay_no}');

    const allowedEvent = new RoomJoinCheck(room, 0, false);
    const next = jest.fn();
    await middlewares.get(RoomJoinCheck)![0](
      allowedEvent,
      { name_vpass: 'Alice' },
      next,
    );

    expect(allowedEvent.value).toBe('');
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('ReplayRecoverService response playback', () => {
  test('passes response requests through when recovered responses are exhausted', async () => {
    const record = makeRecord();
    const { ctx, middlewares, roomManager } = makeCtx(record);
    await initRecoverService(ctx);
    const room: any = {
      recoverState: {
        record,
        spec: { id: 42, turnCount: 1 },
        responses: [],
        recovering: true,
      },
      sendChat: jest.fn(),
    };
    roomManager.findByName.mockReturnValue(room);
    const next = jest.fn();

    await middlewares.get(YGOProStocGameMsg)![0](
      new YGOProStocGameMsg().fromPartial({
        msg: new YGOProMsgSelectYesNo(),
      }),
      { roomName: 'room' },
      next,
    );

    expect(room.recoverState.recovering).toBe(false);
    expect(room.sendChat).toHaveBeenCalledWith(
      '#{recover_success}',
      ChatColor.BABYBLUE,
    );
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('ReplayRecoverService seed playback', () => {
  test('uses replay seed only for the first duel', async () => {
    const rawSeed = Buffer.alloc(32);
    rawSeed.writeUInt32LE(123456789, 0);
    const record = makeRecord({
      seed: rawSeed.toString('base64'),
    });
    const { ctx, middlewares } = makeCtx(record);
    await initRecoverService(ctx);
    const room: any = {
      duelRecords: [],
      recoverState: {
        record,
        spec: { id: 42, turnCount: 1 },
        responses: [],
        recovering: true,
      },
    };
    const firstDuelEvent = new RoomUseSeed(room);

    await middlewares.get(RoomUseSeed)![0](
      firstDuelEvent,
      undefined,
      jest.fn(),
    );

    expect(firstDuelEvent.value[0]).toBe(123456789);

    room.duelRecords = [{}];
    const laterDuelEvent = new RoomUseSeed(room);
    const next = jest.fn();
    await middlewares.get(RoomUseSeed)![0](
      laterDuelEvent,
      undefined,
      next,
    );

    expect(laterDuelEvent.value).toEqual([]);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('ReplayRecoverService first-player decision', () => {
  test('uses replay first player only for the first duel', async () => {
    const record = makeRecord();
    const { ctx, middlewares } = makeCtx(record);
    await initRecoverService(ctx);
    const room: any = {
      duelRecords: [],
      recoverState: {
        record,
        spec: { id: 42, turnCount: 1 },
        responses: [],
        recovering: true,
        firstDuelPos: 1,
      },
    };
    const firstDuelEvent = new RoomDecideFirst(room);

    await middlewares.get(RoomDecideFirst)![0](
      firstDuelEvent,
      undefined,
      jest.fn(),
    );

    expect(firstDuelEvent.value).toBe(1);

    room.duelRecords = [{}];
    const laterDuelEvent = new RoomDecideFirst(room);
    const next = jest.fn();
    await middlewares.get(RoomDecideFirst)![0](
      laterDuelEvent,
      undefined,
      next,
    );

    expect(laterDuelEvent.value).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('ReplayRecoverService stop conditions', () => {
  function makeRecoveringRoom(spec: any, turnCount: number) {
    return {
      turnCount,
      recoverState: {
        record: makeRecord(),
        spec,
        responses: [],
        recovering: true,
      },
      sendChat: jest.fn(),
    };
  }

  test('without phase, new phase also stops when turn count is reached', async () => {
    const { ctx, middlewares, roomManager } = makeCtx(makeRecord());
    await initRecoverService(ctx);
    const room: any = makeRecoveringRoom({ id: 42, turnCount: 2 }, 2);
    roomManager.findByName.mockReturnValue(room);
    const message = new YGOProMsgNewPhase();
    message.phase = OcgcoreCommonConstants.PHASE_DRAW;

    await middlewares.get(YGOProMsgNewPhase)![0](
      message,
      { roomName: 'room' },
      jest.fn(),
    );

    expect(room.recoverState.recovering).toBe(false);
    expect(room.sendChat).toHaveBeenCalledWith(
      '#{recover_success}',
      ChatColor.BABYBLUE,
    );
  });

  test('with phase, new turn stops only after passing target turn count', async () => {
    const { ctx, middlewares, roomManager } = makeCtx(makeRecord());
    await initRecoverService(ctx);
    const message = new YGOProMsgNewTurn();
    const next = jest.fn();

    const sameTurnRoom: any = makeRecoveringRoom(
      { id: 42, turnCount: 2, phase: 'BP' },
      2,
    );
    roomManager.findByName.mockReturnValue(sameTurnRoom);
    await middlewares.get(YGOProMsgNewTurn)![0](
      message,
      { roomName: 'room' },
      next,
    );
    expect(sameTurnRoom.recoverState.recovering).toBe(true);

    const laterTurnRoom: any = makeRecoveringRoom(
      { id: 42, turnCount: 2, phase: 'BP' },
      3,
    );
    roomManager.findByName.mockReturnValue(laterTurnRoom);
    await middlewares.get(YGOProMsgNewTurn)![0](
      message,
      { roomName: 'room' },
      next,
    );
    expect(laterTurnRoom.recoverState.recovering).toBe(false);
  });

  test('with phase, new phase stops once turn and phase are both reached', async () => {
    const { ctx, middlewares, roomManager } = makeCtx(makeRecord());
    await initRecoverService(ctx);
    const message = new YGOProMsgNewPhase();

    const beforePhaseRoom: any = makeRecoveringRoom(
      { id: 42, turnCount: 2, phase: 'BP' },
      2,
    );
    message.phase = OcgcoreCommonConstants.PHASE_MAIN1;
    roomManager.findByName.mockReturnValue(beforePhaseRoom);
    await middlewares.get(YGOProMsgNewPhase)![0](
      message,
      { roomName: 'room' },
      jest.fn(),
    );
    expect(beforePhaseRoom.recoverState.recovering).toBe(true);

    const targetPhaseRoom: any = makeRecoveringRoom(
      { id: 42, turnCount: 2, phase: 'BP' },
      2,
    );
    message.phase = OcgcoreCommonConstants.PHASE_BATTLE;
    roomManager.findByName.mockReturnValue(targetPhaseRoom);
    await middlewares.get(YGOProMsgNewPhase)![0](
      message,
      { roomName: 'room' },
      jest.fn(),
    );
    expect(targetPhaseRoom.recoverState.recovering).toBe(false);
  });
});
