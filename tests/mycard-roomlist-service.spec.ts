import { createServer, Server as HttpServer } from 'node:http';
import WebSocket from 'ws';
import {
  DuelStage,
  OnRoomFinalize,
  OnRoomJoinPlayer,
  OnRoomLeavePlayer,
  OnRoomMatchStart,
  RoomLeavePlayerReason,
} from '../src/room';
import { MycardRoomlistService } from '../src/feats/mycard';

type MockPlayer = {
  name: string;
  pos: number;
  isHost?: boolean;
};

type MockRoom = {
  name: string;
  mycard?: boolean;
  mycardPrivate?: boolean;
  mycardTitle?: string;
  mycardArena?: string;
  windbot?: unknown;
  duelStage: DuelStage;
  hostinfo: Record<string, unknown>;
  playingPlayers: MockPlayer[];
};

function makePlayer(name: string, pos: number, isHost = false): MockPlayer {
  return {
    name,
    pos,
    isHost,
  };
}

function makeRoom(name: string, partial: Partial<MockRoom> = {}): MockRoom {
  return {
    name,
    mycard: true,
    mycardPrivate: false,
    duelStage: DuelStage.Begin,
    hostinfo: {
      rule: 0,
      mode: 0,
    },
    playingPlayers: [],
    ...partial,
  };
}

function createLogger() {
  return {
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  };
}

function makeCtx(options: {
  enabled?: boolean;
  apiPort?: number;
  server?: HttpServer;
  rooms?: MockRoom[];
}) {
  const rooms = options.rooms || [];
  const middlewares = new Map<unknown, any>();
  const roomManager = {
    allRooms: () => rooms,
  };
  const koaService = {
    getHttpServer: () => options.server,
  };
  const ctx = {
    middlewares,
    createLogger,
    config: {
      getBoolean: (key: string) =>
        key === 'MYCARD_ENABLED' ? options.enabled !== false : false,
      getInt: (key: string) =>
        key === 'API_PORT' ? (options.apiPort ?? 7922) : 0,
      getString: () => '',
    },
    get: (factory: () => unknown) => {
      const token = factory();
      switch ((token as any)?.name) {
        case 'RoomManager':
          return roomManager;
        case 'KoaService':
          return koaService;
        default:
          return undefined;
      }
    },
    middleware: (cls: unknown, handler: unknown) => {
      middlewares.set(cls, handler);
      return ctx;
    },
  } as any;
  return ctx;
}

async function listenServer(server: HttpServer) {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
}

async function closeServer(server: HttpServer) {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

function waitForOpen(socket: WebSocket) {
  return new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
}

function waitForJsonMessage(socket: WebSocket) {
  return new Promise<any>((resolve, reject) => {
    socket.once('message', (data) => {
      try {
        resolve(JSON.parse(String(data)));
      } catch (error) {
        reject(error);
      }
    });
    socket.once('error', reject);
  });
}

function waitForNoMessage(socket: WebSocket, timeoutMs = 50) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      resolve();
    }, timeoutMs);
    const onMessage = () => {
      clearTimeout(timer);
      reject(new Error('Unexpected websocket message'));
    };
    socket.once('message', onMessage);
  });
}

async function closeSocket(socket: WebSocket) {
  if (
    socket.readyState === WebSocket.CLOSED ||
    socket.readyState === WebSocket.CLOSING
  ) {
    return;
  }
  await new Promise<void>((resolve) => {
    socket.once('close', () => resolve());
    socket.close();
  });
}

