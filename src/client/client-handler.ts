import {
  NetPlayerType,
  YGOProCtosBase,
  YGOProCtosExternalAddress,
  YGOProCtosJoinGame,
  YGOProCtosPlayerInfo,
} from 'ygopro-msg-encode';
import { Context } from '../app';
import { Client } from './client';
import { IpResolver } from './ip-resolver';
import {
  forkJoin,
  filter,
  takeUntil,
  timeout,
  firstValueFrom,
  merge,
  map,
  take,
  startWith,
  switchMap,
  timer,
} from 'rxjs';
import { YGOProCtosDisconnect } from '../utility/ygopro-ctos-disconnect';
import PQueue from 'p-queue';
import { DuelStage, RoomManager } from '../room';

export class ClientHandler {
  private static readonly CLIENT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

  constructor(private ctx: Context) {}

  private isPreHandshakeMsg(msg: YGOProCtosBase): boolean {
    return [
      YGOProCtosExternalAddress,
      YGOProCtosPlayerInfo,
      YGOProCtosJoinGame,
    ].some((allowed) => (msg instanceof allowed) as boolean);
  }

  async init() {
    this.ctx
      .middleware(YGOProCtosExternalAddress, async (msg, client, next) => {
        if (client.ip) {
          // ws/reverse-ws should already have IP from connection metadata, skip overwrite
          return next();
        }
        await this.ctx
          .get(() => IpResolver)
          .setClientIp(
            client,
            msg.real_ip === '0.0.0.0' ? undefined : msg.real_ip,
          );
        client.hostname = msg.hostname?.split(':')[0] || '';
        return next();
      })
      .middleware(YGOProCtosPlayerInfo, async (msg, client, next) => {
        if (!client.ip) {
          await this.ctx.get(() => IpResolver).setClientIp(client);
        }
        const [name, vpass] = msg.name.split('$');
        client.name = name;
        client.vpass = vpass || '';
        return next();
      })
      .middleware(YGOProCtosJoinGame, async (msg, client, next) => {
        if (!msg.bypassEstablished) {
          client.roompass = msg.pass || '';
        }
        return next();
      })
      .middleware(
        YGOProCtosBase,
        async (msg, client, next) => {
          if (msg instanceof YGOProCtosDisconnect) {
            return next();
          }
          const bypassEstablished =
            msg instanceof YGOProCtosJoinGame && msg.bypassEstablished;
          if (bypassEstablished) {
            delete msg.bypassEstablished;
            return next();
          }

          if (!client.established && !this.isPreHandshakeMsg(msg)) {
            // disallow any messages before handshake is complete, except for the ones needed for handshake
            return undefined;
          }
          return next();
        },
        true,
      );
  }

  private logger = this.ctx.createLogger('ClientHandler');

  async handleClient(client: Client) {
    client.init();

    // 将 disconnect$ 映射为 YGOProCtosDisconnect 消息
    const disconnect$ = client.disconnect$.pipe(
      map(({ bySystem }) => {
        const msg = new YGOProCtosDisconnect();
        msg.bySystem = bySystem;
        return msg;
      }),
    );

    // 合并 receive$ 和 disconnect$
    const receive$ = merge(client.receive$, disconnect$);
    const dispatchQueue = new PQueue({ concurrency: 1 });

    receive$.subscribe((msg) => {
      dispatchQueue.add(async () => this.dispatchClientMessage(client, msg));
    });

    const handshake$ = forkJoin([
      client.receive$.pipe(
        filter((msg) => msg instanceof YGOProCtosPlayerInfo),
        take(1),
        takeUntil(client.disconnect$),
      ),
      client.receive$.pipe(
        filter((msg) => msg instanceof YGOProCtosJoinGame),
        take(1),
        takeUntil(client.disconnect$),
      ),
    ]).pipe(
      timeout(client.expectHandshakeTimeout()),
      takeUntil(client.disconnect$),
    );

    return firstValueFrom(handshake$)
      .then(() => {
        this.logger.debug({ client: client.name }, 'Handshake completed');
        client.established = true;
        this.installIdleDisconnectGuard(client);
        return true;
      })
      .catch((error) => {
        this.logger.debug(
          {
            client: client.name || client.loggingIp(),
            ip: client.loggingIp(),
            isInternal: client.isInternal,
            error: (error as Error)?.message || String(error),
          },
          'Handshake failed, disconnecting client',
        );
        client.disconnect();
        return false;
      });
  }

  private async dispatchClientMessage(client: Client, msg: YGOProCtosBase) {
    this.logger.debug(
      {
        msgName: msg.constructor.name,
        client: client.name || client.loggingIp(),
        payload: JSON.stringify(msg),
      },
      'Received client message',
    );
    try {
      await this.ctx.dispatch(msg, client);
    } catch (e) {
      this.logger.warn(
        `Error dispatching message ${msg.constructor.name} from ${client.loggingIp()}: ${(e as Error).stack}`,
      );
    }
  }

  private installIdleDisconnectGuard(client: Client) {
    client.receive$
      .pipe(
        filter((msg) => !this.isPreHandshakeMsg(msg)),
        startWith(undefined),
        switchMap(() => timer(ClientHandler.CLIENT_IDLE_TIMEOUT_MS)),
        filter(() => {
          const room = this.ctx
            .get(() => RoomManager)
            .findByName(client.roomName);
          return !(
            room &&
            client.pos === NetPlayerType.OBSERVER &&
            room.duelStage !== DuelStage.Begin
          );
        }),
        take(1),
        takeUntil(client.disconnect$),
      )
      .subscribe(() => {
        this.logger.info(
          { client: client.name || client.loggingIp(), ip: client.loggingIp() },
          'Disconnecting idle client due to inactivity timeout',
        );
        client.disconnect();
      });
  }
}

declare module 'ygopro-msg-encode' {
  interface YGOProCtosJoinGame {
    bypassEstablished?: boolean;
  }
}
