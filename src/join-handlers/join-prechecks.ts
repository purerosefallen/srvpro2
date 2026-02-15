import { ChatColor, YGOProCtosJoinGame } from 'ygopro-msg-encode';
import { Context } from '../app';

export class JoinPrechecks {
  constructor(private ctx: Context) {
    this.ctx.middleware(YGOProCtosJoinGame, async (msg, client, next) => {
      if (!client.name || !client.name.length) {
        return client.die('#{bad_user_name}', ChatColor.RED);
      }
      return next();
    });
  }
}
