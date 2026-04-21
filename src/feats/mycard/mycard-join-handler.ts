import { YGOProCtosJoinGame } from 'ygopro-msg-encode';
import { Context } from '../../app';
import { MycardService } from './mycard-service';

export class MycardJoinHandler {
  private mycardService = this.ctx.get(() => MycardService);

  constructor(private ctx: Context) {}

  async init() {
    this.ctx.middleware(YGOProCtosJoinGame, async (msg, client, next) => {
      if (!this.mycardService.enabled) {
        return next();
      }
      const pass = (msg.pass || '').trim();
      msg.pass = pass;
      if (!pass || pass.startsWith('AI#')) {
        return next();
      }
      const handled = await this.mycardService.handleJoinPass(pass, client);
      if (!handled) {
        return next();
      }
      return msg;
    });
  }
}
