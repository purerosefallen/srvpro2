import { RandomDuelProvider, RandomDuelScore } from '../src/feats/random-duel';
import { ClientKeyProvider } from '../src/feats/client-key-provider';
import {
  DefaultHostInfoProvider,
  DuelStage,
  OnRoomFinalize,
  OnRoomJoinPlayer,
  OnRoomLeavePlayer,
  RoomLeavePlayerReason,
} from '../src/room';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function flushTasks() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function drainScores(provider: RandomDuelProvider) {
  await Promise.all((provider as any).scoreSaveTasks.values());
}

function setup({ database = true, recordScores = true } = {}) {
  const middleware = new Map<unknown, any>();
  const rows = new Map<string, RandomDuelScore>();
  const states = new Map<string, any>();
  const logger = { warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
  const repo = {
    findOneBy: jest.fn(async ({ name }: { name: string }) => {
      const row = rows.get(name);
      // Match ORM reads: each caller gets an independent entity instance.
      return row ? Object.assign(new RandomDuelScore(), row) : null;
    }),
    create: jest.fn((data: { name: string }) =>
      Object.assign(new RandomDuelScore(), data),
    ),
    save: jest.fn(async (score: RandomDuelScore) => {
      rows.set(score.name, Object.assign(new RandomDuelScore(), score));
      return score;
    }),
  };
  const aragami = {
    get: jest.fn(async (cls: any, key: string) =>
      states.get(`${cls.name}:${key}`),
    ),
    set: jest.fn(async (cls: any, value: any, options: any) => {
      states.set(`${cls.name}:${options.key}`, { ...value });
    }),
  };
  const hostInfoProvider = { registerRoomMode: jest.fn() };
  hostInfoProvider.registerRoomMode.mockReturnValue(hostInfoProvider);
  const ctx: any = {
    database: database ? { getRepository: () => repo } : undefined,
    aragami,
    createLogger: () => logger,
    middleware: (cls: unknown, handler: unknown) =>
      middleware.set(cls, handler),
    config: {
      getBoolean: (key: string) =>
        key === 'ENABLE_RANDOM_DUEL' ||
        (key === 'RANDOM_DUEL_RECORD_MATCH_SCORES' && recordScores),
      getInt: () => 0,
      getStringArray: () => ['S', 'M'],
    },
    get: (factory: () => unknown) => {
      const token = factory();
      if (token === ClientKeyProvider)
        return { getClientKey: (client: any) => client.name };
      if (token === DefaultHostInfoProvider) return hostInfoProvider;
      return { enabled: false, registerTick: jest.fn() };
    },
  };
  const provider = new RandomDuelProvider(ctx);

  function makeRoom(names = ['Alice', 'Bob'], score = [2, 1]) {
    const players = names.map((name, pos) => ({
      name,
      pos,
      isHost: pos === 0,
      sendChat: jest.fn(),
    }));
    const room: any = {
      name: 'M,RANDOM#test',
      randomType: 'M',
      duelStage: DuelStage.Dueling,
      playingPlayers: players,
      score,
      getDuelPosPlayers: (pos: number) =>
        players.filter((player) => player.pos === pos),
      getOpponents: (loser: any) =>
        players.filter((player) => player !== loser),
    };
    return { room, players };
  }

  async function finalize(room: any) {
    const next = jest.fn(async () => 'continued');
    const result = await middleware.get(OnRoomFinalize)(
      new OnRoomFinalize(room),
      undefined,
      next,
    );
    expect(next).toHaveBeenCalledTimes(1);
    expect(result).toBe('continued');
  }

  function leaveEvent(room: any, changes: any = {}) {
    return Object.assign(
      new OnRoomLeavePlayer(
        room,
        0,
        RoomLeavePlayerReason.Disconnect,
        false,
        0,
      ),
      changes,
    );
  }

  return {
    ctx,
    provider,
    middleware,
    rows,
    states,
    repo,
    aragami,
    logger,
    makeRoom,
    finalize,
    leaveEvent,
  };
}

describe('random duel background score saves', () => {
  test('slow score reads do not block finalize and results survive room/player changes', async () => {
    const { provider, rows, repo, makeRoom, finalize } = setup();
    const { room, players } = makeRoom();
    const reading = deferred();
    repo.findOneBy.mockImplementationOnce(async () => {
      await reading.promise;
      return null;
    });
    await provider.init();

    await finalize(room);
    players[0].name = 'Changed';
    players.length = 0;
    room.score = [0, 9];
    await flushTasks();
    expect(rows.has('Alice')).toBe(false);
    // Different players can save independently.
    expect(rows.get('Bob')?.loseCount).toBe(1);

    reading.resolve();
    await drainScores(provider);
    expect(rows.get('Alice')).toMatchObject({
      winCount: 1,
      loseCount: 0,
      winCombo: 1,
    });
    expect(rows.has('Changed')).toBe(false);
    expect((provider as any).scoreSaveTasks.size).toBe(0);
  });

  test('slow saves do not block finalize', async () => {
    const { provider, rows, repo, makeRoom, finalize } = setup();
    const saving = deferred();
    const save = repo.save.getMockImplementation()!;
    repo.save.mockImplementation(async (score) => {
      if (score.name === 'Alice') await saving.promise;
      return save(score);
    });
    await provider.init();
    await finalize(makeRoom().room);
    await flushTasks();
    expect(rows.has('Alice')).toBe(false);
    expect(rows.get('Bob')?.loseCount).toBe(1);

    saving.resolve();
    await drainScores(provider);
    expect(rows.get('Alice')?.winCount).toBe(1);
  });

  test('serializes one player across matches, preserving counts and win combo', async () => {
    const { provider, rows, repo, makeRoom, finalize } = setup();
    const saving = deferred();
    const save = repo.save.getMockImplementation()!;
    let firstAliceSave = true;
    repo.save.mockImplementation(async (score) => {
      if (score.name === 'Alice' && firstAliceSave) {
        firstAliceSave = false;
        await saving.promise;
      }
      return save(score);
    });
    await provider.init();
    await finalize(makeRoom().room);
    await finalize(makeRoom(['Alice', 'Charlie'], [0, 2]).room);
    await finalize(makeRoom(['Alice', 'Dave']).room);
    await flushTasks();
    expect(
      repo.findOneBy.mock.calls.filter(([query]) => query.name === 'Alice'),
    ).toHaveLength(1);

    saving.resolve();
    await drainScores(provider);
    expect(rows.get('Alice')).toMatchObject({
      winCount: 2,
      loseCount: 1,
      winCombo: 1,
    });
    expect(rows.get('Charlie')?.winCount).toBe(1);
    expect((provider as any).scoreSaveTasks.size).toBe(0);
  });

  test.each(['read', 'save'])(
    'a failed %s does not block the opponent or later updates',
    async (failure) => {
      const { provider, rows, repo, logger, makeRoom, finalize } = setup();
      if (failure === 'read')
        repo.findOneBy.mockRejectedValueOnce(new Error('read failed'));
      else repo.save.mockRejectedValueOnce(new Error('save failed'));
      await provider.init();
      await finalize(makeRoom().room);
      // Queue another match before the failed update has settled.
      await finalize(makeRoom(['Alice', 'Charlie']).room);
      await drainScores(provider);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(rows.get('Bob')?.loseCount).toBe(1);
      expect(rows.get('Alice')?.winCount).toBe(1);
      expect((provider as any).scoreSaveTasks.size).toBe(0);
    },
  );

  test('claims flee scoring before background IO and skips subsequent finalize scoring', async () => {
    const { provider, middleware, rows, repo, makeRoom, finalize, leaveEvent } =
      setup();
    const { room, players } = makeRoom();
    const reading = deferred();
    repo.findOneBy.mockImplementationOnce(async () => {
      await reading.promise;
      return null;
    });
    await provider.init();
    const next = jest.fn();
    await middleware.get(OnRoomLeavePlayer)(leaveEvent(room), players[0], next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(room.randomDuelScoreHandled).toBe(true);
    await finalize(room);
    players[0].name = 'Changed';
    players.length = 0;

    reading.resolve();
    await drainScores(provider);
    expect(rows.get('Alice')).toMatchObject({
      fleeCount: 1,
      loseCount: 1,
      winCount: 0,
      winCombo: 0,
    });
    expect(rows.get('Bob')).toMatchObject({ winCount: 1, loseCount: 0 });
    expect(rows.has('Changed')).toBe(false);
  });

  test.each([
    { database: false },
    { recordScores: false },
    { randomType: 'S' },
    { score: [1, 1] },
    { randomDuelScoreHandled: true },
    { missingPlayer: true },
    { names: ['', ''] },
  ])('skips ineligible score writes: %j', async (options) => {
    const { provider, repo, makeRoom, finalize } = setup(options);
    const { room, players } = makeRoom(options.names);
    Object.assign(room, options);
    if (options.missingPlayer) players.length = 1;
    await provider.init();
    await finalize(room);
    await drainScores(provider);
    expect(repo.findOneBy).not.toHaveBeenCalled();
    expect(repo.save).not.toHaveBeenCalled();
  });

  test.each([
    { bySystem: true },
    { oldPos: 7 },
    { otherDisconnectedCount: 1 },
    { reason: RoomLeavePlayerReason.ToObserver },
  ])('preserves flee eligibility checks: %j', async (changes) => {
    const { provider, middleware, repo, makeRoom, leaveEvent } = setup();
    const { room, players } = makeRoom();
    await provider.init();
    const next = jest.fn();
    await middleware.get(OnRoomLeavePlayer)(
      leaveEvent(room, changes),
      players[0],
      next,
    );
    await drainScores(provider);
    expect(next).toHaveBeenCalledTimes(1);
    expect(repo.save).not.toHaveBeenCalled();
    expect(room.randomDuelScoreHandled).toBeUndefined();
  });

  test('continues to await punishment state before allowing leave middleware to continue', async () => {
    const { provider, middleware, aragami, repo, makeRoom, leaveEvent } =
      setup();
    const { room, players } = makeRoom();
    const writingState = deferred();
    aragami.set.mockImplementationOnce(async () => writingState.promise);
    await provider.init();
    const next = jest.fn();
    const handled = middleware.get(OnRoomLeavePlayer)(
      leaveEvent(room),
      players[0],
      next,
    );
    await flushTasks();
    expect(aragami.set).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ count: 1, reasons: ['FLEE'] }),
      expect.any(Object),
    );
    expect(next).not.toHaveBeenCalled();
    expect(repo.findOneBy).not.toHaveBeenCalled();

    writingState.resolve();
    await handled;
    await drainScores(provider);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('continues to await opponent state and score tips on joining', async () => {
    const { provider, middleware, aragami, repo, makeRoom } = setup();
    const { room, players } = makeRoom();
    const writingState = deferred();
    const readingScore = deferred();
    aragami.set.mockImplementationOnce(async () => writingState.promise);
    repo.findOneBy.mockImplementationOnce(async () => {
      await readingScore.promise;
      return null;
    });
    await provider.init();
    const next = jest.fn();
    const handled = middleware.get(OnRoomJoinPlayer)(
      new OnRoomJoinPlayer(room),
      players[1],
      next,
    );
    await flushTasks();
    expect(next).not.toHaveBeenCalled();
    expect(repo.findOneBy).not.toHaveBeenCalled();

    writingState.resolve();
    await flushTasks();
    expect(repo.findOneBy).toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();

    readingScore.resolve();
    await handled;
    expect(next).toHaveBeenCalledTimes(1);
  });
});
