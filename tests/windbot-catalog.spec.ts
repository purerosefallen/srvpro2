import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WindBotProvider } from '../src/feats/windbot';

function provider(file: string) {
  const ctx = {
    config: {
      getBoolean: () => true,
      getInt: () => 0,
      getString: (key: string) =>
        key === 'WINDBOT_BOTLIST' ? file : 'wss://windbot:2399/base/',
    },
    createLogger: () => ({ warn: jest.fn() }),
    get: () => ({}),
    http: { get: jest.fn() },
  };
  return { catalog: new WindBotProvider(ctx as any), get: ctx.http.get };
}
const list = (name: string) => ({
  windbots: [
    { name, deck: 'Burn' },
    { name: 'hidden', deck: 'Blue-Eyes', hidden: true },
  ],
});
test('reads fresh file data for each action and never falls back to HTTP', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'windbot-list-'));
  try {
    const file = path.join(dir, 'bots.json'),
      { catalog, get } = provider(file);
    for (const name of ['A', 'B']) {
      await fs.writeFile(file, JSON.stringify(list(name)));
      const bots = await catalog.loadBotList();
      expect(catalog.selectBot(bots).name).toBe(name);
      expect(catalog.selectBot(bots, 'Blue-Eyes').name).toBe('hidden');
    }
    await fs.unlink(file);
    expect(await catalog.loadBotList()).toEqual([]);
    expect(get).not.toHaveBeenCalled();
  } finally {
    await fs.rm(dir, { recursive: true });
  }
});
test('reads fresh HTTPS data on each action, recovers after failure', async () => {
  const { catalog, get } = provider('');
  get
    .mockResolvedValueOnce({ data: list('A') })
    .mockResolvedValueOnce({ data: {} })
    .mockRejectedValueOnce(new Error('timeout'))
    .mockResolvedValueOnce({ data: list('B') });
  expect((await catalog.loadBotList())[0].name).toBe('A');
  expect(await catalog.loadBotList()).toEqual([]);
  expect(await catalog.loadBotList()).toEqual([]);
  expect((await catalog.loadBotList())[0].name).toBe('B');
  expect(get).toHaveBeenCalledTimes(4);
  expect(get.mock.calls[0][0]).toBe('https://windbot:2399/base/bots');
});
