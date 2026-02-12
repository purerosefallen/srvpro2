import {
  YGOProCtosExternalAddress,
  YGOProCtosPlayerInfo,
} from 'ygopro-msg-encode';
import { Context } from '../app';
import { Client } from '../client';
import { IpResolver } from './ip-resolver';
import { WsClient } from '../transport/ws/client';

export class ClientHandler {
  constructor(private ctx: Context) {
    this.ctx.middleware(
      YGOProCtosExternalAddress,
      async (msg, client, next) => {
        if (client instanceof WsClient) {
          return next();
        }
        this.ctx
          .get(IpResolver)
          .setClientIp(
            client,
            msg.real_ip === '0.0.0.0' ? undefined : msg.real_ip,
          );
        return next();
      },
    );

    this.ctx.middleware(YGOProCtosPlayerInfo, async (msg, client, next) => {
      const [name, vpass] = msg.name.split('$');
      client.name = name;
      client.vpass = vpass || '';
      return next();
    });
  }

  private logger = this.ctx.createLogger('ClientHandler');

  async handleClient(client: Client): Promise<void> {
    try {
      client.init().receive$.subscribe(async (msg) => {
        try {
          await this.ctx.dispatch(msg, client);
        } catch (e) {
          this.logger.warn(
            `Error dispatching message ${msg.constructor.name} from ${client.loggingIp()}: ${(e as Error).message}`,
          );
        }
      });
    } catch {
      client.disconnect();
    }
  }
}
