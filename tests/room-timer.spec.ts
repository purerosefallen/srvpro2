import {
  YGOProCtosResponse,
  YGOProCtosTimeConfirm,
  YGOProMsgSelectYesNo,
  YGOProStocTimeLimit,
} from 'ygopro-msg-encode';
import {
  DefaultHostinfo,
  DefaultHostInfoProvider,
  DuelStage,
  Room,
} from '../src/room';
import { RefreshFieldService } from '../src/feats/reconnect/refresh-field-service';
import { TimerState } from '../src/room/timer-state';

function makeRoom(tag = false, swapped = false) {
  const ctx: any = {
    createLogger: () => ({
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
      error: jest.fn(),
    }),
    config: { getString: () => '', getBoolean: () => false, getInt: () => 0 },
    dispatch: jest.fn(async (event) => event),
  };
  const hostInfoProvider = new DefaultHostInfoProvider(ctx);
  ctx.get = jest.fn((factory) =>
    factory() === DefaultHostInfoProvider ? hostInfoProvider : undefined,
  );
  const room = new Room(
    ctx,
    'timer-room',
    {},
    { ...DefaultHostinfo, mode: tag ? 2 : 0, time_limit: 180 },
  );
  room.duelStage = DuelStage.Dueling;
  room.isPosSwapped = swapped;
  room.turnCount = 1;
  const clients = Array.from(
    { length: tag ? 4 : 2 },
    (_, pos) => ({ pos, send: jest.fn(async () => undefined) }) as any,
  );
  clients.forEach((client, pos) => (room.players[pos] = client));
  room.timerState.reset(180_000);
  room.setLastResponseRequestMsg(
    new YGOProMsgSelectYesNo().fromPartial({
      player: swapped ? 1 : 0,
      desc: 1,
    }),
  );
  const win = jest.spyOn(room, 'win').mockResolvedValue(undefined as never);
  return { room, clients, win, ctx };
}

