import {
  YGOProCtosBase,
  YGOProCtosExternalAddress,
  YGOProCtosJoinGame,
  YGOProCtosPlayerInfo,
} from 'ygopro-msg-encode';
import { Context } from '../app';
import { Client } from './client';
import { IpResolver } from './ip-resolver';
import { WsClient } from './transport/ws/client';
import {
  forkJoin,
  filter,
  takeUntil,
  timeout,
  firstValueFrom,
  merge,
  map,
  take,
} from 'rxjs';
import { YGOProCtosDisconnect } from '../utility/ygopro-ctos-disconnect';

export class ClientHandler {
  constructor(private ctx: Context) {
    this.ctx
      .middleware(YGOProCtosExternalAddress, async (msg, client, next) => {
        if (client instanceof WsClient || client.ip) {
          // ws should tell real IP and hostname in http headers, so we skip this step for ws clients
          return next();
        }
        this.ctx
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
          this.ctx.get(() => IpResolver).setClientIp(client);
        }
        const [name, vpass] = msg.name.split('$');
        client.name = name;
        client.vpass = vpass || '';
        return next();
      })
      .middleware(
        YGOProCtosBase,
        async (msg, client, next) => {
          const isPreHandshakeMsg = [
            YGOProCtosExternalAddress,
            YGOProCtosPlayerInfo,
            YGOProCtosJoinGame,
          ].some((allowed) => (msg instanceof allowed) as boolean);
          if (client.established === isPreHandshakeMsg) {
            // disallow any messages before handshake is complete, except for the ones needed for handshake
            return undefined;
          }
          return next();
        },
        true,
      );
  }

  private logger = this.ctx.createLogger('ClientHandler');

  async handleClient(client: Client): Promise<void> {
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

    receive$.subscribe(async (msg) => {
      this.logger.debug(
        {
          msgName: msg.constructor.name,
          client: client.name || client.loggingIp(),
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
    ]).pipe(timeout(5000), takeUntil(client.disconnect$));

    firstValueFrom(handshake$)
      .then(() => {
        this.logger.debug({ client: client.name }, 'Handshake completed');
        client.established = true;
      })
      .catch(() => {
        client.disconnect();
      });
  }
}
