import {
  DefaultHostInfoProvider,
  DuelStage,
  OnRoomWin,
  Room,
} from '../src/room';

function makeCtx() {
  const dispatch = jest.fn(
    async (_event?: unknown, _client?: unknown) => undefined,
  );
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
    dispatch,
  };
  const hostInfoProvider = new DefaultHostInfoProvider(ctx);
  ctx.get = jest.fn((factory: () => unknown) => {
    const token = factory();
    if (token === DefaultHostInfoProvider) {
      return hostInfoProvider;
    }
    return undefined;
  });
  return {
    ctx,
    dispatch,
  };
}

function makeRoom(name: string) {
  const { ctx, dispatch } = makeCtx();
  const room = new Room(ctx, name);
  room.duelStage = DuelStage.Dueling;
  const finalize = jest.spyOn(room, 'finalize').mockImplementation(async () => {
    return undefined;
  });
  const changeSide = jest
    .spyOn(room as any, 'changeSide')
    .mockResolvedValue(undefined);
  return {
    room,
    dispatch,
    finalize,
    changeSide,
  };
}

describe('Room hostinfo duel limit', () => {
  test('single rooms end after the first duel even if winMatchCount is overridden', async () => {
    const { room, dispatch, finalize, changeSide } = makeRoom('single-room');
    room.setOverrideWinMatchCount(99);
    room.duelRecords = [{} as any];

    await room.win({ player: 2, type: 0x11 });

    const event = dispatch.mock.calls[0]?.[0] as OnRoomWin | undefined;
    expect(changeSide).not.toHaveBeenCalled();
    expect(finalize).toHaveBeenCalledWith(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(event?.winMatch).toBe(true);
  });

  test('match rooms end on the third duel even if winMatchCount is overridden', async () => {
    const { room, dispatch, finalize, changeSide } = makeRoom('MATCH#room');
    room.setOverrideWinMatchCount(99);
    room.duelRecords = [
      { winPosition: 0 } as any,
      { winPosition: 1 } as any,
      {} as any,
    ];

    await room.win({ player: 2, type: 0x11 });

    const event = dispatch.mock.calls[0]?.[0] as OnRoomWin | undefined;
    expect(changeSide).not.toHaveBeenCalled();
    expect(finalize).toHaveBeenCalledWith(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(event?.winMatch).toBe(true);
  });
});
