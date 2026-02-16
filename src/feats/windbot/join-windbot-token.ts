import { ChatColor, YGOProCtosJoinGame } from 'ygopro-msg-encode';
import { Context } from '../../app';
import { WindBotProvider } from './windbot-provider';
import { RoomManager } from '../../room';

export class JoinWindbotToken {
  private windbotProvider = this.ctx.get(() => WindBotProvider);
  private roomManager = this.ctx.get(() => RoomManager);

  private logger = this.ctx.createLogger(this.constructor.name);

  constructor(private ctx: Context) {
    if (!this.windbotProvider.enabled) {
      return;
    }
    this.ctx.middleware(YGOProCtosJoinGame, async (msg, client, next) => {
      msg.pass = (msg.pass || '').trim();
      if (!msg.pass.startsWith('AIJOIN#')) {
        return next();
      }

      const token = msg.pass.slice('AIJOIN#'.length);
      const tokenData = this.windbotProvider.consumeJoinToken(token);
      if (!tokenData) {
        return client.die('#{invalid_password_not_found}', ChatColor.RED);
      }

      const room = this.roomManager.findByName(tokenData.roomName);
      if (!room) {
        return client.die('#{invalid_password_not_found}', ChatColor.RED);
      }

      client.isInternal = true;
      client.windbot = tokenData.windbot;
      return room.join(client);
    });
  }
}
