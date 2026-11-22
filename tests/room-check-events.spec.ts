import {
  ChatColor,
  NetPlayerType,
  YGOProCtosHsStart,
  YGOProCtosHsToObserver,
  YGOProCtosUpdateDeck,
  YGOProStocDuelStart,
  YGOProStocHsPlayerChange,
} from 'ygopro-msg-encode';
import YGOProDeck from 'ygopro-deck-encode';
import {
  DefaultDeckShuffler,
  DefaultHostInfoProvider,
  DefaultFirstgo,
  DefaultSeeder,
  DuelRecord,
  DuelStage,
  NoWatchGuard,
  OnRoomGameStart,
  OnRoomMatchStart,
  Room,
  RoomDecideFirst,
  RoomDecideFirstgo,
  RoomShuffleDeck,
  RoomUseSeed,
} from '../src/room';
import { RoomCreateCheck } from '../src/room/room-event/room-create-check';
import { RoomJoinCheck } from '../src/room/room-event/room-join-check';
import { RoomCreateError, RoomManager } from '../src/room/room-manager';
import { AngelusService } from '../src/angelus';

function createLogger() {
  return {
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  };
}

function makeRoomManagerCtx(rejectMessage = '') {
  const ctx: any = {
    createLogger,
    config: {
      getString: (key: string) => (key === 'HOSTINFO_LFLIST' ? '-1' : ''),
      getBoolean: () => false,
      getInt: () => 0,
    },
  };
  const hostInfoProvider = new DefaultHostInfoProvider(ctx);
  const dispatch = jest.fn(async (event: any) => {
    if (event instanceof RoomCreateCheck && rejectMessage) {
      return event.use(rejectMessage);
    }
    return event;
  });
  ctx.dispatch = dispatch;
  ctx.get = jest.fn((factory: () => unknown) => {
    const token = factory();
    if (token === DefaultHostInfoProvider) {
      return hostInfoProvider;
    }
    if (token === AngelusService) {
      return {
        lists: jest.fn(async () => []),
        extraCards: jest.fn(async () => new Set<number>()),
      };
    }
    return undefined;
  });
  return { ctx, dispatch };
}

describe('RoomCreateCheck', () => {
  test('creates a room when check value is empty', async () => {
    const { ctx, dispatch } = makeRoomManagerCtx();
    const manager = new RoomManager(ctx);
    const creator: any = { name: 'Alice' };

    const room = await manager.findOrCreateByName('room', creator);

    expect(room).toBeInstanceOf(Room);
    expect(dispatch.mock.calls[0]?.[0]).toBeInstanceOf(RoomCreateCheck);
    expect(manager.allRooms()).toHaveLength(1);
  });

  test('returns RoomCreateError and does not create room when check has value', async () => {
    const { ctx } = makeRoomManagerCtx('blocked');
    const manager = new RoomManager(ctx);
    const creator: any = { name: 'Alice' };

    const result = await manager.findOrCreateByName('room', creator);

    expect(result).toBeInstanceOf(RoomCreateError);
    expect((result as RoomCreateError).message).toBe('blocked');
    expect(manager.allRooms()).toHaveLength(0);
  });
});

