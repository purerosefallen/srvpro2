import { NetPlayerType, YGOProStocReplay } from 'ygopro-msg-encode';
import { Context } from '../../app';
import { Client } from '../../client';
import { OnRoomCreate, OnRoomLeave, OnRoomObserverChange } from '../../room';
import { OnMycardAuthenticated } from './mycard-events';
import { MycardUser } from './mycard-user';
import { YGOProStocChatReplayHint } from '../../replay';

type MycardIdentity = Pick<MycardUser, 'username' | 'active'>;

type ObserverSession = {
  username: string;
  roomName: string;
  blocked: boolean;
};

export class MycardSpectatorReplayService {
  private identities = new WeakMap<Client, MycardIdentity>();
  private sessions = new WeakMap<Client, ObserverSession>();
  private observers = new Map<string, Map<string, Set<ObserverSession>>>();

  constructor(private ctx: Context) {}

  async init() {
    if (
      !this.ctx.config.getBoolean('MYCARD_ENABLED') ||
      !this.ctx.config.getBoolean('MYCARD_RESTRICT_SPECTATOR_REPLAY')
    ) {
      return;
    }
    this.ctx.middleware(
      OnMycardAuthenticated,
      async ({ user }, client, next) => {
        this.identities.set(client, {
          username: user.username,
          active: user.active,
        });
        return next();
      },
    );
    this.ctx.middleware(OnRoomObserverChange, async (event, client, next) => {
      if (event.observing) {
        this.observe(client, event.room.name);
      } else {
        this.unobserve(client);
      }
      return next();
    });
    this.ctx.middleware(OnRoomLeave, async (_event, client, next) => {
      this.unobserve(client);
      this.sessions.delete(client);
      return next();
    });
    this.ctx.middleware(OnRoomCreate, async (event, _client, next) => {
      // Room finalization sends replays before running finalizors. Do not clear
      // policy state in OnRoomFinalize, which runs before those sends.
      event.room.addFinalizor((room) => {
        for (const [username, rooms] of this.observers) {
          rooms.delete(room.name);
          if (!rooms.size) {
            this.observers.delete(username);
          }
        }
      });
      return next();
    });
    this.ctx.middleware(YGOProStocReplay, async (_msg, client, next) => {
      if (this.isReplayBlocked(client)) {
        return;
      }
      return next();
    });
    this.ctx.middleware(
      YGOProStocChatReplayHint,
      async (_msg, client, next) => {
        if (this.isReplayBlocked(client)) {
          return;
        }
        return next();
      },
    );
  }

  private isReplayBlocked(client: Client) {
    return (
      client.pos === NetPlayerType.OBSERVER &&
      this.sessions.get(client)?.blocked === true
    );
  }

  private observe(client: Client, roomName: string) {
    const identity = this.identities.get(client);
    if (!identity) {
      return;
    }
    let session = this.sessions.get(client);
    if (!session || session.roomName !== roomName) {
      this.unobserve(client);
      session = {
        username: identity.username,
        roomName,
        blocked: !identity.active,
      };
      this.sessions.set(client, session);
    }
    let rooms = this.observers.get(session.username);
    if (!rooms) {
      rooms = new Map();
      this.observers.set(session.username, rooms);
    }
    let sessions = rooms.get(roomName);
    if (!sessions) {
      sessions = new Set();
      rooms.set(roomName, sessions);
    }
    sessions.add(session);
    if (rooms.size > 1) {
      for (const roomSessions of rooms.values()) {
        for (const current of roomSessions) {
          current.blocked = true;
        }
      }
    }
  }

  private unobserve(client: Client) {
    const session = this.sessions.get(client);
    if (!session) {
      return;
    }
    const rooms = this.observers.get(session.username);
    const sessions = rooms?.get(session.roomName);
    sessions?.delete(session);
    if (!sessions?.size) {
      rooms?.delete(session.roomName);
    }
    if (!rooms?.size) {
      this.observers.delete(session.username);
    }
  }
}
