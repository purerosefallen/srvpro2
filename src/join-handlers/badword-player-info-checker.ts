import { ChatColor, YGOProCtosJoinGame } from 'ygopro-msg-encode';
import { Context } from '../app';
import { BadwordProvider } from '../feats/resource';

export class BadwordPlayerInfoChecker {
  private logger = this.ctx.createLogger(this.constructor.name);
  private badwordProvider = this.ctx.get(() => BadwordProvider);

  constructor(private ctx: Context) {
    if (this.ctx.config.getBoolean('TOURNAMENT_MODE')) {
      return;
    }

    if (!this.badwordProvider.enabled) {
      return;
    }

    this.ctx.middleware(YGOProCtosJoinGame, async (_msg, client, next) => {
      if (client.isInternal) {
        return next();
      }
      const userNameLevel = await this.badwordProvider.getBadwordLevel(
        client.name,
        undefined,
        client,
      );
      if (userNameLevel >= 1) {
        this.logger.warn(
          { level: userNameLevel, name: client.name, ip: client.ip },
          'Blocked join due to bad username',
        );
        return client.die(`#{bad_name_level${userNameLevel}}`, ChatColor.RED);
      }

      return next();
    });
  }
}
