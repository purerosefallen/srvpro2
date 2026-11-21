import axios from 'axios';
import { AngelusService } from '../src/angelus';
import { serviceEndpoint } from '../src/utility/service-endpoint';
import { ConfigService } from '../src/services/config';
import { OcgcoreCommonConstants } from 'ygopro-msg-encode';

const success = (data: unknown) => ({ statusCode: 200, success: true, data });
function fixture(body: unknown, token = '') {
  const seen: { url: string; token: string; data: unknown }[] = [];
  const http = axios.create({
    adapter: async (config) => {
      seen.push({
        url: config.url,
        token: config.headers['x-server-token'],
        data: config.data,
      });
      if (body instanceof Error) throw body;
      return { status: 200, statusText: 'OK', config, headers: {}, data: body };
    },
  });
  const service = new AngelusService({
    http,
    config: {
      getString: (k) =>
        k === 'ANGELUS_TOKEN' ? token : 'wss://host:123/prefix',
    },
  } as any);
  return { service, seen };
}
test.each([
  ['http', 'http', 'ws'],
  ['https', 'https', 'wss'],
  ['ws', 'http', 'ws'],
  ['wss', 'https', 'wss'],
])('endpoint %s preserves the base path', (scheme, http, ws) => {
  expect(serviceEndpoint(scheme + '://host:123/prefix', 'http').href).toBe(
    http + '://host:123/prefix/',
  );
  expect(
    new URL('duel', serviceEndpoint(scheme + '://host:123/prefix/', 'ws')).href,
  ).toBe(ws + '://host:123/prefix/duel');
});
test.each(['', ' ', 'ftp://host', 'missing-host'])(
  'startup rejects %j',
  (value) => {
    const previous = process.env.ANGELUS_ENDPOINT;
    try {
      process.env.ANGELUS_ENDPOINT = value;
      expect(() => new ConfigService({} as any)).toThrow(
        'Please install and start ygoangelus, then set ANGELUS_ENDPOINT (for example, http://localhost:3001).',
      );
    } finally {
      if (previous == null) delete process.env.ANGELUS_ENDPOINT;
      else process.env.ANGELUS_ENDPOINT = previous;
    }
  },
);
test.each(['', 'test-only'])(
  'all HTTP operations use the configured transport and header %j',
  async (token) => {
    const a = fixture(
      success({
        lists: [
          { name: 'List', hash: 1 },
          { name: 'List (2)', hash: 2 },
        ],
      }),
      token,
    );
    expect(await a.service.lists()).toHaveLength(2);
    const b = fixture(
      success([{ code: 10, type: OcgcoreCommonConstants.TYPES_EXTRA_DECK }]),
      token,
    );
    expect(await b.service.extraCards([10, 2, 10])).toEqual(new Set([10]));
    expect(await b.service.extraCards([])).toEqual(new Set());
    expect(b.seen).toHaveLength(1);
    const c = fixture(
      success({ valid: false, error: { reason: 6, code: 2 } }),
      token,
    );
    expect(
      (
        await c.service.checkDeck({
          deck: 'ydke://!!!',
          rule: 0,
          limits: { minMain: 0 },
        })
      ).toPayload(),
    ).toBe(0x60000002);
    for (const item of [...a.seen, ...b.seen, ...c.seen]) {
      expect(item.token).toBe(token || undefined);
      expect(item.url).toMatch(/^https:\/\/host:123\/prefix\//);
    }
    expect(decodeURIComponent(b.seen[0].url)).toContain('id=10,2');
  },
);
test('valid empty lists and legal decks', async () => {
  expect(await fixture(success({ lists: [] })).service.lists()).toEqual([]);
  expect(
    await fixture(success({ valid: true })).service.checkDeck({
      deck: 'ydke://!!!',
    }),
  ).toBeUndefined();
});
test.each([
  success({}),
  { success: false, data: { lists: [] } },
  success({ lists: [{ name: 'A', hash: -1 }] }),
  new Error('timeout'),
])('rejects invalid banlist replies', async (body) => {
  await expect(fixture(body).service.lists()).rejects.toThrow();
});
test.each([
  success({ valid: false }),
  success({ valid: true, error: {} }),
  success({ valid: false, error: { reason: 20, code: 0 } }),
  new Error('404'),
])('rejects invalid deck replies', async (body) => {
  await expect(
    fixture(body).service.checkDeck({ deck: 'ydke://!!!' }),
  ).rejects.toThrow();
});
