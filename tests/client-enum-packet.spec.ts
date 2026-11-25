import { setImmediate } from 'node:timers/promises';
import { Subject } from 'rxjs';
import {
  ErrorMessageType,
  GameMode,
  HandResult,
  NetPlayerType,
  TurnPlayerResult,
  YGOProCtosHandResult,
  YGOProCtosJoinGame,
  YGOProCtosKick,
  YGOProCtosPlayerInfo,
  YGOProCtosTpResult,
  YGOProStocErrorMsg,
  YGOProStocHandResult,
  YGOProStocJoinGame,
} from 'ygopro-msg-encode';
import type { Context } from '../src/app';
import { Chnroute, Client, ClientHandler, I18nService } from '../src/client';
import { CloudReplayService } from '../src/feats';
import { MenuManager } from '../src/feats/menu-manager';
import { Welcome } from '../src/feats/welcome';
import { DefaultHostinfo, Room } from '../src/room';

class TestClient extends Client {
  readonly incoming = new Subject<Buffer>();
  readonly outgoing: Buffer[] = [];

  protected _receive() {
    return this.incoming;
  }

  protected async _send(data: Buffer) {
    this.outgoing.push(data);
  }
}

function createClient() {
  const logger = { warn: jest.fn(), debug: jest.fn() };
  const dispatch = jest.fn(
    async (message: unknown, _client: Client) => message,
  );
  const ctx = {
    createLogger: () => logger,
    dispatch,
    config: { getBoolean: () => false },
    get: (resolve: () => unknown) => {
      const service = resolve();
      if (service === Chnroute) return { getLocale: () => 'en' };
      if (service === I18nService) return { translate: async () => 'Menu' };
      if (service === Welcome) return { sendConfigWelcome: async () => {} };
    },
  } as unknown as Context;
  return { ctx, logger, dispatch, client: new TestClient(ctx) };
}

test.each([
  new YGOProCtosHandResult().fromPartial({ res: HandResult.ROCK }),
  new YGOProCtosTpResult().fromPartial({ res: TurnPlayerResult.SECOND }),
  new YGOProCtosKick().fromPartial({ pos: NetPlayerType.PLAYER2 }),
])('drops invalid enum fields before dispatch for %p', async (message) => {
  const { ctx, logger, dispatch, client } = createClient();
  const connected = new ClientHandler(ctx).handleClient(client);
  try {
    client.incoming.next(
      Buffer.concat([
        new YGOProCtosPlayerInfo()
          .fromPartial({ name: 'Test player' })
          .toFullPayload(),
        new YGOProCtosJoinGame()
          .fromPartial({ pass: 'Test room' })
          .toFullPayload(),
      ]),
    );
    expect(await connected).toBe(true);
    await setImmediate();
    dispatch.mockClear();

    const valid = Buffer.from(message.toFullPayload());
    const invalid = Buffer.from(valid);
    invalid[invalid.length - 1] = 0xff;
    client.incoming.next(Buffer.concat([invalid, valid]));
    client.incoming.next(valid);
    await setImmediate();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(Object),
      expect.stringMatching(/Protocol decode error: Invalid enum value/),
    );
    expect(dispatch.mock.calls).toEqual([
      [message, client],
      [message, client],
    ]);
    expect(client.disconnected).toBeUndefined();
  } finally {
    client.disconnect();
    client.incoming.complete();
  }
});

test.each([
  [ErrorMessageType.JOINERROR, 9],
  [ErrorMessageType.DECKERROR, 0],
  [ErrorMessageType.DECKERROR, 0x90000007],
  [ErrorMessageType.SIDEERROR, 0],
  [ErrorMessageType.VERERROR, 0x12345678],
])('sends ERROR_MSG type %i with the exact code %i', async (msg, code) => {
  const { client, logger } = createClient();
  if (msg === ErrorMessageType.JOINERROR) {
    await client.die();
  } else {
    await client.send(new YGOProStocErrorMsg().fromPartial({ msg, code }));
  }
  await setImmediate();
  expect(logger.warn).not.toHaveBeenCalled();
  expect(client.outgoing).toHaveLength(1);
  const decoded = new YGOProStocErrorMsg().fromFullPayload(client.outgoing[0]);
  expect(decoded).toMatchObject({ msg, code });
});

test('sends both hand result perspectives and restarts after a tie', async () => {
  const { ctx, client: first } = createClient();
  const { client: second } = createClient();
  const { client: watcher } = createClient();
  const room = new Room(ctx, 'Test room', {}, { ...DefaultHostinfo });
  room.players[0] = first;
  room.players[1] = second;
  first.pos = 0;
  second.pos = 1;
  room.watchers.add(watcher);

  const { onHandResult } = room as unknown as {
    onHandResult(client: Client, result: YGOProCtosHandResult): Promise<void>;
  };
  const rock = new YGOProCtosHandResult().fromPartial({ res: HandResult.ROCK });
  await onHandResult.call(room, first, rock);
  expect(first.outgoing).toHaveLength(0);
  await onHandResult.call(room, second, rock);
  expect(room.handResult).toEqual([0, 0]);
  for (const client of [first, second, watcher]) {
    const result = new YGOProStocHandResult().fromFullPayload(
      client.outgoing[0],
    );
    expect(result).toMatchObject({
      res1: HandResult.ROCK,
      res2: HandResult.ROCK,
    });
  }

  first.outgoing.length = 0;
  second.outgoing.length = 0;
  await onHandResult.call(room, first, rock);
  await onHandResult.call(
    room,
    second,
    new YGOProCtosHandResult().fromPartial({ res: HandResult.PAPER }),
  );
  expect(
    new YGOProStocHandResult().fromFullPayload(first.outgoing[0]),
  ).toMatchObject({ res1: HandResult.ROCK, res2: HandResult.PAPER });
  expect(
    new YGOProStocHandResult().fromFullPayload(second.outgoing[0]),
  ).toMatchObject({ res1: HandResult.PAPER, res2: HandResult.ROCK });
});

test('normalizes extended room and replay modes and preserves menu mode on the wire', async () => {
  const { ctx, client, logger } = createClient();
  const replayService = new CloudReplayService(ctx) as unknown as {
    createJoinGamePacket(replay: {
      hostInfo: typeof DefaultHostinfo;
    }): YGOProStocJoinGame;
  };
  for (const [mode, expected] of [
    [GameMode.SINGLE, GameMode.SINGLE],
    [4, GameMode.MATCH],
    [6, GameMode.TAG],
  ]) {
    const hostInfo = { ...DefaultHostinfo, mode: mode as GameMode };
    const room = new Room(ctx, 'Test room', {}, hostInfo);
    await client.send(room.joinGameMessage);
    await client.send(replayService.createJoinGamePacket({ hostInfo }));
    await setImmediate();
    expect(
      client.outgoing
        .splice(0)
        .map(
          (packet) =>
            new YGOProStocJoinGame().fromFullPayload(packet).info.mode,
        ),
    ).toEqual([expected, expected]);
    expect(room.hostinfo.mode).toBe(mode);
  }

  const menu = new MenuManager(ctx);
  await menu.launchMenu(client, [{ title: 'Entry', callback: async () => {} }]);
  await setImmediate();
  expect(
    new YGOProStocJoinGame().fromFullPayload(client.outgoing[0]).info.mode,
  ).toBe(GameMode.SINGLE);
  expect(logger.warn).not.toHaveBeenCalled();
});