describe('Room authoritative timer readiness', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(1000);
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('protects a one-second bank through a twelve-second cut-in and ignores other or duplicate ACKs', async () => {
    const { room, clients, win } = makeRoom();
    room.timerState.leftMs[0] = 1000;
    await room.setResponseTimer(0);
    await (room as any).onTimeConfirm(clients[1], new YGOProCtosTimeConfirm());
    await jest.advanceTimersByTimeAsync(12_000);
    expect(win).not.toHaveBeenCalled();
    expect(room.timerState.leftMs[0]).toBe(1000);
    await (room as any).onTimeConfirm(clients[0], new YGOProCtosTimeConfirm());
    const started = room.timerState.startedAtMs;
    await jest.advanceTimersByTimeAsync(500);
    await (room as any).onTimeConfirm(clients[0], new YGOProCtosTimeConfirm());
    expect(room.timerState.startedAtMs).toBe(started);
    clients.forEach((client) =>
      expect(
        client.send.mock.calls.filter(
          ([msg]: any[]) => msg instanceof YGOProStocTimeLimit,
        ),
      ).toHaveLength(1),
    );
    await jest.advanceTimersByTimeAsync(500);
    expect(win).toHaveBeenCalledWith({ player: 1, type: 3 });
  });

  it('expires an exhausted bank before a queued response can refund or pass the turn', async () => {
    const { room, clients, win } = makeRoom();
    room.timerState.leftMs[0] = 0;
    room.ocgcore = { setResponse: jest.fn() } as any;
    const setResponse = room.ocgcore!.setResponse as jest.Mock;
    await room.setResponseTimer(0);
    await (room as any).onTimeConfirm(clients[0], new YGOProCtosTimeConfirm());
    await (room as any).onResponse(
      clients[0],
      new YGOProCtosResponse().fromPartial({
        response: Buffer.from([1, 0, 0, 0]),
      }),
    );
    expect(win).toHaveBeenCalledTimes(1);
    expect(setResponse).not.toHaveBeenCalled();
    expect(room.timerState.leftMs[0]).toBe(0);
  });

  it('times out a client that never acknowledges readiness', async () => {
    const { room, win } = makeRoom();
    await room.setResponseTimer(0);
    await jest.advanceTimersByTimeAsync(
      180_000 + TimerState.MAX_READINESS_GRACE_MS,
    );
    expect(win).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    'reconnect preserves the active bank and deadline, tag=%s',
    async (tag) => {
      for (const swapped of [false, true]) {
        for (const awaitingConfirm of [false, true]) {
          const { room, clients, ctx } = makeRoom(tag, swapped);
          room.ocgcore = {
            queryFieldCard: jest.fn(async () => ({ cards: [] })),
          } as any;
          room.timerState.leftMs = [91_000, 73_000];
          await room.setResponseTimer(0, { awaitingConfirm });
          const start = room.timerState.startedAtMs;
          await jest.advanceTimersByTimeAsync(2000);
          const service = new RefreshFieldService(ctx);
          jest.spyOn(service as any, 'requestField').mockResolvedValue({});
          jest
            .spyOn(service as any, 'sendRefreshMessages')
            .mockResolvedValue(undefined);
          for (const client of clients) {
            for (let repetition = 0; repetition < 2; repetition++) {
              client.send.mockClear();
              await service.sendRefreshFieldMessages(client, room);
              const snapshots = client.send.mock.calls
                .map(([msg]: any[]) => msg)
                .filter((msg: any) => msg instanceof YGOProStocTimeLimit);
              expect(
                snapshots.map((msg: any) => [msg.player, msg.left_time]),
              ).toEqual([
                [swapped ? 0 : 1, 73],
                [swapped ? 1 : 0, awaitingConfirm ? 91 : 89],
              ]);
              expect(room.timerState.startedAtMs).toBe(start);
              expect(room.timerState.awaitingConfirm).toBe(awaitingConfirm);
              expect(jest.getTimerCount()).toBe(1);
            }
          }
          room.timerState.clear();
        }
      }
    },
  );

  it('settles a late ACK without adding its delay to the server deadline', async () => {
    const { room, clients, win } = makeRoom();
    room.timerState.leftMs[0] = 10_000;
    await room.setResponseTimer(0);
    await jest.advanceTimersByTimeAsync(35_000);
    await (room as any).onTimeConfirm(clients[0], new YGOProCtosTimeConfirm());
    expect(room.timerState.leftMs[0]).toBe(5000);
    expect(room.timerState.readinessMs).toEqual([150_000, 180_000]);
    await jest.advanceTimersByTimeAsync(4999);
    expect(win).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(win).toHaveBeenCalledTimes(1);
  });

  it('settles direct responses and does not refill readiness on a refund or new turn', async () => {
    const { room, clients, win } = makeRoom();
    room.duelRecords = [{ responses: [] }] as any;
    room.ocgcore = { setResponse: jest.fn(async () => undefined) } as any;
    jest.spyOn(room as any, 'advance').mockResolvedValue(undefined);
    room.timerState.leftMs[0] = 10_000;
    await room.setResponseTimer(0);
    await jest.advanceTimersByTimeAsync(35_000);
    await (room as any).onResponse(
      clients[0],
      new YGOProCtosResponse().fromPartial({ response: Buffer.from([1]) }),
    );
    expect(room.ocgcore!.setResponse).toHaveBeenCalledTimes(1);
    expect(room.timerState.leftMs[0]).toBe(6000); // Five seconds spent, one refunded.
    expect(room.timerState.readinessMs).toEqual([150_000, 180_000]);
    await (room as any).onNewTurn(1);
    expect(room.timerState.leftMs).toEqual([180_000, 180_000]);
    expect(room.timerState.readinessMs).toEqual([150_000, 180_000]);
    expect(win).not.toHaveBeenCalled();
    (room as any).resetResponseRequestState();
    expect(room.timerState.readinessMs).toEqual([180_000, 180_000]);
  });

  it.each(['ack', 'response'])(
    'rejects a queued %s at the deadline before the timeout callback runs',
    async (kind) => {
      const { room, clients, win } = makeRoom();
      room.duelRecords = [{ responses: [] }] as any;
      room.ocgcore = { setResponse: jest.fn() } as any;
      room.timerState.leftMs[0] = 1000;
      await room.setResponseTimer(0);
      // Move wall time without running callbacks: the packet wins event-loop order.
      jest.setSystemTime(32_000);
      const response = new YGOProCtosResponse().fromPartial({
        response: Buffer.from([1]),
      });
      if (kind === 'ack') {
        await (room as any).onTimeConfirm(
          clients[0],
          new YGOProCtosTimeConfirm(),
        );
      } else {
        await (room as any).onResponse(clients[0], response);
      }
      await (room as any).onResponse(clients[0], response);
      await (room as any).onTimeConfirm(
        clients[0],
        new YGOProCtosTimeConfirm(),
      );
      expect(win).toHaveBeenCalledTimes(1);
      expect(room.ocgcore!.setResponse).not.toHaveBeenCalled();
      expect(room.lastDuelRecord.responses).toHaveLength(0);
      expect(room.timerState.leftMs[0]).toBe(0);
    },
  );

  it('reports bank consumption after grace without restarting readiness on reconnect', async () => {
    const { room, clients, ctx } = makeRoom();
    room.ocgcore = {
      queryFieldCard: jest.fn(async () => ({ cards: [] })),
    } as any;
    await room.setResponseTimer(0);
    const started = room.timerState.startedAtMs;
    await jest.advanceTimersByTimeAsync(35_000);
    const service = new RefreshFieldService(ctx);
    jest.spyOn(service as any, 'requestField').mockResolvedValue({});
    jest
      .spyOn(service as any, 'sendRefreshMessages')
      .mockResolvedValue(undefined);
    clients[0].send.mockClear();
    await service.sendRefreshFieldMessages(clients[0], room);
    const snapshots = clients[0].send.mock.calls
      .map(([msg]: any[]) => msg)
      .filter((msg: any) => msg instanceof YGOProStocTimeLimit);
    expect(snapshots.map((msg: any) => [msg.player, msg.left_time])).toEqual([
      [1, 180],
      [0, 175],
    ]);
    expect(room.timerState.startedAtMs).toBe(started);
    expect(room.timerState.awaitingConfirm).toBe(true);
    expect(jest.getTimerCount()).toBe(1);
    await (room as any).onTimeConfirm(clients[0], new YGOProCtosTimeConfirm());
    expect(room.timerState.readinessMs[0]).toBe(150_000);
    expect(room.timerState.leftMs[0]).toBe(175_000);
  });

  it.each([false, true])(
    'eventually expires repeated 55-second waits, lateACK=%s',
    async (lateAck) => {
      const { room, clients, win } = makeRoom();
      room.duelRecords = [{ responses: [] }] as any;
      room.ocgcore = { setResponse: jest.fn(async () => undefined) } as any;
      jest.spyOn(room as any, 'advance').mockResolvedValue(undefined);
      for (let prompt = 0; prompt < 7; prompt++) {
        room.setLastResponseRequestMsg(
          new YGOProMsgSelectYesNo().fromPartial({ player: 0, desc: 1 }),
        );
        await room.setResponseTimer(0);
        await jest.advanceTimersByTimeAsync(55_000);
        if (lateAck) {
          await (room as any).onTimeConfirm(
            clients[0],
            new YGOProCtosTimeConfirm(),
          );
        }
        await (room as any).onResponse(
          clients[0],
          new YGOProCtosResponse().fromPartial({ response: Buffer.from([1]) }),
        );
        if (prompt === 5) {
          expect(room.timerState.readinessMs).toEqual([0, 180_000]);
          expect(room.timerState.leftMs[0]).toBe(36_000);
          expect(win).not.toHaveBeenCalled();
        }
      }
      expect(win).toHaveBeenCalledTimes(1);
      expect(room.ocgcore!.setResponse).toHaveBeenCalledTimes(6);
      expect(room.lastDuelRecord.responses).toHaveLength(6);
      expect(room.timerState.leftMs[0]).toBe(0);
    },
  );
});
