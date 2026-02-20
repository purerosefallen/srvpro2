import { ChatColor, YGOProCtosChat } from 'ygopro-msg-encode';
import { Context } from '../app';

export class ChatLengthCheck {
  constructor(private ctx: Context) {}

  async init() {
    this.ctx.middleware(YGOProCtosChat, async (msg, client, next) => {
      const content = (msg.msg || '').trim();
      if (content.length <= 0) {
        return;
      }
      if (content.length > 100) {
        await client.sendChat('#{chat_warn_level0}', ChatColor.RED);
        return;
      }
      return next();
    });
  }
}
