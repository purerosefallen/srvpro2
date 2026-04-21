import { MycardService } from '../src/feats/mycard';
import { OnRoomJoin } from '../src/room';

function makeClient(name = 'Alice', overrides: Record<string, unknown> = {}) {
  return {
    name,
    isInternal: false,
    isLocal: false,
    sendChat: jest.fn(),
    ...overrides,
  } as any;
}

function makeCtx() {
  const middlewares = new Map<unknown, any>();
  const httpGet = jest.fn(async () => ({
    data: {
      exp: 123,
      pt: 456.2,
      arena_rank: 7,
    },
  }));
  const ctx = {
    createLogger: () => ({
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
      error: jest.fn(),
    }),
    config: {
      getBoolean: (key: string) => key === 'MYCARD_ENABLED',
      getString: (key: string) => {
        switch (key) {
          case 'MYCARD_ARENA_MODE':
            return 'athletic';
          case 'MYCARD_ARENA_GET_SCORE':
            return 'https://arena.example/user';
          case 'MYCARD_ARENA_GET_SCORE_PARAM':
            return 'username';
          default:
            return '';
        }
      },
      getInt: () => 0,
    },
    http: {
      get: httpGet,
      request: jest.fn(),
    },
    get: jest.fn((factory: () => unknown) => {
      const token = factory();
      switch ((token as any)?.name) {
        case 'WaitForPlayerProvider':
          return {
            registerTick: jest.fn(),
          };
        case 'RoomManager':
          return {
            findByName: jest.fn(),
          };
        case 'BadwordProvider':
          return {
            getBadwordLevel: jest.fn(async () => 0),
          };
        default:
          return undefined;
      }
    }),
    middleware: jest.fn((cls: unknown, handler: unknown) => {
      middlewares.set(cls, handler);
      return ctx;
    }),
  } as any;
  return {
    ctx,
    httpGet,
    middlewares,
  };
}

describe('MycardService arena score notice', () => {
  test('shows score on any room join when mycard is enabled', async () => {
    const { ctx, httpGet, middlewares } = makeCtx();
    const service = new MycardService(ctx);
    await service.init();

    const client = makeClient('Alice');
    const room = { name: 'normal-room' } as any;
    const next = jest.fn(async () => undefined);

    await middlewares.get(OnRoomJoin)(new OnRoomJoin(room), client, next);

    expect(httpGet).toHaveBeenCalledWith(
      'https://arena.example/user?username=Alice',
      expect.objectContaining({
        responseType: 'json',
      }),
    );
    expect(client.sendChat).toHaveBeenCalledWith(
      expect.stringContaining('Alice#{exp_value_part1}123'),
      expect.any(Number),
    );
    expect(next).toHaveBeenCalled();
  });

  test('skips score notice for internal clients', async () => {
    const { ctx, httpGet, middlewares } = makeCtx();
    const service = new MycardService(ctx);
    await service.init();

    const client = makeClient('Windbot', {
      isInternal: true,
    });

    await middlewares.get(OnRoomJoin)(
      new OnRoomJoin({ name: 'normal-room' } as any),
      client,
      jest.fn(async () => undefined),
    );

    expect(httpGet).not.toHaveBeenCalled();
    expect(client.sendChat).not.toHaveBeenCalled();
  });
});