describe('RoomJoinCheck', () => {
  function makeJoinRoom(
    handleJoinCheck: string | ((event: RoomJoinCheck) => unknown) = '',
  ) {
    const ctx: any = {
      createLogger,
      config: {
        getString: (key: string) => (key === 'HOSTINFO_LFLIST' ? '-1' : ''),
        getBoolean: () => false,
        getInt: () => 0,
      },
      dispatch: jest.fn(async (event: any) => {
        if (event instanceof RoomJoinCheck) {
          if (typeof handleJoinCheck === 'function') {
            return handleJoinCheck(event) || event;
          }
          if (handleJoinCheck) {
            return event.use(handleJoinCheck);
          }
        }
        return event;
      }),
    };
    const hostInfoProvider = new DefaultHostInfoProvider(ctx);
    ctx.get = jest.fn((factory: () => unknown) => {
      const token = factory();
      if (token === DefaultHostInfoProvider) {
        return hostInfoProvider;
      }
      return undefined;
    });
    return new Room(ctx, 'room', { lflist: -1 });
  }

  function makeJoinClient(overrides: Partial<any> = {}) {
    return {
      die: jest.fn(),
      send: jest.fn(),
      sendTypeChange: jest.fn(),
      prepareEnterPacket: jest.fn(() => ({})),
      prepareChangePacket: jest.fn(() => ({})),
      ...overrides,
    };
  }

  test('passes player slot as value and blocks before mutating room', async () => {
    const seenValues: Array<number | string> = [];
    const room = makeJoinRoom((event) => {
      seenValues.push(event.value);
      return event.use('no');
    });
    const client: any = { die: jest.fn() };

    await room.join(client);

    const event = (room as any).ctx.dispatch.mock.calls[0][0] as RoomJoinCheck;
    expect(seenValues).toEqual([0]);
    expect(event.hasPlayerBeforeJoin).toBe(false);
    expect(room.playingPlayers).toHaveLength(0);
    expect(client.die).toHaveBeenCalledWith('no', ChatColor.RED);
  });

  test('passes observer as value when joining as watcher', async () => {
    const seenValues: Array<number | string> = [];
    const room = makeJoinRoom((event) => {
      seenValues.push(event.value);
      return event.use('no');
    });
    room.players[0] = { pos: 0 } as any;
    const client: any = { die: jest.fn() };

    await room.join(client, NetPlayerType.OBSERVER);

    const event = (room as any).ctx.dispatch.mock.calls[0][0] as RoomJoinCheck;
    expect(seenValues).toEqual([NetPlayerType.OBSERVER]);
    expect(event.hasPlayerBeforeJoin).toBe(true);
    expect(room.watchers.size).toBe(0);
    expect(client.die).toHaveBeenCalledWith('no', ChatColor.RED);
  });

  test('joins the requested empty player slot from RoomJoinCheck value', async () => {
    const room = makeJoinRoom((event) => event.use(1));
    const client: any = makeJoinClient();

    await room.join(client);

    expect(client.pos).toBe(1);
    expect(room.players[1]).toBe(client);
    expect(room.watchers.has(client)).toBe(false);
  });

  test('joins as observer when RoomJoinCheck value is observer', async () => {
    const room = makeJoinRoom((event) => event.use(NetPlayerType.OBSERVER));
    const client: any = makeJoinClient();

    await room.join(client);

    expect(client.pos).toBe(NetPlayerType.OBSERVER);
    expect(room.playingPlayers).toHaveLength(0);
    expect(room.watchers.has(client)).toBe(true);
  });

  test('falls back to the first open player slot for invalid requested slots', async () => {
    const room = makeJoinRoom((event) => event.use(99));
    room.players[1] = makeJoinClient({ pos: 1 }) as any;
    const client: any = makeJoinClient();

    await room.join(client);

    expect(client.pos).toBe(0);
    expect(room.players[0]).toBe(client);
  });
});

