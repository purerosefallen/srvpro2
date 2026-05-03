import { YGOProMsgNewPhase, YGOProMsgNewTurn } from 'ygopro-msg-encode';
import { ClientKeyProvider } from '../src/feats/client-key-provider';
import {
  CloudReplayService,
  resolvePlayerScore,
} from '../src/feats/cloud-replay';
import { LegacyApiReplayService } from '../src/legacy-api';
import { LegacyRoomIdService } from '../src/legacy-api/legacy-room-id-service';
import { OnRoomWin, RoomManager } from '../src/room';
import { MenuManager } from '../src/feats/menu-manager';

function makeCtx(
  options: {
    tournamentMode?: boolean;
    instantWrite?: boolean;
    activeRooms?: any[];
  } = {},
) {
  const {
    tournamentMode = false,
    instantWrite = false,
    activeRooms = [],
  } = options;
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
      getBoolean: jest.fn((key: string) => {
        if (key === 'TOURNAMENT_MODE') return tournamentMode;
        if (key === 'CLOUD_REPLAY_INSTANT_WRITE') return instantWrite;
        return false;
      }),
    },
    middleware,
  };
  ctx.get = jest.fn((factory: () => unknown) => {
    const token = factory();
    if (token === ClientKeyProvider) return clientKeyProvider;
    if (token === MenuManager) return {};
    if (token === RoomManager) {
      return {
        allRooms: jest.fn(() => activeRooms),
        findByName: jest.fn(),
      };
    }
    return undefined;
  });
  return { ctx, middleware, clientKeyProvider };
}

function makeLegacyReplayCtx(activeRooms: any[] = []) {
  const roomIdService = {
    getRoomIdString: jest.fn((identifier: string) => `room:${identifier}`),
  };
  const ctx: any = {
    createLogger: () => ({
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
      error: jest.fn(),
    }),
    router: {
      get: jest.fn(),
    },
  };
  ctx.get = jest.fn((factory: () => unknown) => {
    const token = factory();
    if (token === LegacyRoomIdService) return roomIdService;
    if (token === CloudReplayService) return {};
    if (token === RoomManager) {
      return {
        allRooms: jest.fn(() => activeRooms),
      };
    }
    return undefined;
  });
  return { ctx, roomIdService };
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
    const { ctx } = makeCtx({ tournamentMode: true });
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
    const { ctx } = makeCtx({ tournamentMode: true });
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
  test('does not register instant hooks when instant write is disabled', async () => {
    const { ctx, middleware } = makeCtx();
    const service = new CloudReplayService(ctx);

    await service.init();

    expect(middleware).toHaveBeenCalledTimes(1);
    expect(middleware).toHaveBeenCalledWith(OnRoomWin, expect.any(Function));
  });

  test('registers instant hooks when instant write is enabled', async () => {
    const { ctx, middleware } = makeCtx({ instantWrite: true });
    const service = new CloudReplayService(ctx);

    await service.init();

    expect(middleware).toHaveBeenCalledWith(OnRoomWin, expect.any(Function));
    expect(middleware).toHaveBeenCalledWith(
      YGOProMsgNewTurn,
      expect.any(Function),
    );
    expect(middleware).toHaveBeenCalledWith(
      YGOProMsgNewPhase,
      expect.any(Function),
    );
  });

  test('waits for win-match saves before continuing room win flow', async () => {
    const { ctx, middleware } = makeCtx();
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
    const { ctx, middleware } = makeCtx();
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

describe('cloud replay dueling visibility', () => {
  test('filters active room identifiers instead of winReason', () => {
    const activeRoom = { identifier: 'active-room' };
    const { ctx } = makeCtx({ activeRooms: [activeRoom] });
    const service = new CloudReplayService(ctx);
    const qb = {
      andWhere: jest.fn().mockReturnThis(),
    };

    (service as any).filterActiveRoomReplays(qb);

    expect(qb.andWhere).toHaveBeenCalledWith(
      'replay.roomIdentifier NOT IN (:...activeRoomIdentifiers)',
      { activeRoomIdentifiers: ['active-room'] },
    );
    expect(qb.andWhere).not.toHaveBeenCalledWith(
      expect.stringContaining('winReason'),
      expect.anything(),
    );
  });

  test('legacy duel log hides cloud replay id while room is still active', () => {
    const activeRoom = { identifier: 'active-room' };
    const { ctx } = makeLegacyReplayCtx([activeRoom]);
    const service = new LegacyApiReplayService(ctx);
    const replay: any = {
      id: 123,
      endTime: new Date('2026-04-29T00:00:00Z'),
      name: 'MATCH#live',
      duelCount: 1,
      roomIdentifier: 'active-room',
      hostInfo: { mode: 0 },
      players: [],
    };

    const view = (service as any).toDuelLogViewJson(replay);

    expect(view.cloud_replay_id).toBe('');
    expect(view.replay_filename).toBe('123.yrp');
  });
});
