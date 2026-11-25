import YGOProDeck from 'ygopro-deck-encode';
import { HostInfo } from 'ygopro-msg-encode';
import { ShuffleVersion, YGOProYrp } from 'ygopro-yrp-encode';
import {
  CloudReplayService,
  DuelRecordEntity,
} from '../src/feats/cloud-replay';
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

const makeRecord = (playerCount: 2 | 4, responseCount = 3) => {
  const players = Array.from({ length: playerCount }, (_, index) => ({
    name: `Player${index}`,
    deck: new YGOProDeck({
      main: [1000 + index, 2000 + index],
      extra: [3000 + index],
      side: [4000 + index],
    }),
  }));
  const record = new DuelRecord(
    Array.from({ length: 32 }, (_, index) => index),
    players,
    false,
  );
  record.endTime = new Date('2026-09-22T00:01:00Z');
  record.responses = Array.from({ length: responseCount }, (_, index) =>
    Buffer.alloc(64, index & 0xff),
  );
  return record;
};

describe('ReplayEncodeWorker', () => {
  jest.setTimeout(30_000);

  test.each([
    ['single', 2 as const, 3, 0, ShuffleVersion.Other],
    ['tag', 4 as const, 3, 1, ShuffleVersion.None],
    ['large responses', 2 as const, 512, 0, ShuffleVersion.Other],
  ])(
    'encodes %s replay identically in shared memory',
    async (_, count, responses, noShuffleDeck, shuffleVersion) => {
      const service = new ReplayEncodeService(makeCtx() as any);
      const record = makeRecord(count, responses);
      const replayContext = {
        hostinfo: {
          ...DefaultHostinfo,
          mode: count === 4 ? 2 : 0,
          no_shuffle_deck: noShuffleDeck,
        },
        isTag: count === 4,
      };
      const expected = Buffer.from(record.toYrp(replayContext).toYrp());
      const mainThreadToYrp = jest
        .spyOn(YGOProYrp.prototype, 'toYrp')
        .mockImplementation(() => {
          throw new Error('main-thread toYrp must not run');
        });

      try {
        const payload = await service.encodePayload(record, replayContext);

        expect(payload).toEqual(expected);
        expect(mainThreadToYrp).not.toHaveBeenCalled();
        expect(Object.prototype.toString.call(payload.buffer)).toBe(
          '[object SharedArrayBuffer]',
        );
        const decoded = new YGOProYrp().fromYrp(payload);
        expect(payload[31]).toBe(shuffleVersion);
        expect(decoded.header?.shuffleVersion).toBe(shuffleVersion);
        expect(decoded.responses).toHaveLength(responses);
        expect(decoded.hostName).toBe('Player0');
        expect(decoded.clientName).toBe(count === 4 ? 'Player3' : 'Player1');
        mainThreadToYrp.mockRestore();
        expect(Buffer.from(decoded.toYrp())).toEqual(expected);
      } finally {
        jest.restoreAllMocks();
        await service.finalize();
      }
    },
  );

  test.each([
    ['no-shuffle room', 1, ShuffleVersion.None],
    ['legacy row without a shuffle flag', undefined, ShuffleVersion.Other],
  ])('exports a cloud replay from a %s', async (_, noShuffleDeck, expected) => {
    const service = new ReplayEncodeService(makeCtx() as any);
    const cloud = new CloudReplayService({
      ...makeCtx(),
      get: (factory: () => unknown) =>
        factory() === ReplayEncodeService ? service : undefined,
      config: { getBoolean: () => false },
    } as any);
    const hostInfo: Partial<HostInfo> = { ...DefaultHostinfo };
    if (noShuffleDeck === undefined) {
      delete hostInfo.no_shuffle_deck;
    } else {
      hostInfo.no_shuffle_deck = noShuffleDeck;
    }
    const record = Object.assign(new DuelRecordEntity(), {
      hostInfo,
      startTime: new Date('2026-11-20T01:00:00Z'),
      endTime: new Date('2026-11-20T01:03:00Z'),
      schemaVersion: 0,
      seed: Buffer.alloc(32).toString('base64'),
      messages: '',
      responses: '',
    });
    try {
      const payload = await cloud.buildReplayYrpPayload(record);
      expect(payload[31]).toBe(expected);
      expect(new YGOProYrp().fromYrp(payload).header?.shuffleVersion).toBe(
        expected,
      );
    } finally {
      await service.finalize();
    }
  });
});
