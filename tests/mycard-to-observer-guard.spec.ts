import { YGOProCtosHsToObserver } from 'ygopro-msg-encode';
import { MycardService } from '../src/feats/mycard';

function makeCtx(room: any) {
  const middlewares = new Map<unknown, any>();
  return {
    middlewares,
    createLogger: () => ({
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
      error: jest.fn(),
    }),
    config: {
      getBoolean: (key: string) => key === 'MYCARD_ENABLED',
      getString: () => '',
      getInt: () => 0,
    },
    http: {
      request: jest.fn(),
    },
    get: () => ({
      findByName: (name: string) => (name === room?.name ? room : undefined),
      allRooms: () => [],
      getHostinfo: () => ({}),
      registerTick: jest.fn(),
      enabled: false,
    }),
    middleware: (cls: unknown, handler: unknown) => {
      middlewares.set(cls, handler);
      return undefined;
    },
  } as any;
}

describe('MycardService to observer guard', () => {
  test('blocks arena players from switching to observer', async () => {
    const ctx = makeCtx({ name: 'M#room', mycardArena: 'athletic' });
    const service = new MycardService(ctx);
    await service.init();
    const handler = ctx.middlewares.get(YGOProCtosHsToObserver);
    const client: any = {
      roomName: 'M#room',
      sendChat: jest.fn(),
    };
    const next = jest.fn();

    await handler(new YGOProCtosHsToObserver(), client, next);

    expect(client.sendChat).toHaveBeenCalledWith(
      '#{cannot_to_observer}',
      expect.any(Number),
    );
    expect(next).not.toHaveBeenCalled();
  });

  test('allows non-arena rooms to use normal observer flow', async () => {
    const ctx = makeCtx({ name: 'casual-room' });
    const service = new MycardService(ctx);
    await service.init();
    const handler = ctx.middlewares.get(YGOProCtosHsToObserver);
    const client: any = {
      roomName: 'casual-room',
      sendChat: jest.fn(),
    };
    const next = jest.fn();

    await handler(new YGOProCtosHsToObserver(), client, next);

    expect(client.sendChat).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });
});
