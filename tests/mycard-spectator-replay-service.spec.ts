import {
  NetPlayerType,
  YGOProStocChat,
  YGOProStocReplay,
} from 'ygopro-msg-encode';
import { Emitter } from '../src/services/emitter';
import {
  MycardSpectatorReplayService,
  MycardUser,
  OnMycardAuthenticated,
} from '../src/feats/mycard';
import {
  DefaultHostinfo,
  OnRoomCreate,
  OnRoomFinalize,
  OnRoomLeave,
  OnRoomObserverChange,
  Room,
} from '../src/room';
import {
  YGOProStocChatReplayHint,
  YGOProStocReplayCompressed,
} from '../src/replay';

async function createFixture(enabled = true) {
  const emitter = new Emitter({} as any);
  const ctx: any = {
    config: { getBoolean: () => enabled },
    middleware: emitter.middleware.bind(emitter),
    dispatch: emitter.dispatch.bind(emitter),
    createLogger: () => ({
      debug: jest.fn(),
      warn: jest.fn(),
      info: jest.fn(),
    }),
  };
  const service = new MycardSpectatorReplayService(ctx);
  await service.init();
  const rooms = new Map<string, any>();
  const room = async (name: string) => {
    if (!rooms.has(name)) {
      const finalizors: Array<(room: any) => void> = [];
      const value = {
        name,
        addFinalizor: (finalizor: (room: any) => void) =>
          finalizors.push(finalizor),
        finalizors,
      };
      rooms.set(name, value);
      await ctx.dispatch(new OnRoomCreate(value as any), undefined);
    }
    return rooms.get(name);
  };
  const client = async (username = 'alice', active = true) => {
    const value: any = { pos: 0 };
    await ctx.dispatch(
      new OnMycardAuthenticated({ username, active } as MycardUser),
      value,
    );
    return value;
  };
  const observe = async (value: any, name: string) => {
    value.pos = NetPlayerType.OBSERVER;
    value.roomName = name;
    await ctx.dispatch(new OnRoomObserverChange(await room(name), true), value);
  };
  const unobserve = async (value: any) => {
    value.pos = 0;
    await ctx.dispatch(
      new OnRoomObserverChange(await room(value.roomName), false),
      value,
    );
  };
  const leave = async (value: any) => {
    await ctx.dispatch(new OnRoomLeave(await room(value.roomName)), value);
  };
  const allowed = async (value: any, compressed = false) => {
    const packet = compressed
      ? new YGOProStocReplayCompressed(Buffer.alloc(0), {
          replay: { compressed: true, responseCount: 0, players: [] },
        })
      : new YGOProStocReplay();
    return !!(await ctx.dispatch(packet, value));
  };
  return {
    ctx,
    service,
    rooms,
    room,
    client,
    observe,
    unobserve,
    leave,
    allowed,
  };
}

