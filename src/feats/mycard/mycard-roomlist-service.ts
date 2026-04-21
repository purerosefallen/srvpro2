import { IncomingMessage } from 'node:http';
import { Server as WebSocketServer, WebSocket } from 'ws';
import { Context } from '../../app';
import {
  DuelStage,
  OnRoomFinalize,
  OnRoomJoinPlayer,
  OnRoomLeavePlayer,
  OnRoomMatchStart,
  Room,
  RoomLeavePlayerReason,
  RoomManager,
} from '../../room';
import { KoaService } from '../../services/koa-service';

type RoomlistFilter = 'waiting' | 'started';

type RoomlistUser = {
  username: string;
  position: number;
};

type RoomlistPayload = {
  id: string;
  title: string;
  user: {
    username: string;
  };
  users: RoomlistUser[];
  options: Room['hostinfo'];
  arena: string | false;
};

type RoomlistMessage =
  | {
      event: 'init';
      data: RoomlistPayload[];
    }
  | {
      event: 'create' | 'update';
      data: RoomlistPayload;
    }
  | {
      event: 'delete';
      data: string;
    };

export class MycardRoomlistService {
  private logger = this.ctx.createLogger(this.constructor.name);
  private wss?: WebSocketServer;
  private connectionFilters = new Map<WebSocket, RoomlistFilter>();
  private publishedBuckets = new Map<string, RoomlistFilter>();

  constructor(private ctx: Context) {}

  get enabled() {
    return this.ctx.config.getBoolean('MYCARD_ENABLED');
  }

  private get roomManager() {
    return this.ctx.get(() => RoomManager);
  }

  private get koaService() {
    return this.ctx.get(() => KoaService);
  }

  async init() {
    if (!this.enabled) {
      return;
    }

    if (!this.ctx.config.getInt('API_PORT')) {
      this.logger.info(
        'API_PORT not configured, Mycard websocket roomlist not started',
      );
      return;
    }

    const server = this.koaService.getHttpServer();
    if (!server) {
      this.logger.warn(
        'Legacy API server unavailable, Mycard websocket roomlist not started',
      );
      return;
    }

    this.seedPublishedBuckets();
    this.wss = new WebSocketServer({
      server,
    });
    this.wss.on('connection', (connection, request) => {
      this.handleConnection(connection, request);
    });

    this.ctx.middleware(OnRoomJoinPlayer, async (event, _client, next) => {
      if (event.room.duelStage === DuelStage.Begin) {
        this.syncRoom(event.room);
      }
      return next();
    });

    this.ctx.middleware(OnRoomLeavePlayer, async (event, _client, next) => {
      if (
        event.room.duelStage === DuelStage.Begin &&
        event.reason !== RoomLeavePlayerReason.SwitchPosition
      ) {
        this.syncRoom(event.room);
      }
      return next();
    });

    this.ctx.middleware(OnRoomMatchStart, async (event, _client, next) => {
      this.syncRoom(event.room);
      return next();
    });

    this.ctx.middleware(OnRoomFinalize, async (event, _client, next) => {
      this.deletePublishedRoom(event.room.name);
      return next();
    });
  }

  async stop() {
    this.connectionFilters.clear();
    this.publishedBuckets.clear();
    if (!this.wss) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.wss!.close(() => resolve());
    });
    this.wss = undefined;
  }

  private handleConnection(connection: WebSocket, request: IncomingMessage) {
    const filter = this.resolveFilter(request.url);
    this.connectionFilters.set(connection, filter);
    connection.on('close', () => {
      this.connectionFilters.delete(connection);
    });

    this.sendMessage(connection, {
      event: 'init',
      data: this.roomManager
        .allRooms()
        .filter((room) => this.resolveBucket(room) === filter)
        .map((room) => this.createPayload(room)),
    });
  }

  private resolveFilter(urlText?: string): RoomlistFilter {
    try {
      const url = new URL(urlText || '/', 'http://127.0.0.1');
      return url.searchParams.get('filter') === 'started'
        ? 'started'
        : 'waiting';
    } catch {
      return 'waiting';
    }
  }

  private seedPublishedBuckets() {
    this.publishedBuckets.clear();
    for (const room of this.roomManager.allRooms()) {
      const bucket = this.resolveBucket(room);
      if (bucket) {
        this.publishedBuckets.set(room.name, bucket);
      }
    }
  }

  private syncRoom(room: Room) {
    const previousBucket = this.publishedBuckets.get(room.name);
    const nextBucket = this.resolveBucket(room);

    if (previousBucket && previousBucket !== nextBucket) {
      this.broadcast(previousBucket, {
        event: 'delete',
        data: room.name,
      });
    }

    if (!nextBucket) {
      this.publishedBuckets.delete(room.name);
      return;
    }

    const event =
      previousBucket === nextBucket ? ('update' as const) : ('create' as const);
    this.broadcast(nextBucket, {
      event,
      data: this.createPayload(room),
    });
    this.publishedBuckets.set(room.name, nextBucket);
  }

  private deletePublishedRoom(roomName: string) {
    const previousBucket = this.publishedBuckets.get(roomName);
    if (!previousBucket) {
      return;
    }
    this.broadcast(previousBucket, {
      event: 'delete',
      data: roomName,
    });
    this.publishedBuckets.delete(roomName);
  }

  private resolveBucket(room: Room): RoomlistFilter | undefined {
    if (!room.mycard || room.windbot) {
      return undefined;
    }
    if (room.duelStage === DuelStage.Begin) {
      if (room.mycardPrivate || room.playingPlayers.length === 0) {
        return undefined;
      }
      return 'waiting';
    }
    return 'started';
  }

  private createPayload(room: Room): RoomlistPayload {
    const users = [...room.playingPlayers]
      .sort((a, b) => a.pos - b.pos)
      .map((player) => ({
        username: player.name,
        position: player.pos,
      }));
    const hostPlayer =
      room.playingPlayers.find((player) => player.isHost) ||
      room.playingPlayers[0];
    return {
      id: room.name,
      title: room.mycardTitle || room.name,
      user: {
        username: hostPlayer?.name || '',
      },
      users,
      options: {
        ...room.hostinfo,
      },
      arena: room.mycardArena || false,
    };
  }

  private broadcast(filter: RoomlistFilter, message: RoomlistMessage) {
    for (const [connection, connectionFilter] of this.connectionFilters) {
      if (connectionFilter !== filter) {
        continue;
      }
      this.sendMessage(connection, message);
    }
  }

  private sendMessage(connection: WebSocket, message: RoomlistMessage) {
    if (connection.readyState !== WebSocket.OPEN) {
      return;
    }
    try {
      connection.send(JSON.stringify(message));
    } catch (error) {
      this.logger.warn({ error }, 'Failed to send Mycard roomlist message');
    }
  }
}
