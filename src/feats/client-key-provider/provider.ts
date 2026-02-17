import { Context } from '../../app';
import { Client } from '../../client';

export class ClientKeyProvider {
  constructor(private ctx: Context) {}

  // Keep this switch for future compatibility with srvpro identity policies.
  get isLooseIdentityRule() {
    return this.ctx.config.getBoolean('TOURNAMENT_MODE');
  }

  getClientKey(client: Client): string {
    if (!this.isLooseIdentityRule && client.vpass) {
      return client.name_vpass;
    }
    if (this.isLooseIdentityRule) {
      return client.name || client.ip || 'undefined';
    }
    return `${client.ip}:${client.name}`;
  }
}
