import { YGOProStocReplay } from 'ygopro-msg-encode';
import { Context } from '../app';

export class BlockReplay {
  private enabled = this.ctx.config.getBoolean('BLOCK_REPLAY_TO_PLAYER');

  constructor(private ctx: Context) {
    if (!this.enabled) {
      return;
    }

    this.ctx.middleware(YGOProStocReplay, async (_msg, client, next) => {
      if (client.roomName) {
        return;
      }
      return next();
    });
  }
}
