import { HandResult, YGOProCtosHandResult } from 'ygopro-msg-encode';
import {
  DefaultHostinfo,
  DefaultHostInfoProvider,
  DuelStage,
  Room,
} from '../src/room';

function makeCtx() {
  const ctx: any = {
    createLogger: () => ({
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
      error: jest.fn(),
    }),
    config: {
      getString: () => '',
      getBoolean: () => false,
      getInt: () => 0,
    },
    dispatch: jest.fn(async (event) => event),
  };
  const hostInfoProvider = new DefaultHostInfoProvider(ctx);
  ctx.get = jest.fn((factory: () => unknown) => {
    const token = factory();
    if (token === DefaultHostInfoProvider) {
      return hostInfoProvider;
    }
    return undefined;
  });
  return ctx;
}

function makeRoom(mode = 0) {
  const room = new Room(
    makeCtx(),
    'room',
    {},
    {
      ...DefaultHostinfo,
      mode,
    },
  );
  room.duelStage = DuelStage.Finger;
  return room;
}

function makeClient(pos: number) {
  return {
    pos,
    send: jest.fn(async () => undefined),
  } as any;
}

function handResult(res: HandResult) {
  return new YGOProCtosHandResult().fromPartial({ res });
}

describe('Room opening hand result', () => {
  test('ignores a second hand result from the same side before resolution', async () => {
    const room = makeRoom();
    const player0 = makeClient(0);
    const player1 = makeClient(1);
    room.players[0] = player0;
    room.players[1] = player1;

    await (room as any).onHandResult(player0, handResult(HandResult.ROCK));
    await (room as any).onHandResult(player0, handResult(HandResult.PAPER));

    expect(room.handResult).toEqual([HandResult.ROCK, 0]);
  });

  test('ignores tag hand results from non-first players on each side', async () => {
    const room = makeRoom(2);
    const player0 = makeClient(0);
    const player1 = makeClient(1);
    const player2 = makeClient(2);
    const player3 = makeClient(3);
    room.players[0] = player0;
    room.players[1] = player1;
    room.players[2] = player2;
    room.players[3] = player3;

    await (room as any).onHandResult(player1, handResult(HandResult.ROCK));
    await (room as any).onHandResult(player3, handResult(HandResult.PAPER));

    expect(room.handResult).toEqual([0, 0]);

    await (room as any).onHandResult(player0, handResult(HandResult.ROCK));
    expect(room.handResult).toEqual([HandResult.ROCK, 0]);

    room.handResult = [0, 0];
    await (room as any).onHandResult(player2, handResult(HandResult.PAPER));
    expect(room.handResult).toEqual([0, HandResult.PAPER]);
  });
});
