import { ChatColor, YGOProCtosJoinGame } from 'ygopro-msg-encode';
import { Context } from '../app';

export class JoinRoomIp {
  constructor(private ctx: Context) {
    this.ctx.middleware(YGOProCtosJoinGame, async (msg, client, next) => {
      const pass = (msg.pass || '').trim();
      if (!pass) {
        return next();
      }
      if (pass.toUpperCase() !== 'IP') {
        return next();
      }
      const ip = client.ip || client.physicalIp() || 'unknown';
      return client.die(`IP: ${ip}`, ChatColor.BABYBLUE);
    });
  }
}
