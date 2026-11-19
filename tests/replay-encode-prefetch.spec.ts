import YGOProDeck from 'ygopro-deck-encode';
import { DefaultHostinfo, DuelRecord } from '../src/room';
import { ReplayEncodeService } from '../src/replay';

const makeCtx = () => ({
  createLogger: () => ({
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  }),
});

const replayContext = {
  hostinfo: { ...DefaultHostinfo },
  isTag: false,
};

const makeRecord = (name: string) => {
  const record = new DuelRecord(
    Array.from({ length: 32 }, () => 1),
    [
      { name, deck: new YGOProDeck({ main: [1] }) },
      { name: `${name}-2`, deck: new YGOProDeck({ main: [2] }) },
    ],
    false,
  );
  record.responses = [Buffer.from([1, 2, 3])];
  record.endTime = new Date('2026-11-19T00:01:00Z');
  return record;
};

/** A worker whose encodes finish only when the test releases them, in order. */
const makeManualWorker = () => {
  const releases: Array<() => void> = [];
  const encode = jest.fn(
    () =>
      new Promise<Buffer>((resolve) => {
        releases.push(() => resolve(Buffer.from([releases.length])));
      }),
  );
  return {
    worker: { encode, finalize: jest.fn(async () => undefined), workerStatus: jest.fn() },
    encode,
    release: async () => {
      releases.shift()!();
      await new Promise((r) => setImmediate(r));
    },
  };
};

const tick = () => new Promise((r) => setImmediate(r));

describe('ReplayEncodeService.prefetch', () => {
  test('a prefetch result is reused by the waited call: one encode', async () => {
    const service = new ReplayEncodeService(makeCtx() as any);
    const w = makeManualWorker();
    (service as any).workerFactory = jest.fn(async () => w.worker);
    const record = makeRecord('A');

    service.prefetch(record, replayContext);
    await tick();
    expect(w.encode).toHaveBeenCalledTimes(1);
    const packet = service.encodePacket(record, replayContext);
    await w.release();
    await packet;
    expect(w.encode).toHaveBeenCalledTimes(1);
    await service.finalize();
  });

  test('a prefetch waits while a waited encode is running', async () => {
    const service = new ReplayEncodeService(makeCtx() as any);
    const w = makeManualWorker();
    (service as any).workerFactory = jest.fn(async () => w.worker);
    const waited = makeRecord('W');
    const early = makeRecord('P');

    const waitedPacket = service.encodePacket(waited, replayContext);
    await tick();
    service.prefetch(early, replayContext);
    await tick();
    expect(w.encode).toHaveBeenCalledTimes(1);

    await w.release();
    await waitedPacket;
    await tick();
    expect(w.encode).toHaveBeenCalledTimes(2);
    await w.release();
    await service.finalize();
  });

  test('queued prefetches do not go ahead of a waited encode', async () => {
    const service = new ReplayEncodeService(makeCtx() as any);
    const w = makeManualWorker();
    (service as any).workerFactory = jest.fn(async () => w.worker);
    const [p1, p2, p3] = ['P1', 'P2', 'P3'].map(makeRecord);
    const waited = makeRecord('W');

    service.prefetch(p1, replayContext);
    service.prefetch(p2, replayContext);
    service.prefetch(p3, replayContext);
    await tick();
    // Only the first prefetch has started.
    expect(w.encode).toHaveBeenCalledTimes(1);

    const waitedPacket = service.encodePacket(waited, replayContext);
    await tick();
    // The waited encode is sent to the worker now, behind only P1.
    expect(w.encode).toHaveBeenCalledTimes(2);
    await w.release(); // P1
    await w.release(); // W
    await waitedPacket;
    await tick();
    // P2 resumes only after the waited encode is done.
    expect(w.encode).toHaveBeenCalledTimes(3);
    await w.release();
    await tick();
    await w.release();
    await service.finalize();
  });
});
