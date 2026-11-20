import { ProtoMiddlewareDispatcher } from 'nfkit';
import { ChatColor, YGOProMsgNewTurn } from 'ygopro-msg-encode';
import YGOProDeck from 'ygopro-deck-encode';
import { ClientKeyProvider } from '../src/feats/client-key-provider';
import {
  CloudReplayService,
  DuelRecordEntity,
  DuelRecordPlayer,
} from '../src/feats/cloud-replay';
import { MenuManager } from '../src/feats/menu-manager';
import { ReplayEncodeService } from '../src/replay';
import {
  DefaultHostinfo,
  DuelRecord,
  DuelStage,
  OnRoomFinalize,
  OnRoomWin,
  Room,
  RoomManager,
} from '../src/room';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushTasks() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function setup({ tournamentMode = true, database = true } = {}) {
  const dispatcher = new ProtoMiddlewareDispatcher<any>();
  const rooms = new Map<string, Room>();
  const order: string[] = [];
  const logger = { warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
  const ctx: any = {
    database: database ? {} : undefined,
    createLogger: () => logger,
    config: {
      getBoolean: (key: string) => key === 'TOURNAMENT_MODE' && tournamentMode,
    },
    middleware: dispatcher.middleware.bind(dispatcher),
    dispatch: dispatcher.dispatch.bind(dispatcher),
    get: (factory: () => unknown) => {
      const token = factory();
      if (token === RoomManager) {
        return { findByName: (name: string) => rooms.get(name) };
      }
      if (token === ClientKeyProvider) {
        return { getClientKey: (client: any) => client.name };
      }
      if (token === MenuManager) return {};
      if (token === ReplayEncodeService) return { prefetch: jest.fn() };
      return undefined;
    },
  };
  const service = new CloudReplayService(ctx);
  const save = jest
    .spyOn(service as any, 'saveDuelRecordSnapshot')
    .mockResolvedValue({ id: 42 });

  function makeRoom(name = 'tournament-room') {
    const room = new Room(ctx, name, {}, { ...DefaultHostinfo, mode: 1 });
    room.duelStage = DuelStage.Dueling;
    room.players = ['Alice', 'Bob'].map((playerName, pos) => ({
      name: playerName,
      pos,
      send: jest.fn(async () => undefined),
    })) as any;
    const record = new DuelRecord(
      Array.from({ length: 32 }, () => 1),
      ['Alice', 'Bob'].map((playerName) => ({
        name: playerName,
        deck: new YGOProDeck({ main: [1] }),
      })),
      false,
    );
    record.winReason = 1;
    record.winPosition = 0;
    room.duelRecords.push(record);
    const sendHint = jest
      .spyOn(room, 'sendChat')
      .mockImplementation(async () => {
        order.push('id');
        return [];
      });
    const cleanPlayers = jest
      .spyOn(room as any, 'cleanPlayers')
      .mockImplementation(async () => {
        order.push('clean');
        room.players.fill(undefined);
      });
    room.addFinalizor(() => {
      rooms.delete(name);
      order.push('remove');
    });
    rooms.set(name, room);
    return { room, record, sendHint, cleanPlayers };
  }

  function winEvent(room: Room, winMatch = true) {
    return new OnRoomWin(room, { player: 0 } as any, winMatch, false);
  }

  return {
    ctx,
    service,
    dispatcher,
    rooms,
    order,
    logger,
    save,
    makeRoom,
    winEvent,
  };
}

describe('tournament replay finalization', () => {
  test('runs later win/finalize middleware, then saves and sends ID before cleaning players', async () => {
    const { ctx, service, order, save, makeRoom } = setup();
    const { room, record, sendHint, cleanPlayers } = makeRoom();
    record.winPosition = undefined;
    const saving = deferred();
    const sending = deferred();
    save.mockImplementation(async () => {
      await saving.promise;
      return { id: 42 };
    });
    sendHint.mockImplementation(async () => {
      expect(room.finalizing).toBe(true);
      expect(room.playingPlayers).toHaveLength(2);
      order.push('id-start');
      await sending.promise;
      order.push('id-sent');
      return [];
    });
    // Register normal middleware first: the prior replay hook must wrap it too.
    ctx.middleware(
      OnRoomFinalize,
      async (_event: any, _client: any, next: any) => {
        order.push('other-finalize');
        return next();
      },
    );
    await service.init();
    ctx.middleware(OnRoomWin, async (_event: any, _client: any, next: any) => {
      order.push('other-win');
      return next();
    });

    const finished = room.win({ player: 0, type: 1 }, { forceWinMatch: 9 });
    await flushTasks();
    expect(order).toEqual(['other-win', 'other-finalize']);
    expect(cleanPlayers).not.toHaveBeenCalled();

    saving.resolve();
    await flushTasks();
    expect(sendHint).toHaveBeenCalledWith(
      '#{cloud_replay_delay_part1}R#42#{cloud_replay_delay_part2}',
      ChatColor.BABYBLUE,
    );
    expect(cleanPlayers).not.toHaveBeenCalled();

    sending.resolve();
    await finished;
    expect(order).toEqual([
      'other-win',
      'other-finalize',
      'id-start',
      'id-sent',
      'clean',
      'remove',
    ]);
    expect((service as any).tournamentReplayTasks.size).toBe(0);
    await room.finalize(true);
    expect(sendHint).toHaveBeenCalledTimes(1);
    expect(cleanPlayers).toHaveBeenCalledTimes(1);
  });

  test('does not resend an ID when saving and sending finished before finalize', async () => {
    const { ctx, service, makeRoom, winEvent } = setup();
    const { room, sendHint, cleanPlayers } = makeRoom();
    await service.init();
    await ctx.dispatch(winEvent(room));
    await flushTasks();
    expect(sendHint).toHaveBeenCalledTimes(1);
    expect((service as any).tournamentReplayTasks.size).toBe(0);

    await room.finalize();
    expect(sendHint).toHaveBeenCalledTimes(1);
    expect(cleanPlayers).toHaveBeenCalledTimes(1);
  });

  test('small-duel saves send their IDs without waiting for match finalization', async () => {
    const { ctx, service, save, makeRoom, winEvent } = setup();
    const { room, sendHint } = makeRoom();
    const saving = deferred();
    save.mockImplementation(async () => {
      await saving.promise;
      return { id: 42 };
    });
    await service.init();
    await ctx.dispatch(winEvent(room, false));
    expect(sendHint).not.toHaveBeenCalled();
    expect((service as any).tournamentReplayTasks.size).toBe(0);

    saving.resolve();
    await flushTasks();
    expect(sendHint).toHaveBeenCalledTimes(1);
    expect(room.finalizing).toBe(false);
  });

  test('ordinary mode cleans the room while saving is still pending', async () => {
    const { ctx, service, save, makeRoom, winEvent } = setup({
      tournamentMode: false,
    });
    const { room, sendHint, cleanPlayers } = makeRoom();
    const saving = deferred();
    save.mockImplementation(async () => {
      await saving.promise;
      return { id: 42 };
    });
    await service.init();
    await ctx.dispatch(winEvent(room));
    await room.finalize();
    expect(cleanPlayers).toHaveBeenCalledTimes(1);
    expect((service as any).tournamentReplayTasks.size).toBe(0);

    saving.resolve();
    await flushTasks();
    expect(sendHint).not.toHaveBeenCalled();
  });

  test('finalization without a win task or database continues normally', async () => {
    const { service, makeRoom, ctx, save, winEvent } = setup({
      database: false,
    });
    await service.init();
    const first = makeRoom('no-win');
    await first.room.finalize();
    const second = makeRoom('no-database');
    await ctx.dispatch(winEvent(second.room));
    await second.room.finalize();
    expect(first.cleanPlayers).toHaveBeenCalledTimes(1);
    expect(second.cleanPlayers).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
    expect(second.sendHint).not.toHaveBeenCalled();
    expect((service as any).tournamentReplayTasks.size).toBe(0);
  });

  test.each(['save', 'send'])(
    'logs %s failure and releases the finalization barrier',
    async (failure) => {
      const { ctx, service, save, logger, makeRoom, winEvent } = setup();
      const { room, sendHint, cleanPlayers } = makeRoom();
      const pending = deferred();
      if (failure === 'save') save.mockImplementation(() => pending.promise);
      else sendHint.mockImplementation(() => pending.promise.then(() => []));
      await service.init();
      await ctx.dispatch(winEvent(room));
      const finished = room.finalize();
      await flushTasks();
      expect(cleanPlayers).not.toHaveBeenCalled();

      pending.reject(new Error('unavailable'));
      await finished;
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(cleanPlayers).toHaveBeenCalledTimes(1);
      if (failure === 'save') expect(sendHint).not.toHaveBeenCalled();
      expect((service as any).tournamentReplayTasks.size).toBe(0);
    },
  );

  test('one room never waits for another room with a pending replay', async () => {
    const { ctx, service, save, makeRoom, winEvent } = setup();
    const first = makeRoom('first');
    const second = makeRoom('second');
    const saving = deferred();
    save.mockImplementation(async () => {
      await saving.promise;
      return { id: 42 };
    });
    await service.init();
    await ctx.dispatch(winEvent(first.room));
    await second.room.finalize();
    expect(second.cleanPlayers).toHaveBeenCalledTimes(1);
    expect(first.cleanPlayers).not.toHaveBeenCalled();

    saving.resolve();
    await first.room.finalize();
    expect(first.sendHint).toHaveBeenCalledTimes(1);
    expect(second.sendHint).not.toHaveBeenCalled();
  });

  test('does not deliver an old replay ID to a new room with the same name', async () => {
    const { ctx, service, save, makeRoom, winEvent } = setup();
    const first = makeRoom();
    const saving = deferred();
    save.mockImplementation(async () => {
      await saving.promise;
      return { id: 42 };
    });
    await service.init();
    await ctx.dispatch(winEvent(first.room, false));
    const replacement = makeRoom();
    saving.resolve();
    await flushTasks();
    expect(first.sendHint).not.toHaveBeenCalled();
    expect(replacement.sendHint).not.toHaveBeenCalled();
  });

  test('captures replay and player data before a background save can yield', async () => {
    const { ctx, service, save, makeRoom, winEvent } = setup({
      tournamentMode: false,
    });
    const { room, record } = makeRoom();
    const saving = deferred();
    save.mockImplementation(async () => {
      await saving.promise;
      return { id: 42 };
    });
    await service.init();
    await ctx.dispatch(winEvent(room));
    const snapshot = save.mock.calls[0][1];
    record.winReason = 4;
    room.players[0]!.name = 'Changed';
    room.hostinfo.mode = 0;
    room.duelRecords.length = 0;
    await room.finalize();

    expect(snapshot).toMatchObject({
      duelCount: 1,
      winReason: 1,
      hostInfo: { mode: 1 },
      players: [
        { name: 'Alice', score: 1 },
        { name: 'Bob', score: 0 },
      ],
    });
    saving.resolve();
    await flushTasks();
  });

  test('instant and final writes remain serialized, with the final replay committed last', async () => {
    const { ctx, service, save, makeRoom, winEvent } = setup();
    const { room, record, sendHint, cleanPlayers } = makeRoom();
    save.mockRestore();
    ctx.config.getBoolean = (key: string) =>
      ['TOURNAMENT_MODE', 'CLOUD_REPLAY_INSTANT_WRITE'].includes(key);
    const instantWrite = deferred();
    const winReasons: Array<number | null> = [];
    let storedRecord: DuelRecordEntity | undefined;
    const query: any = {
      where: jest.fn(() => query),
      andWhere: jest.fn(() => query),
      orderBy: jest.fn(() => query),
      getOne: jest.fn(async () => storedRecord),
    };
    const recordRepo = {
      createQueryBuilder: () => query,
      create: () => new DuelRecordEntity(),
      save: jest.fn(async (entity: DuelRecordEntity) => {
        entity.id = 42;
        winReasons.push(entity.winReason ?? null);
        storedRecord = entity;
        return entity;
      }),
    };
    const playerRepo = {
      find: jest.fn(async () => []),
      create: () => new DuelRecordPlayer(),
      save: jest.fn(async (entity: DuelRecordPlayer) => entity),
    };
    const manager = {
      getRepository: (entity: unknown) =>
        entity === DuelRecordEntity ? recordRepo : playerRepo,
    };
    const transaction = jest.fn(async (callback: any) => callback(manager));
    transaction.mockImplementationOnce(async (callback: any) => {
      await instantWrite.promise;
      return callback(manager);
    });
    ctx.database = { transaction };
    await service.init();

    record.winReason = undefined;
    await ctx.dispatch(new YGOProMsgNewTurn(), { roomName: room.name });
    record.winReason = 1;
    await ctx.dispatch(winEvent(room));
    const finished = room.finalize();
    await flushTasks();
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(cleanPlayers).not.toHaveBeenCalled();

    instantWrite.resolve();
    await finished;
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(winReasons).toEqual([null, 1]);
    expect(storedRecord?.winReason).toBe(1);
    expect(sendHint).toHaveBeenCalledTimes(1);
    expect(cleanPlayers).toHaveBeenCalledTimes(1);
  });

  test('snapshot failures and rooms without a duel do not leave a pending task', async () => {
    const { ctx, service, logger, save, makeRoom, winEvent } = setup();
    await service.init();
    const empty = makeRoom('empty');
    empty.room.duelRecords.length = 0;
    await ctx.dispatch(winEvent(empty.room));
    await empty.room.finalize();
    expect(save).not.toHaveBeenCalled();

    const broken = makeRoom('broken');
    jest
      .spyOn(service as any, 'createDuelRecordSnapshot')
      .mockImplementation(() => {
        throw new Error('encoding failed');
      });
    await ctx.dispatch(winEvent(broken.room));
    await broken.room.finalize();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(broken.sendHint).not.toHaveBeenCalled();
    expect(broken.cleanPlayers).toHaveBeenCalledTimes(1);
    expect((service as any).tournamentReplayTasks.size).toBe(0);
  });
});