describe('MycardRoomlistService', () => {
  test('does not start when MYCARD_ENABLED is disabled', async () => {
    const ctx = makeCtx({
      enabled: false,
    });
    const service = new MycardRoomlistService(ctx);

    await service.init();

    expect(ctx.middlewares.size).toBe(0);
  });

  test('does not start when API_PORT is disabled or server is unavailable', async () => {
    const noPortCtx = makeCtx({
      apiPort: 0,
    });
    const noPortService = new MycardRoomlistService(noPortCtx);
    await noPortService.init();
    expect(noPortCtx.middlewares.size).toBe(0);

    const noServerCtx = makeCtx({
      apiPort: 7922,
      server: undefined,
    });
    const noServerService = new MycardRoomlistService(noServerCtx);
    await noServerService.init();
    expect(noServerCtx.middlewares.size).toBe(0);
  });

  test('init snapshot splits waiting and started rooms like srvpro roomlist', async () => {
    const server = createServer();
    await listenServer(server);

    const waitingRoom = makeRoom('public-room', {
      mycardTitle: 'Public Title',
      playingPlayers: [makePlayer('Host', 0, true), makePlayer('Guest', 1)],
    });
    const waitingPrivateRoom = makeRoom('private-room', {
      mycardPrivate: true,
      playingPlayers: [makePlayer('PrivateHost', 0, true)],
    });
    const startedPrivateArenaRoom = makeRoom('M#match', {
      mycardPrivate: true,
      mycardArena: 'athletic',
      duelStage: DuelStage.Dueling,
      playingPlayers: [makePlayer('ArenaA', 0), makePlayer('ArenaB', 1)],
    });
    const nonMycardRoom = makeRoom('native-room', {
      mycard: false,
      playingPlayers: [makePlayer('NativeHost', 0, true)],
    });
    const windbotRoom = makeRoom('bot-room', {
      windbot: {},
      playingPlayers: [makePlayer('BotHost', 0, true)],
    });

    const ctx = makeCtx({
      server,
      rooms: [
        waitingRoom,
        waitingPrivateRoom,
        startedPrivateArenaRoom,
        nonMycardRoom,
        windbotRoom,
      ],
    });
    const service = new MycardRoomlistService(ctx);
    await service.init();

    const { port } = server.address() as any;
    const waitingSocket = new WebSocket(`ws://127.0.0.1:${port}/legacy`);
    const waitingInitPromise = waitForJsonMessage(waitingSocket);
    await waitForOpen(waitingSocket);
    const waitingInit = await waitingInitPromise;

    expect(waitingInit).toEqual({
      event: 'init',
      data: [
        {
          id: 'public-room',
          title: 'Public Title',
          user: {
            username: 'Host',
          },
          users: [
            {
              username: 'Host',
              position: 0,
            },
            {
              username: 'Guest',
              position: 1,
            },
          ],
          options: waitingRoom.hostinfo,
          arena: false,
        },
      ],
    });

    const startedSocket = new WebSocket(
      `ws://127.0.0.1:${port}/anything?filter=started`,
    );
    const startedInitPromise = waitForJsonMessage(startedSocket);
    await waitForOpen(startedSocket);
    const startedInit = await startedInitPromise;

    expect(startedInit).toEqual({
      event: 'init',
      data: [
        {
          id: 'M#match',
          title: 'M#match',
          user: {
            username: 'ArenaA',
          },
          users: [
            {
              username: 'ArenaA',
              position: 0,
            },
            {
              username: 'ArenaB',
              position: 1,
            },
          ],
          options: startedPrivateArenaRoom.hostinfo,
          arena: 'athletic',
        },
      ],
    });

    await closeSocket(waitingSocket);
    await closeSocket(startedSocket);
    await service.stop();
    await closeServer(server);
  });

  test('broadcasts create update delete across join leave match start and finalize', async () => {
    const server = createServer();
    await listenServer(server);

    const room = makeRoom('public-room', {
      mycardTitle: 'Public Title',
      playingPlayers: [makePlayer('Host', 0, true)],
    });
    const ctx = makeCtx({
      server,
      rooms: [room],
    });
    const service = new MycardRoomlistService(ctx);
    await service.init();

    const { port } = server.address() as any;
    const waitingSocket = new WebSocket(`ws://127.0.0.1:${port}/`);
    const waitingInitPromise = waitForJsonMessage(waitingSocket);
    await waitForOpen(waitingSocket);
    await waitingInitPromise;

    const startedSocket = new WebSocket(
      `ws://127.0.0.1:${port}/?filter=started`,
    );
    const startedInitPromise = waitForJsonMessage(startedSocket);
    await waitForOpen(startedSocket);
    await startedInitPromise;

    room.playingPlayers.push(makePlayer('Guest', 1));
    const waitingUpdatePromise = waitForJsonMessage(waitingSocket);
    await ctx.middlewares.get(OnRoomJoinPlayer)(
      new OnRoomJoinPlayer(room as any),
      undefined,
      jest.fn(async () => undefined),
    );
    await expect(waitingUpdatePromise).resolves.toEqual({
      event: 'update',
      data: {
        id: 'public-room',
        title: 'Public Title',
        user: {
          username: 'Host',
        },
        users: [
          {
            username: 'Host',
            position: 0,
          },
          {
            username: 'Guest',
            position: 1,
          },
        ],
        options: room.hostinfo,
        arena: false,
      },
    });

    room.playingPlayers = [room.playingPlayers[0]];
    const waitingDeletePromise = waitForJsonMessage(waitingSocket);
    const startedCreatePromise = waitForJsonMessage(startedSocket);
    room.duelStage = DuelStage.Dueling;
    await ctx.middlewares.get(OnRoomMatchStart)(
      new OnRoomMatchStart(room as any),
      undefined,
      jest.fn(async () => undefined),
    );
    await expect(waitingDeletePromise).resolves.toEqual({
      event: 'delete',
      data: 'public-room',
    });
    await expect(startedCreatePromise).resolves.toEqual({
      event: 'create',
      data: {
        id: 'public-room',
        title: 'Public Title',
        user: {
          username: 'Host',
        },
        users: [
          {
            username: 'Host',
            position: 0,
          },
        ],
        options: room.hostinfo,
        arena: false,
      },
    });

    const startedDeletePromise = waitForJsonMessage(startedSocket);
    await ctx.middlewares.get(OnRoomFinalize)(
      new OnRoomFinalize(room as any),
      undefined,
      jest.fn(async () => undefined),
    );
    await expect(startedDeletePromise).resolves.toEqual({
      event: 'delete',
      data: 'public-room',
    });

    await closeSocket(waitingSocket);
    await closeSocket(startedSocket);
    await service.stop();
    await closeServer(server);
  });

  test('switch position emits only one final waiting update', async () => {
    const server = createServer();
    await listenServer(server);

    const host = makePlayer('Host', 0, true);
    const guest = makePlayer('Guest', 1);
    const room = makeRoom('public-room', {
      playingPlayers: [host, guest],
    });
    const ctx = makeCtx({
      server,
      rooms: [room],
    });
    const service = new MycardRoomlistService(ctx);
    await service.init();

    const { port } = server.address() as any;
    const waitingSocket = new WebSocket(`ws://127.0.0.1:${port}/?filter=other`);
    const initPromise = waitForJsonMessage(waitingSocket);
    await waitForOpen(waitingSocket);
    await initPromise;

    guest.pos = 2;
    room.playingPlayers = [host, guest];

    await ctx.middlewares.get(OnRoomLeavePlayer)(
      new OnRoomLeavePlayer(
        room as any,
        1,
        RoomLeavePlayerReason.SwitchPosition,
      ),
      guest,
      jest.fn(async () => undefined),
    );
    await expect(waitForNoMessage(waitingSocket)).resolves.toBeUndefined();

    const updatePromise = waitForJsonMessage(waitingSocket);
    await ctx.middlewares.get(OnRoomJoinPlayer)(
      new OnRoomJoinPlayer(room as any),
      guest,
      jest.fn(async () => undefined),
    );
    await expect(updatePromise).resolves.toEqual({
      event: 'update',
      data: {
        id: 'public-room',
        title: 'public-room',
        user: {
          username: 'Host',
        },
        users: [
          {
            username: 'Host',
            position: 0,
          },
          {
            username: 'Guest',
            position: 2,
          },
        ],
        options: room.hostinfo,
        arena: false,
      },
    });

    await closeSocket(waitingSocket);
    await service.stop();
    await closeServer(server);
  });

  test('disconnecting the last waiting player deletes the room immediately', async () => {
    const server = createServer();
    await listenServer(server);

    const host = makePlayer('Host', 0, true);
    const room = makeRoom('public-room', {
      playingPlayers: [host],
    });
    const ctx = makeCtx({
      server,
      rooms: [room],
    });
    const service = new MycardRoomlistService(ctx);
    await service.init();

    const { port } = server.address() as any;
    const waitingSocket = new WebSocket(`ws://127.0.0.1:${port}/`);
    const initPromise = waitForJsonMessage(waitingSocket);
    await waitForOpen(waitingSocket);
    await initPromise;

    room.playingPlayers = [];
    const deletePromise = waitForJsonMessage(waitingSocket);
    await ctx.middlewares.get(OnRoomLeavePlayer)(
      new OnRoomLeavePlayer(room as any, 0, RoomLeavePlayerReason.Disconnect),
      host,
      jest.fn(async () => undefined),
    );
    await expect(deletePromise).resolves.toEqual({
      event: 'delete',
      data: 'public-room',
    });

    await closeSocket(waitingSocket);
    await service.stop();
    await closeServer(server);
  });
});
