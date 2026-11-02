import YGOProDeck from 'ygopro-deck-encode';
import { YGOProStocReplay } from 'ygopro-msg-encode';
import { Client } from '../src/client';
import { BlockReplay } from '../src/feats/block-replay';
import { DefaultHostinfo, DuelRecord } from '../src/room';
import {
  createReplayLogSummary,
  summarizeReplayMessage,
  YGOProStocReplayCompressed,
} from '../src/replay';

const makeReplay = () => {
  const record = new DuelRecord(
    Array.from({ length: 32 }, () => 0xab),
    [
      {
        name: 'Alice',
        deck: new YGOProDeck({
          main: Array.from({ length: 60 }, () => 0x12345678),
          extra: [0x12345678],
        }),
      },
      {
        name: 'Bob',
        deck: new YGOProDeck({ main: [0x12345678] }),
      },
    ],
    false,
  );
  record.responses = Array.from({ length: 2_000 }, () =>
    Buffer.alloc(32, 0xab),
  );
  return record.toYrp({ hostinfo: DefaultHostinfo, isTag: false });
};

describe('YGOProStocReplayCompressed', () => {
  test('preserves replay wire bytes and copy type without recompression', () => {
    const replay = makeReplay();
    const payload = Buffer.from(replay.toYrp());
    const summary = createReplayLogSummary(replay, payload.byteLength);
    const compressed = new YGOProStocReplayCompressed(payload, summary);
    const regular = new YGOProStocReplay().fromPartial({ replay });

    expect(compressed).toBeInstanceOf(YGOProStocReplay);
    expect(compressed.toPayload()).toBe(payload);
    expect(compressed.toFullPayload()).toEqual(regular.toFullPayload());
    const copied = compressed.copy();
    expect(copied).toBeInstanceOf(YGOProStocReplayCompressed);
    expect(copied.toPayload()).toBe(payload);
  });

  test('serializes only a bounded replay summary', () => {
    const replay = makeReplay();
    const payload = Buffer.from(replay.toYrp());
    const compressed = new YGOProStocReplayCompressed(
      payload,
      createReplayLogSummary(replay, payload.byteLength),
    );
    const json = JSON.stringify(compressed);

    expect(JSON.parse(json)).toEqual({
      replay: {
        compressed: true,
        byteLength: payload.byteLength,
        responseCount: 2_000,
        players: ['Alice', 'Bob'],
      },
    });
    expect(json.length).toBeLessThan(512);
    expect(json).not.toContain('305419896');
    expect(json).not.toContain('"0":171');
  });

  test('summarizes a regular replay without calling toPayload', () => {
    const regular = new YGOProStocReplay().fromPartial({
      replay: makeReplay(),
    });
    const toPayload = jest
      .spyOn(regular, 'toPayload')
      .mockImplementation(() => {
        throw new Error('must not encode for logging');
      });

    expect(summarizeReplayMessage(regular)).toEqual({
      replay: {
        compressed: true,
        responseCount: 2_000,
        players: ['Alice', 'Bob'],
      },
    });
    expect(toPayload).not.toHaveBeenCalled();
  });

  test('Client.send does not log replay bodies while packet logging is disabled', async () => {
    const debug = jest.fn();
    const ctx: any = {
      createLogger: () => ({
        debug,
        warn: jest.fn(),
        info: jest.fn(),
        error: jest.fn(),
      }),
      dispatch: jest.fn(async (message) => message),
    };
    const client = new Client(ctx);
    client.disconnected = new Date();

    await client.send(
      new YGOProStocReplay().fromPartial({ replay: makeReplay() }),
      true,
    );

    expect(debug).not.toHaveBeenCalled();
  });

  test('remains compatible with BlockReplay middleware matching', async () => {
    let handler: any;
    const ctx: any = {
      config: { getBoolean: () => true },
      middleware: jest.fn((_type, registered) => {
        handler = registered;
      }),
    };
    const blockReplay = new BlockReplay(ctx);
    await blockReplay.init();
    const replay = makeReplay();
    const packet = new YGOProStocReplayCompressed(
      Buffer.from(replay.toYrp()),
      createReplayLogSummary(replay),
    );
    const next = jest.fn();

    await handler(packet, { roomName: 'room' }, next);
    expect(next).not.toHaveBeenCalled();
    await handler(packet, { roomName: undefined }, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
