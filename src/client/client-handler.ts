import {
  YGOProCtosBase,
  YGOProCtosExternalAddress,
  YGOProCtosJoinGame,
  YGOProCtosLeaveGame,
  YGOProCtosPlayerInfo,
} from 'ygopro-msg-encode';
import { Context } from '../app';
import { Client } from './client';
import { IpResolver } from '../services/ip-resolver';
import { WsClient } from '../transport/ws/client';
import { forkJoin, filter, takeUntil, timeout, firstValueFrom } from 'rxjs';

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
          ].some((allowed) => msg instanceof allowed);
          if (client.established !== isPreHandshakeMsg) {
            // disallow any messages before handshake is complete, except for the ones needed for handshake
            return undefined;
          }
          return next();
        },
        true,
      )
      .middleware(
        YGOProCtosLeaveGame, // this means immediately disconnect the client when they send leave game message, which is what official server does
        async (msg, client, next) => {
          return client.disconnect();
        },
        true,
      );
  }

  private logger = this.ctx.createLogger('ClientHandler');

  async handleClient(client: Client): Promise<void> {
    client.init();
    const receive$ = client.receive$;

    receive$.subscribe(async (msg) => {
      try {
        await this.ctx.dispatch(msg, client);
      } catch (e) {
        this.logger.warn(
          `Error dispatching message ${msg.constructor.name} from ${client.loggingIp()}: ${(e as Error).message}`,
        );
      }
    });

    const handshake$ = forkJoin([
      receive$.pipe(
        filter((msg) => msg instanceof YGOProCtosPlayerInfo),
        takeUntil(client.disconnect$),
      ),
      receive$.pipe(
        filter((msg) => msg instanceof YGOProCtosJoinGame),
        takeUntil(client.disconnect$),
      ),
    ]).pipe(timeout(5000), takeUntil(client.disconnect$));

    firstValueFrom(handshake$)
      .then(() => {
        client.established = true;
      })
      .catch(() => {
        client.disconnect();
      });
  }
}
