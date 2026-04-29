import { YGOProMsgResponseBase } from 'ygopro-msg-encode';
import { ClientKeyProvider } from '../src/feats/client-key-provider';
import { CloudReplayService, resolvePlayerScore } from '../src/feats/cloud-replay';
import {
  OnRoomReceiveResponse,
  OnRoomWin,
  RoomManager,
} from '../src/room';
import { MenuManager } from '../src/feats/menu-manager';

function makeCtx(tournamentMode = false) {
  const middleware = jest.fn();
  const clientKeyProvider = {
    getClientKey: jest.fn((client: any) => `key:${client.name}`),
  };
  const ctx: any = {
    createLogger: () => ({
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
      error: jest.fn(),
    }),
    config: {
      getBoolean: jest.fn((key: string) =>
        key === 'TOURNAMENT_MODE' ? tournamentMode : false,
      ),
    },
    middleware,
  };
  ctx.get = jest.fn((factory: () => unknown) => {
    const token = factory();
    if (token === ClientKeyProvider) return clientKeyProvider;
    if (token === MenuManager) return {};
    if (token === RoomManager) return { findByName: jest.fn() };
    return undefined;
  });
  return { ctx, middleware, clientKeyProvider };
}

function makeSnapshotRoom() {
  const duelRecord: any = {
    startTime: new Date('2026-04-29T00:00:00Z'),
    messages: [],
    responses: [],
    seed: [],
    players: [{}, {}],
  };
  const players = [
    {
      name: 'Alice',
      pos: 0,
      duelPos: 1,
      name_vpass: 'Alice#real',
      ip: '192.0.2.1',
    },
    {
      name: 'Bob',
      pos: 1,
      duelPos: 0,
      name_vpass: 'Bob#real',
      ip: '192.0.2.2',
    },
  ];
  const room: any = {
    name: 'MATCH#live',
    identifier: 'r'.repeat(64),
    hostinfo: { mode: 0 },
    duelRecords: [duelRecord],
    playingPlayers: players,
    score: [4, 2],
    get lastDuelRecord() {
      return duelRecord;
    },
    getDuelPos: jest.fn((client: any) => client.duelPos),
    getIngameDuelPos: jest.fn((client: any) => 1 - client.duelPos),
  };
  return { room, duelRecord, players };
}

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('cloud replay live save snapshots', () => {
  test('resolvePlayerScore uses duel pos instead of ingame duel pos', () => {
    const { room, players } = makeSnapshotRoom();

    expect(resolvePlayerScore(room, players[0] as any)).toBe(2);
    expect(room.getDuelPos).toHaveBeenCalledWith(players[0]);
    expect(room.getIngameDuelPos).not.toHaveBeenCalled();
  });

  test('mid-duel snapshot has null winReason and no winners', () => {
    const { ctx } = makeCtx(true);
    const service = new CloudReplayService(ctx);
    const { room } = makeSnapshotRoom();

    const snapshot = (service as any).createDuelRecordSnapshot(room, {
      swapped: true,
    });

    expect(snapshot.winReason).toBeNull();
    expect(snapshot.players.map((player: any) => player.winner)).toEqual([
      false,
      false,
    ]);
    expect(snapshot.players.map((player: any) => player.score)).toEqual([2, 4]);
  });

  test('finished snapshot marks the winning duel position', () => {
    const { ctx } = makeCtx(true);
    const service = new CloudReplayService(ctx);
    const { duelRecord, room } = makeSnapshotRoom();
    duelRecord.winReason = 1;

    const snapshot = (service as any).createDuelRecordSnapshot(room, {
      swapped: false,
      winPlayer: 1,
    });

    expect(snapshot.winReason).toBe(1);
    expect(snapshot.players.map((player: any) => player.winner)).toEqual([
      true,
      false,
    ]);
  });
});

describe('cloud replay live save hooks', () => {
  test('does not register mid-duel hooks when tournament mode is disabled', async () => {
    const { ctx, middleware } = makeCtx(false);
    const service = new CloudReplayService(ctx);

    await service.init();

    expect(middleware).toHaveBeenCalledTimes(1);
    expect(middleware).toHaveBeenCalledWith(OnRoomWin, expect.any(Function));
  });

  test('registers mid-duel hooks only in tournament mode', async () => {
    const { ctx, middleware } = makeCtx(true);
    const service = new CloudReplayService(ctx);

    await service.init();

    expect(middleware).toHaveBeenCalledWith(OnRoomWin, expect.any(Function));
    expect(middleware).toHaveBeenCalledWith(
      OnRoomReceiveResponse,
      expect.any(Function),
    );
    expect(middleware).toHaveBeenCalledWith(
      YGOProMsgResponseBase,
      expect.any(Function),
      true,
    );
  });

  test('waits for win-match saves before continuing room win flow', async () => {
    const { ctx, middleware } = makeCtx(false);
    const service = new CloudReplayService(ctx);
    const deferred = createDeferred();
    const saveFromWin = jest
      .spyOn(service as any, 'saveDuelRecordFromWinEvent')
      .mockReturnValue(deferred.promise);
    const next = jest.fn();

    await service.init();
    const handler = middleware.mock.calls.find(
      ([eventClass]) => eventClass === OnRoomWin,
    )?.[1];
    const handled = handler({ winMatch: true }, undefined, next);
    await Promise.resolve();

    expect(saveFromWin).toHaveBeenCalledWith({ winMatch: true });
    expect(next).not.toHaveBeenCalled();

    deferred.resolve();
    await handled;

    expect(next).toHaveBeenCalledTimes(1);
  });

  test('does not wait for non-match win saves before continuing room win flow', async () => {
    const { ctx, middleware } = makeCtx(false);
    const service = new CloudReplayService(ctx);
    const deferred = createDeferred();
    const saveFromWin = jest
      .spyOn(service as any, 'saveDuelRecordFromWinEvent')
      .mockReturnValue(deferred.promise);
    const next = jest.fn();

    await service.init();
    const handler = middleware.mock.calls.find(
      ([eventClass]) => eventClass === OnRoomWin,
    )?.[1];
    await handler({ winMatch: false }, undefined, next);

    expect(saveFromWin).toHaveBeenCalledWith({ winMatch: false });
    expect(next).toHaveBeenCalledTimes(1);

    deferred.resolve();
  });
});
