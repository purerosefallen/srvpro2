import { BigBrotherService } from '../src/feats/mycard';
import { OnClientBadwordViolation } from '../src/feats/random-duel';

function makeLogger() {
  return {
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  };
}

function makeCtx(overrides: Record<string, string> = {}) {
  const handlers: any[] = [];
  const logger = makeLogger();
  const configValues: Record<string, string> = {
    BIG_BROTHER_ENABLED: '1',
    BIG_BROTHER_ACCESS_KEY: 'ak',
    BIG_BROTHER_POST: 'https://report.example/big-brother',
    ...overrides,
  };
  const ctx = {
    handlers,
    logger,
    createLogger: () => logger,
    config: {
      getBoolean: (key: string) => configValues[key] === '1',
      getString: (key: string) => configValues[key] || '',
    },
    http: {
      post: jest.fn(async () => ({
        status: 200,
        data: {},
      })),
    },
    middleware: jest.fn((eventType, handler) => {
      handlers.push({ eventType, handler });
    }),
  };
  return ctx as any;
}

describe('BigBrotherService', () => {
  test('posts srvpro-compatible report fields on badword violation', async () => {
    const ctx = makeCtx();
    const service = new BigBrotherService(ctx);
    await service.init();

    expect(ctx.middleware).toHaveBeenCalledWith(
      OnClientBadwordViolation,
      expect.any(Function),
    );
    await ctx.handlers[0].handler(
      new OnClientBadwordViolation(
        {
          name: 'Alice',
          ip: '127.0.0.1',
          isInternal: false,
        } as any,
        { name: 'room-a' } as any,
        'hello bad text',
        1,
        'hello ** text',
      ),
      undefined,
      jest.fn(),
    );

    expect(ctx.http.post).toHaveBeenCalledTimes(1);
    expect(ctx.http.post.mock.calls[0][0]).toBe(
      'https://report.example/big-brother',
    );
    const form = ctx.http.post.mock.calls[0][1] as URLSearchParams;
    expect(form.get('accesskey')).toBe('ak');
    expect(form.get('roomname')).toBe('room-a');
    expect(form.get('sender')).toBe('Alice');
    expect(form.get('ip')).toBe('127.0.0.1');
    expect(form.get('level')).toBe('1');
    expect(form.get('content')).toBe('hello bad text');
    expect(form.get('match')).toBe('bad');
  });

  test('does not register middleware when disabled', async () => {
    const ctx = makeCtx({
      BIG_BROTHER_ENABLED: '0',
    });
    const service = new BigBrotherService(ctx);
    await service.init();

    expect(ctx.middleware).not.toHaveBeenCalled();
  });
});
