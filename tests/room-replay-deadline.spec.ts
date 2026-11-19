import { YGOProStocDuelEnd } from 'ygopro-msg-encode';
import { ReplayEncodeService } from '../src/replay';
import { DefaultHostInfoProvider, DuelStage, Room } from '../src/room';

const ready = { ready: true } as any;

/** A Room whose encoder gives duel 1 at once and never finishes duel 2. */
function makeRoom() {
  const warn = jest.fn();
  const encodePacket = jest.fn((record: { duel: number }) =>
    record.duel === 1 ? Promise.resolve(ready) : new Promise(() => undefined),
  );
  const ctx: any = {
    createLogger: () => ({ warn, info: jest.fn(), debug: jest.fn(), error: jest.fn() }),
    config: { getString: () => '', getBoolean: () => false, getInt: () => 0 },
    dispatch: jest.fn(async () => undefined),
  };
  const hostInfoProvider = new DefaultHostInfoProvider(ctx);
  ctx.get = jest.fn((factory: () => unknown) => {
    const token = factory();
    if (token === DefaultHostInfoProvider) return hostInfoProvider;
    if (token === ReplayEncodeService) return { encodePacket };
    return undefined;
  });
  const room = new Room(ctx, 'replay-deadline');
  room.duelStage = DuelStage.End;
  room.duelRecords = [{ duel: 1 } as any, { duel: 2 } as any];
  return { room, warn };
}

function makeClient(name: string) {
  return {
    name,
    isInternal: false,
    pos: 0,
    deck: {},
    sendChat: jest.fn(async () => undefined),
    send: jest.fn(async () => undefined),
    disconnect: jest.fn(),
  } as any;
}

describe('Room replay sending at the end of a match', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('a replay not ready within 5 s is left out with a notice; DUEL_END follows', async () => {
    const { room } = makeRoom();
    const client = makeClient('alice');
    let done = false;
    const kicked = room.kick(client, true).then(() => (done = true));

    await jest.advanceTimersByTimeAsync(4_900);
    expect(done).toBe(false);
    await jest.advanceTimersByTimeAsync(200);
    await kicked;

    const sent = client.send.mock.calls.map(([packet]: [unknown]) => packet);
    expect(sent[0]).toBe(ready);
    expect(sent[1]).toBeInstanceOf(YGOProStocDuelEnd);
    expect(sent).toHaveLength(2);
    const chats = client.sendChat.mock.calls.map(([text]: [string]) => text);
    expect(chats).toContain('#{replay_hint_part1}1#{replay_hint_part2}');
    expect(chats).toContain('#{replay_not_ready_part1}2#{replay_not_ready_part2}');
    expect(client.disconnect).toHaveBeenCalled();
  });

  test('the deadline is shared: a later client does not wait another 5 s', async () => {
    const { room, warn } = makeRoom();
    (room as any).replaySendDeadline = Date.now() + 5_000;
    const first = room.kick(makeClient('alice'), true);
    await jest.advanceTimersByTimeAsync(5_100);
    await first;

    const second = makeClient('bob');
    let done = false;
    const kicked = room.kick(second, true).then(() => (done = true));
    await jest.advanceTimersByTimeAsync(10);
    expect(done).toBe(true);
    await kicked;
    expect(second.send.mock.calls.at(-1)?.[0]).toBeInstanceOf(YGOProStocDuelEnd);
    // One warning for the missing duel, not one per client.
    expect(warn.mock.calls.filter(([, msg]: [unknown, string]) => msg === 'Replay not ready in time; not sent')).toHaveLength(1);
  });
});
