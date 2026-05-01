import {
  ChatColor,
  OcgcoreCommonConstants,
  YGOProMsgNewPhase,
  YGOProMsgNewTurn,
  YGOProMsgSelectYesNo,
  YGOProStocGameMsg,
} from 'ygopro-msg-encode';
import YGOProDeck from 'ygopro-deck-encode';
import {
  DefaultHostInfoProvider,
  OnRoomCreate,
  OnRoomPlayerReady,
  OnRoomPlayerUnready,
  OnRoomWin,
  RoomCheckDeck,
  RoomCreateCheck,
  RoomDecideFirst,
  RoomJoinCheck,
  RoomManager,
  RoomUseSeed,
} from '../src/room';
import { DefaultHostinfo } from '../src/room/default-hostinfo';
import {
  CloudReplayService,
  encodeDeckBase64,
  ReplayRecoverService,
} from '../src/feats/cloud-replay';
import { ClientKeyProvider } from '../src/feats/client-key-provider';

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
        name: 'Alice',
        realName: 'Alice',
        clientKey: 'Alice',
        isFirst: true,
        pos: 0,
      },
      {
        name: 'Bob',
        realName: 'Bob',
        clientKey: 'Bob',
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
  const clientKeyProvider = {
    getClientKey: jest.fn(
      (client: any) => client.clientKey || client.name_vpass || client.name,
    ),
  };
  const ctx: any = {
    createLogger,
    database: {},
    config: {
      getBoolean: (key: string) => key === 'ENABLE_RECOVER',
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
    if (token === ClientKeyProvider) {
      return clientKeyProvider;
    }
    return undefined;
  });
  return {
    ctx,
    middlewares,
    hostInfoProvider,
    roomManager,
    cloudReplayService,
    clientKeyProvider,
  };
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

  test('loads recover record again when the room is created', async () => {
    const checkRecord = makeRecord({
      hostInfo: { ...DefaultHostinfo, lflist: -1, mode: 0x5, start_lp: 8000 },
    });
    const createRecord = makeRecord({
      hostInfo: {
        ...DefaultHostinfo,
        lflist: -1,
        mode: 0x2,
        start_lp: 9000,
        start_hand: 6,
        draw_count: 2,
      },
    });
    const { ctx, middlewares, hostInfoProvider, cloudReplayService } =
      makeCtx(checkRecord);
    cloudReplayService.findReplayById
      .mockResolvedValueOnce(checkRecord)
      .mockResolvedValueOnce(createRecord);
    await initRecoverService(ctx);
    const createCheckEvent = new RoomCreateCheck(
      hostInfoProvider.parseHostinfo('RC42T1#room'),
      'RC42T1#room',
    );

    await middlewares.get(RoomCreateCheck)![0](
      createCheckEvent,
      { name_vpass: 'Alice' },
      jest.fn(),
    );

    const room: any = {
      name: 'RC42T1#room',
      hostinfo: createCheckEvent.hostinfo,
      getDuelPos: (pos: number) => pos,
    };
    const next = jest.fn();
    await middlewares.get(OnRoomCreate)![0](
      new OnRoomCreate(room),
      undefined,
      next,
    );

    expect(cloudReplayService.findReplayById).toHaveBeenCalledTimes(2);
    expect(room.hostinfo.mode).toBe(0x7);
    expect(room.hostinfo.start_lp).toBe(9000);
    expect(room.hostinfo.start_hand).toBe(6);
    expect(room.hostinfo.draw_count).toBe(2);
    expect(room.recoverState.record).toBe(createRecord);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('leaves room as normal when record disappears before room create', async () => {
    const checkRecord = makeRecord();
    const { ctx, middlewares, hostInfoProvider, cloudReplayService } =
      makeCtx(checkRecord);
    cloudReplayService.findReplayById
      .mockResolvedValueOnce(checkRecord)
      .mockResolvedValueOnce(undefined);
    await initRecoverService(ctx);
    const createCheckEvent = new RoomCreateCheck(
      hostInfoProvider.parseHostinfo('RC42T1#room'),
      'RC42T1#room',
    );

    await middlewares.get(RoomCreateCheck)![0](
      createCheckEvent,
      { name_vpass: 'Alice' },
      jest.fn(),
    );

    const room: any = {
      name: 'RC42T1#room',
      hostinfo: createCheckEvent.hostinfo,
      finalize: jest.fn(),
    };
    const next = jest.fn();
    await middlewares.get(OnRoomCreate)![0](
      new OnRoomCreate(room),
      undefined,
      next,
    );

    expect(room.recoverState).toBeUndefined();
    expect(room.finalize).not.toHaveBeenCalled();
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
      { name_vpass: 'Bob' },
      next,
    );

    expect(allowedEvent.value).toBe(1);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('ReplayRecoverService deck recovery seats', () => {
  function makeDeckRecordPlayer(
    name: string,
    pos: number,
    startDeck: YGOProDeck,
    currentDeck = startDeck,
    overrides: Partial<any> = {},
  ) {
    return {
      name,
      realName: name,
      clientKey: name,
      isFirst: pos === 0,
      pos,
      startDeckBuffer: encodeDeckBase64(startDeck),
      startDeckMainc: startDeck.main.length,
      currentDeckBuffer: encodeDeckBase64(currentDeck),
      currentDeckMainc: currentDeck.main.length,
      ...overrides,
    };
  }

  function makeRecoverRoom(record: any, isTag = false, overrides: any = {}) {
    return {
      isTag,
      getRelativePos: (pos: number) => (isTag ? pos & 0x1 : 0),
      getDuelPos: (pos: number) => (isTag ? (pos & 0x2) >>> 1 : pos & 0x1),
      playingPlayers: [],
      recoverState: {
        record,
        spec: { id: 42, turnCount: 1 },
        responses: [],
        firstDuelPos: 0,
      },
      ...overrides,
    };
  }

  test('records reversed single seats from matched name and deck', async () => {
    const startDeck = new YGOProDeck({ main: [1], extra: [], side: [] });
    const currentDeck = new YGOProDeck({ main: [2], extra: [], side: [3] });
    const record = makeRecord({
      players: [
        makeDeckRecordPlayer('Alice', 0, startDeck, currentDeck),
        makeDeckRecordPlayer('Bob', 1, new YGOProDeck({ main: [4] })),
      ],
    });
    const { ctx, middlewares } = makeCtx(record);
    await initRecoverService(ctx);
    const room: any = makeRecoverRoom(record);
    const client: any = {
      name: 'Alice',
      name_vpass: 'Alice',
      pos: 1,
      sendChat: jest.fn(),
    };
    const event = new RoomCheckDeck(
      room,
      client,
      new YGOProDeck({ main: [1], extra: [], side: [] }),
      {} as any,
    );

    await middlewares.get(RoomCheckDeck)![0](event, client, jest.fn());

    expect(event.value).toBeUndefined();
    expect(room.recoverState.seatReversed).toBeUndefined();
    expect(event.deck.main).toEqual([2]);
    expect(event.deck.side).toEqual([3]);

    client.startDeck = event.deck;
    await middlewares.get(OnRoomPlayerReady)![0](
      new OnRoomPlayerReady(room),
      client,
      jest.fn(),
    );

    expect(room.recoverState.seatReversed).toBe(true);
  });

  test('matches recover players by client key instead of names', async () => {
    const startDeck = new YGOProDeck({ main: [8], extra: [], side: [] });
    const currentDeck = new YGOProDeck({ main: [9], extra: [], side: [] });
    const record = makeRecord({
      players: [
        makeDeckRecordPlayer('OldAlice', 0, startDeck, currentDeck, {
          realName: 'OldAlice$vpass',
          clientKey: 'stable-key',
        }),
      ],
    });
    const { ctx, middlewares } = makeCtx(record);
    await initRecoverService(ctx);
    const room: any = makeRecoverRoom(record);
    const client: any = {
      name: 'NewAlice',
      name_vpass: 'NewAlice$vpass',
      clientKey: 'stable-key',
      pos: 0,
      sendChat: jest.fn(),
    };
    const event = new RoomCheckDeck(room, client, startDeck, {} as any);

    await middlewares.get(RoomCheckDeck)![0](event, client, jest.fn());

    expect(event.value).toBeUndefined();
    expect(event.deck.main).toEqual([9]);
    expect(client.sendChat).not.toHaveBeenCalled();
  });

  test('rejects tag players with mismatched relative seats', async () => {
    const deck = new YGOProDeck({ main: [10], extra: [], side: [] });
    const record = makeRecord({
      hostInfo: { ...DefaultHostinfo, lflist: -1, mode: 2 },
      players: [makeDeckRecordPlayer('Alice', 1, deck)],
    });
    const { ctx, middlewares } = makeCtx(record);
    await initRecoverService(ctx);
    const room: any = makeRecoverRoom(record, true);
    const client: any = {
      name: 'Alice',
      name_vpass: 'Alice',
      pos: 2,
      sendChat: jest.fn(),
    };
    const event = new RoomCheckDeck(room, client, deck, {} as any);

    await middlewares.get(RoomCheckDeck)![0](event, client, jest.fn());

    expect(event.value?.toPayload()).toBe(0);
    expect(client.sendChat).toHaveBeenCalledWith(
      '#{deck_incorrect_reconnect}',
      ChatColor.RED,
    );
  });

  test('rejects tag players against an already determined reversal', async () => {
    const deck = new YGOProDeck({ main: [20], extra: [], side: [] });
    const record = makeRecord({
      hostInfo: { ...DefaultHostinfo, lflist: -1, mode: 2 },
      players: [makeDeckRecordPlayer('Alice', 1, deck)],
    });
    const { ctx, middlewares } = makeCtx(record);
    await initRecoverService(ctx);
    const room: any = makeRecoverRoom(record, true, {
      recoverState: {
        record,
        spec: { id: 42, turnCount: 1 },
        responses: [],
        firstDuelPos: 0,
        seatReversed: true,
      },
    });
    const client: any = {
      name: 'Alice',
      name_vpass: 'Alice',
      pos: 1,
      sendChat: jest.fn(),
    };
    const event = new RoomCheckDeck(room, client, deck, {} as any);

    await middlewares.get(RoomCheckDeck)![0](event, client, jest.fn());

    expect(event.value?.toPayload()).toBe(0);
  });

  test('clears reversal only after all players unready', async () => {
    const record = makeRecord();
    const { ctx, middlewares } = makeCtx(record);
    await initRecoverService(ctx);
    const room: any = makeRecoverRoom(record, false, {
      playingPlayers: [{ pos: 0, deck: undefined }],
      recoverState: {
        record,
        spec: { id: 42, turnCount: 1 },
        responses: [],
        firstDuelPos: 0,
        seatReversed: true,
      },
    });
    const client: any = { pos: 1 };

    await middlewares.get(OnRoomPlayerUnready)![0](
      new OnRoomPlayerUnready(room),
      client,
      jest.fn(),
    );

    expect(room.recoverState.seatReversed).toBeUndefined();
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

    expect(room.recoverState).toBeUndefined();
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

  test('reverses replay first player when recovered seats are reversed', async () => {
    const record = makeRecord();
    const { ctx, middlewares } = makeCtx(record);
    await initRecoverService(ctx);
    const room: any = {
      duelRecords: [],
      recoverState: {
        record,
        spec: { id: 42, turnCount: 1 },
        responses: [],
        firstDuelPos: 0,
        seatReversed: true,
      },
    };
    const firstDuelEvent = new RoomDecideFirst(room);

    await middlewares.get(RoomDecideFirst)![0](
      firstDuelEvent,
      undefined,
      jest.fn(),
    );

    expect(firstDuelEvent.value).toBe(1);
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

    expect(room.recoverState).toBeUndefined();
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
    expect(sameTurnRoom.recoverState).toBeDefined();

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
    expect(laterTurnRoom.recoverState).toBeUndefined();
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
    expect(beforePhaseRoom.recoverState).toBeDefined();

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
    expect(targetPhaseRoom.recoverState).toBeUndefined();
  });
});

describe('ReplayRecoverService lifecycle', () => {
  test('clears recover state when the room wins', async () => {
    const record = makeRecord();
    const { ctx, middlewares } = makeCtx(record);
    await initRecoverService(ctx);
    const room: any = {
      recoverState: {
        record,
        spec: { id: 42, turnCount: 1 },
        responses: [],
      },
    };
    const next = jest.fn();

    await middlewares.get(OnRoomWin)![0](
      new OnRoomWin(room, {} as any),
      undefined,
      next,
    );

    expect(room.recoverState).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });
});
