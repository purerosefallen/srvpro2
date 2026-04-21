import YGOProDeck from 'ygopro-deck-encode';
import { MycardService } from '../src/feats/mycard';
import { DuelStage, RoomLeavePlayerReason } from '../src/room';

function makeCtx(overrides: Record<string, string> = {}) {
  const posted: URLSearchParams[] = [];
  const requested: any[] = [];
  const configValues: Record<string, string> = {
    MYCARD_ARENA_POST_SCORE: 'https://score.example',
    MYCARD_ARENA_ACCESS_KEY: 'key',
    MYCARD_ARENA_MATCH_API_URL: 'https://match.example',
    MYCARD_ARENA_MATCH_API_ACCESS_KEY: 'ak',
    MYCARD_ENABLED: '1',
    ...overrides,
  };
  return {
    posted,
    requested,
    createLogger: () => ({
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
      error: jest.fn(),
    }),
    config: {
      getBoolean: (key: string) => configValues[key] === '1',
      getString: (key: string) => configValues[key] || '',
      getInt: () => 0,
    },
    http: {
      post: jest.fn(async (_url, body: URLSearchParams) => {
        posted.push(body);
        return { status: 200, statusText: 'OK', data: {} };
      }),
      request: jest.fn(async (request) => {
        requested.push(request);
        return { data: {} };
      }),
    },
    get: () => ({
      allRooms: () => [],
      getHostinfo: () => ({}),
      registerTick: jest.fn(),
      enabled: false,
    }),
    middleware: jest.fn(),
  } as any;
}

describe('MycardService score post', () => {
  test('uses YGOProDeck.toYdkString for score deck fields', async () => {
    const ctx = makeCtx();
    const service = new MycardService(ctx);
    const deckA = new YGOProDeck({ main: [1, 2], extra: [3], side: [4] });
    const deckB = new YGOProDeck({ main: [5], extra: [], side: [] });
    const deckA2 = new YGOProDeck({ main: [1, 2, 6], extra: [3], side: [] });
    const deckB2 = new YGOProDeck({ main: [5, 7], extra: [], side: [] });
    const room: any = {
      name: 'M#room',
      mycardArena: 'athletic',
      mycardArenaStartTime: 'start',
      playingPlayers: [
        { pos: 0, name: 'Alice', name_vpass: 'Alice', deck: deckA },
        { pos: 1, name: 'Bob', name_vpass: 'Bob', deck: deckB },
      ],
      duelRecords: [],
      score: [0, 0],
      getDuelPos: (player: any) => player.pos,
      isTag: false,
      hostinfo: {},
    };

    (service as any).rememberArenaGameDecks(room);
    room.playingPlayers[0].deck = deckA2;
    room.playingPlayers[1].deck = deckB2;
    (service as any).rememberArenaGameDecks(room);
    const snapshot = (service as any).createArenaScoreSnapshot(room);
    await (service as any).postScoreSnapshot(snapshot);

    expect(ctx.posted).toHaveLength(1);
    expect(ctx.posted[0].get('userdeckA')).toBe(deckA.toYdkString());
    expect(ctx.posted[0].get('userdeckB')).toBe(deckB.toYdkString());
    expect(ctx.posted[0].get('userdeckAHistory')).toBe(
      [deckA.toYdkString(), deckA2.toYdkString()].join(','),
    );
  });

  test('posts room-start match api with srvpro fields', async () => {
    const ctx = makeCtx({
      MYCARD_ARENA_MATCH_API_ENABLED: '1',
    });
    const service = new MycardService(ctx);
    const room: any = {
      name: 'M#room',
      mycardArena: 'athletic',
      mycardArenaStartTime: '2026-04-21T12:00:00+08:00',
      playingPlayers: [
        { pos: 0, name: 'Alice' },
        { pos: 1, name: 'Bob' },
      ],
    };

    await (service as any).postArenaRoomStart(room);

    expect(ctx.requested).toHaveLength(1);
    expect(ctx.requested[0]).toMatchObject({
      method: 'POST',
      timeout: 30000,
    });
    const url = new URL(ctx.requested[0].url);
    expect(url.toString()).toBe(
      'https://match.example/room-start?ak=ak&usernameA=Alice&usernameB=Bob&roomname=M%23room&starttime=2026-04-21T12%3A00%3A00%2B08%3A00&arena=athletic',
    );
  });

  test('preserves handled arena penalty scores in score post', async () => {
    const ctx = makeCtx({
      MYCARD_ARENA_PUNISH_QUIT_BEFORE_MATCH: '1',
    });
    const service = new MycardService(ctx);
    const room: any = {
      name: 'M#room',
      mycardArena: 'athletic',
      duelStage: DuelStage.Begin,
      playingPlayers: [
        { pos: 0, name: 'Alice', name_vpass: 'Alice' },
        { pos: 1, name: 'Bob', name_vpass: 'Bob' },
      ],
      duelRecords: [],
      score: [0, 0],
      getDuelPos: (player: any) => player.pos,
      finalize: jest.fn(),
    };

    (service as any).ensureArenaScoreState(room);
    (service as any).handleArenaPlayerLeave(
      {
        room,
        reason: RoomLeavePlayerReason.Disconnect,
        bySystem: false,
      },
      room.playingPlayers[0],
    );
    const snapshot = (service as any).createArenaScoreSnapshot(room);
    await (service as any).postScoreSnapshot(snapshot);

    expect(ctx.posted[0].get('userscoreA')).toBe('-9');
    expect(ctx.posted[0].get('userscoreB')).toBe('0');
  });
});