describe('NoWatchGuard', () => {
  test('blocks observer join through RoomJoinCheck', async () => {
    const middlewares = new Map<unknown, any>();
    const ctx: any = {
      middleware: (cls: unknown, handler: unknown) =>
        middlewares.set(cls, handler),
      get: jest.fn(),
    };
    const guard = new NoWatchGuard(ctx);
    await guard.init();
    const room: any = { hostinfo: { no_watch: 1 } };
    const event = new RoomJoinCheck(room, NetPlayerType.OBSERVER, true);

    await middlewares.get(RoomJoinCheck)(event, undefined, jest.fn());

    expect(event.value).toBe('#{watch_denied}');
  });

  test('blocks switching to observer in no-watch rooms', async () => {
    const room = { name: 'room', hostinfo: { no_watch: 1 } };
    const middlewares = new Map<unknown, any>();
    const ctx: any = {
      middleware: (cls: unknown, handler: unknown) =>
        middlewares.set(cls, handler),
      get: () => ({
        findByName: (name: string) => (name === room.name ? room : undefined),
      }),
    };
    const guard = new NoWatchGuard(ctx);
    await guard.init();
    const client: any = {
      roomName: 'room',
      sendChat: jest.fn(),
    };
    const next = jest.fn();

    await middlewares.get(YGOProCtosHsToObserver)(
      new YGOProCtosHsToObserver(),
      client,
      next,
    );

    expect(client.sendChat).toHaveBeenCalledWith(
      '#{watch_denied_room}',
      ChatColor.BABYBLUE,
    );
    expect(next).not.toHaveBeenCalled();
  });
});

