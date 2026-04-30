import {
  ChatColor,
  NetPlayerType,
  YGOProCtosHsToDuelist,
  YGOProCtosHsToObserver,
  YGOProCtosJoinGame,
} from 'ygopro-msg-encode';
import { ChallongeService, ReplayRecoverService } from '../src/feats';
import { ChallongeJoinHandler } from '../src/join-handlers/challonge-join-handler';
import { RoomManager } from '../src/room';

function createLogger() {
  return {
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  };
}

describe('ChallongeService position guard', () => {
  test('blocks challonge players from moving in either direction', async () => {
    const middlewares = new Map<unknown, any>();
    const ctx: any = {
      createLogger,
      middleware: (cls: unknown, handler: unknown) => {
        middlewares.set(cls, handler);
      },
    };
    const service = new ChallongeService(ctx);
    await service.init();
    const client: any = {
      challongeInfo: { id: 1 },
      sendChat: jest.fn(),
    };

    const observerNext = jest.fn();
    await middlewares.get(YGOProCtosHsToObserver)(
      new YGOProCtosHsToObserver(),
      client,
      observerNext,
    );
    expect(observerNext).not.toHaveBeenCalled();

    const duelistNext = jest.fn();
    await middlewares.get(YGOProCtosHsToDuelist)(
      new YGOProCtosHsToDuelist(),
      client,
      duelistNext,
    );
    expect(duelistNext).not.toHaveBeenCalled();

    expect(client.sendChat).toHaveBeenCalledTimes(2);
    expect(client.sendChat).toHaveBeenCalledWith(
      '#{cannot_to_observer}',
      ChatColor.BABYBLUE,
    );
    expect(client.sendChat).toHaveBeenCalledWith(
      '#{cannot_to_duelist}',
      ChatColor.BABYBLUE,
    );
  });
});

describe('ChallongeJoinHandler', () => {
  test('joins existing rooms as observer regardless of duel stage', async () => {
    const middlewares: any[] = [];
    const preRoom = {
      join: jest.fn(),
    };
    const challongeService = {
      enabled: true,
      resolveJoinInfo: jest.fn(),
    };
    const replayRecoverService = {
      resolveRecoverRoomPrefix: jest.fn(),
    };
    const roomManager = {
      findByName: jest.fn((name: string) =>
        name === 'M#123' ? preRoom : undefined,
      ),
    };
    const ctx: any = {
      createLogger,
      middleware: (_cls: unknown, handler: unknown) => {
        middlewares.push(handler);
      },
      get: jest.fn((factory: () => unknown) => {
        const token = factory();
        if (token === ChallongeService) {
          return challongeService;
        }
        if (token === ReplayRecoverService) {
          return replayRecoverService;
        }
        if (token === RoomManager) {
          return roomManager;
        }
        return undefined;
      }),
    };
    const handler = new ChallongeJoinHandler(ctx);
    await handler.init();
    const client: any = { name: 'Alice' };

    await middlewares[0](
      new YGOProCtosJoinGame().fromPartial({ pass: 'M#123' }),
      client,
      jest.fn(),
    );

    expect(preRoom.join).toHaveBeenCalledWith(
      client,
      NetPlayerType.OBSERVER,
    );
    expect(challongeService.resolveJoinInfo).not.toHaveBeenCalled();
  });

  test('joins newly resolved matches at the challonge player position', async () => {
    const middlewares: any[] = [];
    const room: any = {
      playingPlayers: [],
      join: jest.fn(),
    };
    const match = {
      id: 777,
      state: 'open',
      player1_id: 10,
      player2_id: 20,
    };
    const participant = {
      id: 20,
      name: 'Bob',
    };
    const challongeService = {
      enabled: true,
      resolveJoinInfo: jest.fn(async () => ({
        ok: true,
        participant,
        match,
        pos: 1,
      })),
    };
    const replayRecoverService = {
      resolveRecoverRoomPrefix: jest.fn(),
    };
    const roomManager = {
      findByName: jest.fn(),
      findOrCreateByName: jest.fn(async () => room),
    };
    const ctx: any = {
      createLogger,
      config: {
        getBoolean: () => false,
      },
      middleware: (_cls: unknown, handler: unknown) => {
        middlewares.push(handler);
      },
      get: jest.fn((factory: () => unknown) => {
        const token = factory();
        if (token === ChallongeService) {
          return challongeService;
        }
        if (token === ReplayRecoverService) {
          return replayRecoverService;
        }
        if (token === RoomManager) {
          return roomManager;
        }
        return undefined;
      }),
    };
    const handler = new ChallongeJoinHandler(ctx);
    await handler.init();
    const client: any = { name: 'Bob', die: jest.fn() };

    await middlewares[0](
      new YGOProCtosJoinGame().fromPartial({ pass: '' }),
      client,
      jest.fn(),
    );

    expect(roomManager.findOrCreateByName).toHaveBeenCalledWith(
      'M#777',
      client,
    );
    expect(client.challongeInfo).toBe(participant);
    expect(room.join).toHaveBeenCalledWith(client, 1);
  });
});
