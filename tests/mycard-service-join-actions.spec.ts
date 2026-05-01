import { MycardService } from '../src/feats/mycard';
import { DefaultHostinfo } from '../src/room/default-hostinfo';

const SECRET = 456;

function makePayload(action: number) {
  const buffer = Buffer.alloc(6);
  buffer.writeUInt8(0, 0);
  buffer.writeUInt8(action << 4, 1);
  buffer.writeUInt8(0b00101000, 2);
  buffer.writeUInt16LE(8000, 3);
  buffer.writeUInt8(0x51, 5);
  const checksum = buffer.reduce((sum, value, index) => {
    return index === 0 ? sum : sum + value;
  }, 0);
  buffer.writeUInt8(-checksum & 0xff, 0);
  return buffer;
}

function encodePass(action: number, suffix: string) {
  const secret = (SECRET % 65535) + 1;
  const payload = makePayload(action);
  const encrypted = Buffer.allocUnsafe(6);
  for (const offset of [0, 2, 4]) {
    encrypted.writeUInt16LE(payload.readUInt16LE(offset) ^ secret, offset);
  }
  return encrypted.toString('base64') + suffix;
}

function makeRoom(name: string) {
  const room: any = {
    name,
    playingPlayers: [],
    players: [],
    join: jest.fn(async (client: any) => {
      room.playingPlayers.push(client);
      client.roomName = name;
    }),
  };
  return room;
}

function makeClient(name = 'Alice') {
  return {
    name,
    name_vpass: name,
    sendChat: jest.fn(),
    die: jest.fn(),
    isLocal: false,
    isInternal: false,
    disconnected: false,
  } as any;
}

function makeCtx(options: { permit?: boolean } = {}) {
  const rooms = new Map<string, any>();
  const deps = {
    findByName: (name: string) => rooms.get(name),
    findOrCreateByName: jest.fn(
      async (name: string, _creator?: any, hostinfo?: any) => {
        if (!rooms.has(name)) {
          const room = makeRoom(name);
          room.hostinfo = hostinfo;
          rooms.set(name, room);
        }
        return rooms.get(name);
      },
    ),
    allRooms: () => [...rooms.values()],
    getHostinfo: () => DefaultHostinfo,
    registerTick: jest.fn(),
    enabled: false,
    getBadwordLevel: jest.fn(async () => 0),
  };
  const configValues: Record<string, string> = {
    MYCARD_ENABLED: '1',
    MYCARD_AUTH_BASE_URL: 'https://auth.example',
    MYCARD_AUTH_KEY: 'key',
    MYCARD_BAN_GET: '',
    MYCARD_ARENA_MODE: 'athletic',
    MYCARD_ARENA_CHECK_PERMIT: options.permit == null ? '' : 'permit',
    MYCARD_ARENA_MATCH_API_ENABLED: '0',
  };
  const ctx = {
    rooms,
    createLogger: () => ({
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
      error: jest.fn(),
    }),
    config: {
      getBoolean: (key: string) => configValues[key] === '1',
      getString: (key: string) => configValues[key] || '',
      getInt: (key: string) => Number(configValues[key] || '0'),
    },
    http: {
      get: jest.fn(async (url: string) => {
        if (url === 'permit') {
          return { data: { permit: options.permit } };
        }
        return {
          data: {
            user: {
              u16Secret: SECRET,
            },
          },
        };
      }),
      request: jest.fn(),
    },
    get: () => deps,
    middleware: jest.fn(),
  } as any;
  return ctx;
}

describe('MycardService join actions', () => {
  test('actions 1 and 2 create public/private mycard rooms', async () => {
    for (const action of [1, 2]) {
      const ctx = makeCtx();
      const service = new MycardService(ctx);
      const client = makeClient(`Alice${action}`);

      await service.handleJoinPass(
        encodePass(action, `Title${action}`),
        client,
      );

      const room = [...ctx.rooms.values()][0];
      expect(room.mycard).toBe(true);
      expect(room.mycardPrivate).toBe(action === 2);
      expect(room.mycardTitle).toBe(`Title${action}`);
      expect(room.hostinfo.start_lp).toBe(8000);
      expect(room.join).toHaveBeenCalledWith(client);
    }
  });

  test('action 3 joins an existing room by name', async () => {
    const ctx = makeCtx();
    const room = makeRoom('known-room');
    ctx.rooms.set(room.name, room);
    const service = new MycardService(ctx);
    const client = makeClient();

    await service.handleJoinPass(encodePass(3, room.name), client);

    expect(room.join).toHaveBeenCalledWith(client);
  });

  test('action 4 joins arena room only when permit allows it', async () => {
    const rejectedCtx = makeCtx({ permit: false });
    const rejectedService = new MycardService(rejectedCtx);
    const rejectedClient = makeClient();

    await rejectedService.handleJoinPass(
      encodePass(4, 'match'),
      rejectedClient,
    );

    expect(rejectedClient.die).toHaveBeenCalledWith(
      '#{invalid_password_unauthorized}',
      expect.any(Number),
    );
    expect(rejectedCtx.rooms.has('M#match')).toBe(false);

    const ctx = makeCtx({ permit: true });
    const service = new MycardService(ctx);
    const client = makeClient();

    await service.handleJoinPass(encodePass(4, 'match'), client);

    const room = ctx.rooms.get('M#match');
    expect(room.mycardArena).toBe('athletic');
    expect(room.noHost).toBe(true);
    expect(room.welcome).toBe('#{athletic_arena_tip}');
    expect(room.join).toHaveBeenCalledWith(client);
  });

  test('action 5 joins an existing mycard room by title', async () => {
    const ctx = makeCtx();
    const room = makeRoom('room-by-title');
    room.mycardTitle = 'Lobby Title';
    ctx.rooms.set(room.name, room);
    const service = new MycardService(ctx);
    const client = makeClient();

    await service.handleJoinPass(encodePass(5, 'Lobby Title'), client);

    expect(room.join).toHaveBeenCalledWith(client);
  });
});