describe('Mycard spectator replay policy', () => {
  test('default off and unauthenticated clients retain existing behavior', async () => {
    const fixture = await createFixture(false);
    const firstConnection = await fixture.client('inactive', false);
    await fixture.observe(firstConnection, 'one');
    expect(await fixture.allowed(firstConnection)).toBe(true);
    const enabled = await createFixture();
    const guest: any = {};
    await enabled.observe(guest, 'one');
    expect(await enabled.allowed(guest)).toBe(true);
  });

  test('inactive spectators are blocked for regular and compressed replay packets, duelists are not', async () => {
    const fixture = await createFixture();
    const firstConnection = await fixture.client('inactive', false);
    await fixture.observe(firstConnection, 'one');
    expect(await fixture.allowed(firstConnection)).toBe(false);
    expect(await fixture.allowed(firstConnection, true)).toBe(false);
    expect(
      await fixture.ctx.dispatch(
        new YGOProStocChatReplayHint().copy(),
        firstConnection,
      ),
    ).toBeUndefined();
    expect(
      await fixture.ctx.dispatch(new YGOProStocChat(), firstConnection),
    ).toBeInstanceOf(YGOProStocChat);
    await fixture.unobserve(firstConnection);
    expect(await fixture.allowed(firstConnection)).toBe(true);
    expect(
      await fixture.ctx.dispatch(
        new YGOProStocChatReplayHint().copy(),
        firstConnection,
      ),
    ).toBeInstanceOf(YGOProStocChatReplayHint);
    await fixture.observe(firstConnection, 'one');
    expect(await fixture.allowed(firstConnection)).toBe(false);
  });

  test('distinct tables block all sessions, duplicates count once, and role changes do not reset flags', async () => {
    const fixture = await createFixture();
    const firstConnection = await fixture.client();
    const duplicateConnection = await fixture.client();
    const secondConnection = await fixture.client();
    await fixture.observe(firstConnection, 'one');
    await fixture.observe(duplicateConnection, 'one');
    expect(await fixture.allowed(firstConnection)).toBe(true);
    await fixture.observe(secondConnection, 'two');
    for (const connection of [
      firstConnection,
      duplicateConnection,
      secondConnection,
    ]) {
      expect(await fixture.allowed(connection)).toBe(false);
    }
    await fixture.leave(secondConnection);
    await fixture.leave(duplicateConnection);
    expect(await fixture.allowed(firstConnection)).toBe(false);
    await fixture.unobserve(firstConnection);
    expect(await fixture.allowed(firstConnection)).toBe(true);
    await fixture.observe(firstConnection, 'one');
    expect(await fixture.allowed(firstConnection)).toBe(false);
    await fixture.leave(firstConnection);
    await fixture.observe(firstConnection, 'one');
    expect(await fixture.allowed(firstConnection)).toBe(true);
  });

  test('playing in another room does not count, and one duplicate disconnect does not remove the table', async () => {
    const fixture = await createFixture();
    const firstConnection = await fixture.client();
    const duplicateConnection = await fixture.client();
    const secondConnection = await fixture.client();
    secondConnection.roomName = 'playing';
    await fixture.observe(firstConnection, 'one');
    await fixture.observe(duplicateConnection, 'one');
    await fixture.leave(duplicateConnection);
    expect(await fixture.allowed(firstConnection)).toBe(true);
    expect(await fixture.allowed(secondConnection)).toBe(true);
    await fixture.observe(secondConnection, 'two');
    expect(await fixture.allowed(firstConnection)).toBe(false);
  });

  test('finalization retains restrictions through replay sending and releases registry entries afterwards', async () => {
    const fixture = await createFixture();
    const firstConnection = await fixture.client();
    const secondConnection = await fixture.client();
    await fixture.observe(firstConnection, 'one');
    await fixture.observe(secondConnection, 'two');
    const room = await fixture.room('one');
    await fixture.ctx.dispatch(new OnRoomFinalize(room), firstConnection);
    expect(await fixture.allowed(firstConnection)).toBe(false);
    for (const finalize of room.finalizors) {
      finalize(room);
    }
    await fixture.leave(secondConnection);
    const fresh = await fixture.client();
    await fixture.observe(fresh, 'new');
    expect(await fixture.allowed(fresh)).toBe(true);
    expect(await fixture.allowed(firstConnection)).toBe(false);
  });

  test('actual Room.join commits spectator policy before the first outgoing packet', async () => {
    const fixture = await createFixture();
    const room = new Room(fixture.ctx, 'actual', {}, DefaultHostinfo);
    const firstConnection = await fixture.client('inactive', false);
    const stop = new Error('stop after first send');
    firstConnection.send = jest.fn(async () => {
      expect(room.watchers.has(firstConnection)).toBe(true);
      expect(await fixture.allowed(firstConnection)).toBe(false);
      throw stop;
    });
    await expect(
      room.join(firstConnection, NetPlayerType.OBSERVER),
    ).rejects.toBe(stop);
    expect(firstConnection.send).toHaveBeenCalledTimes(1);
  });
});
