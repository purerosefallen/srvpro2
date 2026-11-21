import * as P from 'ygopro-msg-encode';
import Deck from 'ygopro-deck-encode';
import { AngelusService } from '../src/angelus';
import {
  DefaultHostinfo,
  DuelRecord,
  DuelStage,
  Room,
  RoomCheckDeck,
  RoomSideCheck,
} from '../src/room';
import { DefaultDeckChecker } from '../src/room/default-deck-checker';

function fixture(settings: Partial<P.HostInfo> = {}) {
  const duel = {
    active: true,
    finish: jest.fn(async () => ({ fromPrevious: 'yes' })),
    close: jest.fn(),
  };
  const service = {
    open: jest.fn(async () => duel),
    lists: jest.fn(async () => [
      { name: 'OCG', hash: 1 },
      { name: 'A TCG', hash: 2 },
    ]),
    extraCards: jest.fn(async () => new Set([7])),
    checkDeck: jest.fn(),
  };
  const ctx: any = {
    get: (factory) => (factory() === AngelusService ? service : undefined),
    createLogger: () => ({
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
    }),
    config: { getInt: () => 0, getBoolean: () => false },
    dispatch: jest.fn(async (event) => event),
  };
  const room = new Room(ctx, 'test', {}, { ...DefaultHostinfo, ...settings });
  const client: any = {
    name: 'test',
    pos: 0,
    startDeck: undefined,
    send: jest.fn(),
    sendChat: jest.fn(),
    prepareChangePacket: jest.fn(),
  };
  room.players[0] = client;
  return { room, client, duel, service, ctx };
}
test.each([
  [0, 0, 1],
  [1, 0, 2],
  [0, 20, 0],
  [0, -1, 0],
])('list selection rule %i index %i hash %i', async (rule, lflist, hash) => {
  const { room } = fixture({ rule, lflist });
  await room.init();
  expect(room.joinGameMessage.info.lflist).toBe(hash);
});
test('classifies mixed cards in input order before the deck event, preserving unknowns and Side', async () => {
  const { room, client, ctx } = fixture();
  const reject = 0x50000007;
  ctx.dispatch.mockImplementation(async (event: RoomCheckDeck) => {
    if (event instanceof RoomCheckDeck) {
      expect(event.deck.main).toEqual([9, 42, 9]);
      expect(event.deck.extra).toEqual([7, 7]);
      expect(event.deck.side).toEqual([1, 7]);
      return event.use({ toPayload: () => reject });
    }
  });
  await (room as any).onUpdateDeck(client, {
    deck: { main: [9, 7, 42, 9, 7], side: [1, 7] },
  });
  expect(client.send).toHaveBeenCalledWith(
    expect.objectContaining({ code: reject }),
  );
  expect(client.deck).toBeUndefined();
});
test.each([DuelStage.Begin, DuelStage.Siding])(
  'resource failures reject ready at stage %s',
  async (stage) => {
    const { room, client, service } = fixture();
    room.duelStage = stage;
    client.startDeck = new Deck({ main: [3] });
    service.extraCards.mockRejectedValue(new Error('unavailable'));
    await (room as any).onUpdateDeck(client, { deck: { main: [3], side: [] } });
    expect(client.deck).toBeUndefined();
    expect(client.startDeck.main).toEqual([3]);
    expect(client.sendChat).toHaveBeenCalledWith(
      '#{check_deck_failed}',
      P.ChatColor.RED,
    );
    expect(client.send).toHaveBeenCalledWith(
      expect.objectContaining({
        msg:
          stage === DuelStage.Begin
            ? P.ErrorMessageType.DECKERROR
            : P.ErrorMessageType.SIDEERROR,
        code: 0,
      }),
    );
  },
);
test('default middleware honors exemptions, preserves limits and checks Side locally', async () => {
  const { room, client, ctx, service } = fixture({ no_check_deck: 1 });
  const handlers = new Map();
  ctx.middleware = (type, handler) => handlers.set(type, handler);
  await new DefaultDeckChecker(ctx).init();
  const deck = new Deck({ main: [3], extra: [7] });
  const next = jest.fn();
  await handlers.get(RoomCheckDeck)(
    new RoomCheckDeck(room, client, deck),
    client,
    next,
  );
  expect(service.checkDeck).not.toHaveBeenCalled();
  room.hostinfo.no_check_deck = 0;
  room.lflist = { name: 'List (2)', hash: 77 };
  await handlers.get(RoomCheckDeck)(
    new RoomCheckDeck(room, client, deck),
    client,
    next,
  );
  expect(service.checkDeck).toHaveBeenCalledWith({
    deck: deck.toYdkeURL(),
    lflist: 'List (2)',
    rule: room.hostinfo.rule,
    limits: { minMain: 0, maxMain: 0, maxExtra: 0, maxSide: 0, maxCopies: 0 },
  });
  const side = new RoomSideCheck(
    room,
    client,
    new Deck({ main: [1], extra: [7] }),
    deck,
  );
  await handlers.get(RoomSideCheck)(side, client, next);
  expect(side.isValid).toBe(false);
});
test.each([false, true])(
  'START, Undo snapshot, Side-ins and final registry across games (tag %s)',
  async (tag) => {
    const { room, duel, service } = fixture({
      mode: tag ? 2 : 1,
      sideins: 1,
      no_shuffle_deck: 1,
    });
    const decks = Array.from({ length: tag ? 4 : 2 }, (_, i) => ({
      name: 'p' + i,
      deck: new Deck({ main: [i + 100], extra: [21], side: [7, 8, 7] }),
    }));
    const seed = [1, 2, 3, 4, 5, 6, 7, 8];
    const record = new DuelRecord(seed, decks, true);
    room.isPosSwapped = true;
    expect(await (room as any).startAngelus(record)).toBe(true);
    const start = service.open.mock.calls[0] as unknown as [
      P.YGOProAngelusStart,
    ];
    expect(start[0].decks).toEqual(
      (tag ? [102, 103, 100, 101] : [101, 100]).map((code) => [code, 21, 7, 7]),
    );
    expect(start[0].flags).toBe(tag ? 3 : 2);
    expect(record.toYrp(room).hostDeck.extra).toEqual([7, 7, 21]);
    expect(record.players[0].deck.side).toEqual([8]);
    await room.openCandidate();
    const candidate = service.open.mock.calls[1] as unknown as [
      P.YGOProAngelusStart,
    ];
    expect(candidate[0].toPayload()).toEqual(start[0].toPayload());
    let finish;
    duel.finish.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const closing = (room as any).finishAngelus();
    expect(room.angelus).toBeUndefined();
    finish({ persist: 'registry' });
    await closing;
    await (room as any).startAngelus(record);
    const second = service.open.mock.calls[2] as unknown as [
      P.YGOProAngelusStart,
    ];
    expect(second[0].decodeRegistry().persist).toBe('registry');
    expect(second[0].decks).toEqual(start[0].decks);
  },
);
test('only the active duel can settle an unexpected disconnect, exactly once', async () => {
  const { room, duel } = fixture();
  room.duelStage = DuelStage.Dueling;
  jest.spyOn(room, 'win').mockResolvedValue(undefined);
  room.attachAngelus(duel as any);
  const stale = room.angelus.onFailure;
  const active = { ...duel };
  room.attachAngelus(active as any);
  stale(new Error('old socket'));
  expect(room.win).not.toHaveBeenCalled();
  const disconnect = room.angelus.onFailure;
  disconnect(new Error('disconnected'));
  disconnect(new Error('duplicate'));
  expect(room.win).toHaveBeenCalledTimes(1);
  expect(room.win).toHaveBeenCalledWith(
    expect.objectContaining({ player: 2, type: 0x11 }),
    { engineFailure: true },
  );
});