describe('DefaultSeeder', () => {
  test('provides a default 8 uint32 seed', async () => {
    const middlewares = new Map<unknown, any>();
    const ctx: any = {
      middleware: (cls: unknown, handler: unknown) =>
        middlewares.set(cls, handler),
    };
    const seeder = new DefaultSeeder(ctx);
    await seeder.init();
    const event = new RoomUseSeed({} as any);
    const next = jest.fn();

    await middlewares.get(RoomUseSeed)(event, undefined, next);

    expect(event.value).toHaveLength(8);
    expect(event.value.every((item) => Number.isInteger(item))).toBe(true);
    expect(event.value.every((item) => item >= 0 && item <= 0xffffffff)).toBe(
      true,
    );
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('DefaultDeckShuffler', () => {
  test('shuffles decks by swapped player order when shuffle is enabled', async () => {
    const middlewares = new Map<unknown, any>();
    const ctx: any = {
      middleware: (cls: unknown, handler: unknown) =>
        middlewares.set(cls, handler),
    };
    const shuffler = new DefaultDeckShuffler(ctx);
    await shuffler.init();
    const player0 = {
      name: 'Alice',
      deck: new YGOProDeck({ main: [1, 2, 3, 4], extra: [], side: [] }),
    };
    const player1 = {
      name: 'Bob',
      deck: new YGOProDeck({ main: [5, 6, 7, 8], extra: [], side: [] }),
    };
    const duelRecord = new DuelRecord([123, 456], [player0, player1], true);
    const playersInShuffleOrder = duelRecord.toSwappedPlayers();
    const event = new RoomShuffleDeck(
      { hostinfo: { no_shuffle_deck: 0 } } as any,
      duelRecord,
      true,
      playersInShuffleOrder,
      duelRecord.seed,
    );
    const next = jest.fn();

    await middlewares.get(RoomShuffleDeck)(event, undefined, next);

    expect(event.value).toHaveLength(2);
    expect(event.value[0]).not.toBe(player1.deck);
    expect(event.value[1]).not.toBe(player0.deck);
    expect(event.value[0].main).toHaveLength(4);
    expect(event.value[1].main).toHaveLength(4);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('keeps original deck objects when shuffle is disabled', async () => {
    const middlewares = new Map<unknown, any>();
    const ctx: any = {
      middleware: (cls: unknown, handler: unknown) =>
        middlewares.set(cls, handler),
    };
    const shuffler = new DefaultDeckShuffler(ctx);
    await shuffler.init();
    const player0 = {
      name: 'Alice',
      deck: new YGOProDeck({ main: [1], extra: [], side: [] }),
    };
    const player1 = {
      name: 'Bob',
      deck: new YGOProDeck({ main: [2], extra: [], side: [] }),
    };
    const duelRecord = new DuelRecord([1], [player0, player1], true);
    const playersInShuffleOrder = duelRecord.toSwappedPlayers();
    const event = new RoomShuffleDeck(
      { hostinfo: { no_shuffle_deck: 1 } } as any,
      duelRecord,
      true,
      playersInShuffleOrder,
      duelRecord.seed,
    );

    await middlewares.get(RoomShuffleDeck)(event, undefined, jest.fn());

    expect(event.value).toEqual(
      playersInShuffleOrder.map((player) => player.deck),
    );
  });
});

describe('DefaultFirstgo', () => {
  test('lets previous duel loser choose first/second', async () => {
    const middlewares = new Map<unknown, any>();
    const ctx: any = {
      middleware: (cls: unknown, handler: unknown) =>
        middlewares.set(cls, handler),
    };
    const firstgo = new DefaultFirstgo(ctx);
    await firstgo.init();
    const event = new RoomDecideFirstgo({
      lastDuelRecord: {
        winPosition: 0,
      },
    } as any);
    const next = jest.fn();

    await middlewares.get(RoomDecideFirstgo)(event, undefined, next);

    expect(event.value).toBe(1);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('does not decide firstgo without a valid previous winner', async () => {
    const middlewares = new Map<unknown, any>();
    const ctx: any = {
      middleware: (cls: unknown, handler: unknown) =>
        middlewares.set(cls, handler),
    };
    const firstgo = new DefaultFirstgo(ctx);
    await firstgo.init();
    const event = new RoomDecideFirstgo({
      lastDuelRecord: {
        winPosition: 2,
      },
    } as any);

    await middlewares.get(RoomDecideFirstgo)(event, undefined, jest.fn());

    expect(event.value).toBeUndefined();
  });
});

describe('Room start readiness', () => {
  const deck = new YGOProDeck({ main: [], extra: [], side: [] });

  function makePlayer(pos: number, ready = true) {
    return {
      pos,
      name: `Player ${pos}`,
      isHost: pos === 0,
      deck: ready ? deck : undefined,
      startDeck: deck,
      send: jest.fn(),
      prepareChangePacket: () => new YGOProStocHsPlayerChange(),
    };
  }

  test.each([
    { mode: 0, occupiedSlots: [0], lastSlot: 1 },
    { mode: 2, occupiedSlots: [0, 2, 3], lastSlot: 1 },
  ])(
    'waits for the last seat in mode $mode',
    async ({ mode, occupiedSlots, lastSlot }) => {
      const { ctx, dispatch } = makeRoomManagerCtx();
      const room = new Room(ctx, 'room', { mode, lflist: -1 });
      const players = occupiedSlots.map((pos) => makePlayer(pos));
      for (const player of players) {
        room.players[player.pos] = player as any;
      }
      const observer = makePlayer(NetPlayerType.OBSERVER, false);
      room.watchers.add(observer as any);
      const start = new YGOProCtosHsStart();

      await (room as any).onHsStart(players[0], start);

      expect(room.duelStage).toBe(DuelStage.Begin);
      expect(dispatch).not.toHaveBeenCalled();
      for (const client of [...players, observer]) {
        expect(client.send).not.toHaveBeenCalled();
      }

      room.players[lastSlot] = makePlayer(lastSlot) as any;
      await (room as any).onHsStart(players[0], start);

      expect(room.duelStage).toBe(DuelStage.Finger);
      expect(observer.send).toHaveBeenCalledWith(
        expect.any(YGOProStocDuelStart),
      );
      expect(dispatch).toHaveBeenCalledWith(
        expect.any(OnRoomMatchStart),
        players[0],
      );
    },
  );

  test('waits for an occupied seat to become ready', async () => {
    const { ctx, dispatch } = makeRoomManagerCtx();
    const room = new Room(ctx, 'room', { lflist: -1 });
    const host = makePlayer(0);
    room.players[0] = host as any;
    room.players[1] = makePlayer(1, false) as any;

    await expect(room.startGame()).resolves.toBe(false);

    expect(room.duelStage).toBe(DuelStage.Begin);
    expect(host.send).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  test('starts a no-host room when the last player submits a deck', async () => {
    const { ctx, dispatch } = makeRoomManagerCtx();
    const room = new Room(ctx, 'room', { lflist: -1 });
    room.noHost = true;
    const first = makePlayer(0, false);
    const second = makePlayer(1, false);
    room.players[0] = first as any;
    const update = new YGOProCtosUpdateDeck().fromPartial({ deck });

    await (room as any).onUpdateDeck(first, update);

    expect(room.duelStage).toBe(DuelStage.Begin);
    expect(first.send).not.toHaveBeenCalledWith(
      expect.any(YGOProStocDuelStart),
    );

    room.players[1] = second as any;
    await (room as any).onUpdateDeck(second, update);

    expect(room.duelStage).toBe(DuelStage.Finger);
    expect(first.send).toHaveBeenCalledWith(expect.any(YGOProStocDuelStart));
    expect(dispatch).toHaveBeenCalledWith(expect.any(OnRoomGameStart), first);
  });

  test('waits for every seat to submit a deck during siding', async () => {
    const { ctx, dispatch } = makeRoomManagerCtx();
    const room = new Room(ctx, 'room', { mode: 1, lflist: -1 });
    const first = makePlayer(0, false);
    const second = makePlayer(1, false);
    room.duelStage = DuelStage.Siding;
    room.duelRecords.push(
      new DuelRecord(
        [1],
        [first, second].map(({ name }) => ({ name, deck })),
        false,
      ),
    );
    room.players[0] = first as any;
    const update = new YGOProCtosUpdateDeck().fromPartial({ deck });

    await (room as any).onUpdateDeck(first, update);

    expect(room.duelStage).toBe(DuelStage.Siding);
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.any(OnRoomGameStart),
      first,
    );

    room.players[1] = second as any;
    await (room as any).onUpdateDeck(second, update);

    expect(room.duelStage).toBe(DuelStage.Finger);
    expect(dispatch).toHaveBeenCalledWith(expect.any(OnRoomGameStart), first);
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.any(OnRoomMatchStart),
      first,
    );
  });
});

describe('Room startGame first decision', () => {
  test('direct first decision skips firstgo and starts duel after OnRoomGameStart', async () => {
    const calls: string[] = [];
    const ctx: any = {
      createLogger,
      config: {
        getString: (key: string) => (key === 'HOSTINFO_LFLIST' ? '-1' : ''),
        getBoolean: () => false,
        getInt: () => 0,
      },
      dispatch: jest.fn(async (event: any) => {
        if (event instanceof RoomDecideFirst) {
          calls.push('first');
          return event.use(1);
        }
        if (event instanceof RoomDecideFirstgo) {
          calls.push('firstgo');
          return event;
        }
        if (event instanceof OnRoomGameStart) {
          calls.push('game-start');
        }
        return event;
      }),
    };
    const hostInfoProvider = new DefaultHostInfoProvider(ctx);
    ctx.get = jest.fn((factory: () => unknown) => {
      const token = factory();
      if (token === DefaultHostInfoProvider) {
        return hostInfoProvider;
      }
      return undefined;
    });
    const room = new Room(ctx, 'room', { lflist: -1 });
    const player0: any = {
      pos: 0,
      name: 'Alice',
      deck: { main: [], extra: [], side: [] },
      send: jest.fn(),
    };
    const player1: any = {
      pos: 1,
      name: 'Bob',
      deck: { main: [], extra: [], side: [] },
      send: jest.fn(),
    };
    room.players[0] = player0;
    room.players[1] = player1;
    (room as any).startDuel = jest.fn(async () => {
      calls.push('start-duel');
      return true;
    });

    await room.startGame();

    expect(calls).toEqual(['first', 'game-start', 'start-duel']);
    expect((room as any).startDuel).toHaveBeenCalledWith(1);
  });
});
