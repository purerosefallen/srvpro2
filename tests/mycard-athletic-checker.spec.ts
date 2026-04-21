import YGOProDeck from 'ygopro-deck-encode';
import { RoomCheckDeck } from '../src/room';
import { AthleticChecker } from '../src/feats/mycard';

function makeCtx(overrides: Record<string, string> = {}) {
  const middlewares: any[] = [];
  return {
    middlewares,
    createLogger: () => ({
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
      error: jest.fn(),
    }),
    config: {
      getBoolean: (key: string) =>
        (overrides[key] ?? (key === 'ATHLETIC_CHECK_ENABLED' ? '1' : '0')) ===
        '1',
      getString: (key: string) =>
        overrides[key] ??
        ({
          ATHLETIC_CHECK_RANK_URL: 'https://rank.example',
          ATHLETIC_CHECK_IDENTIFIER_URL: 'https://identify.example',
          ATHLETIC_CHECK_FETCH_PARAMS: '{}',
        } as Record<string, string>)[key] ??
        '',
      getInt: (key: string) =>
        Number(
          overrides[key] ??
            ({
              ATHLETIC_CHECK_RANK_COUNT: '10',
              ATHLETIC_CHECK_BAN_COUNT: '1',
              ATHLETIC_CHECK_TTL: '600',
            } as Record<string, string>)[key] ??
            '0',
        ),
    },
    http: {
      get: jest.fn(async () => ({
        data: [{ name: 'Meta Deck' }],
      })),
      post: jest.fn(async () => ({
        data: { deck: 'Meta Deck' },
      })),
    },
    middleware: (_cls: unknown, handler: unknown) => {
      middlewares.push(handler);
      return undefined;
    },
  } as any;
}

describe('AthleticChecker RoomCheckDeck integration', () => {
  test('sets RoomCheckDeck value for banned athletic decks in arena rooms', async () => {
    const ctx = makeCtx();
    const checker = new AthleticChecker(ctx);
    await checker.init();
    const handler = ctx.middlewares[0];
    const room: any = { mycardArena: 'entertain' };
    const client: any = { name: 'player', sendChat: jest.fn() };
    const deck = new YGOProDeck({ main: [1], extra: [2], side: [3] });
    const event = new RoomCheckDeck(room, client, deck, {} as any);

    await handler(event, client, jest.fn());

    expect(event.value).toBeDefined();
    expect(client.sendChat).toHaveBeenCalledWith(
      '#{banned_athletic_deck_part1}1#{banned_athletic_deck_part2}',
      expect.any(Number),
    );
    expect(ctx.http.get).toHaveBeenCalledWith('https://rank.example', {
      timeout: 10000,
      responseType: 'json',
      params: {},
    });
    expect(ctx.http.post).toHaveBeenCalledWith(
      'https://identify.example',
      expect.any(URLSearchParams),
      {
        timeout: 10000,
        responseType: 'json',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      },
    );
    const [, body] = ctx.http.post.mock.calls[0];
    expect(body.get('deck')).toBe(deck.toYdkString());
  });

  test('does not check non-arena rooms', async () => {
    const ctx = makeCtx();
    const checker = new AthleticChecker(ctx);
    await checker.init();
    const handler = ctx.middlewares[0];
    const next = jest.fn();
    const client: any = { name: 'player', sendChat: jest.fn() };
    const event = new RoomCheckDeck(
      {} as any,
      client,
      new YGOProDeck({ main: [1] }),
      {} as any,
    );

    await handler(event, client, next);

    expect(event.value).toBeUndefined();
    expect(ctx.http.post).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });
});
