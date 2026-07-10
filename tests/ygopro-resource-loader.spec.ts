import { YGOProResourceLoader } from '../src/ygopro';

function makeCtx(refreshMinutes: number) {
  return {
    createLogger: () => ({
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
      error: jest.fn(),
    }),
    config: {
      getStringArray: (key: string) => (key === 'YGOPRO_PATH' ? [] : []),
      getString: () => '',
      getInt: (key: string) =>
        key === 'YGOPRO_RESOURCE_REFRESH_MINUTES' ? refreshMinutes : 0,
    },
  } as any;
}

describe('YGOProResourceLoader reload interval', () => {
  let loadYGOProCdbs: jest.SpyInstance;
  let setIntervalSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    setIntervalSpy = jest.spyOn(global, 'setInterval');
    loadYGOProCdbs = jest
      .spyOn(YGOProResourceLoader.prototype, 'loadYGOProCdbs')
      .mockResolvedValue({} as any);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('uses the default 10 minute reload interval', () => {
    new YGOProResourceLoader(makeCtx(Number.NaN));

    expect(setIntervalSpy).toHaveBeenCalledWith(
      expect.any(Function),
      10 * 60_000,
    );
    expect(loadYGOProCdbs).toHaveBeenCalledTimes(1);
  });

  test('uses the configured reload interval in minutes', () => {
    new YGOProResourceLoader(makeCtx(3));

    expect(setIntervalSpy).toHaveBeenCalledWith(
      expect.any(Function),
      3 * 60_000,
    );
  });

  test('falls back to 10 minutes for non-positive values', () => {
    new YGOProResourceLoader(makeCtx(0));

    expect(setIntervalSpy).toHaveBeenCalledWith(
      expect.any(Function),
      10 * 60_000,
    );
  });
});
