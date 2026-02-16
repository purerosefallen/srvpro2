import { h } from 'koishi';
import { YGOProCtosSurrender } from 'ygopro-msg-encode';
import { Context } from '../app';
import { RefreshFieldService } from '../feats';
import { KoishiContextService } from './koishi-context-service';

export class CommandsService {
  private logger = this.ctx.createLogger(this.constructor.name);
  private koishiContextService = this.ctx.get(() => KoishiContextService);
  private refreshFieldService = this.ctx.get(() => RefreshFieldService);

  constructor(private ctx: Context) {
    const koishi = this.koishiContextService.instance;
    this.koishiContextService
      .attachI18n('surrender', {
        description: 'koishi_cmd_surrender_desc',
      })
      .attachI18n('roomname', {
        description: 'koishi_cmd_roomname_desc',
      })
      .attachI18n('refresh', {
        description: 'koishi_cmd_refresh_desc',
      })
      .attachI18n('ip', {
        description: 'koishi_cmd_ip_desc',
      });

    koishi
      .command('surrender', '')
      .alias('投降')
      .action(async ({ session }) => {
        const commandContext =
          this.koishiContextService.resolveCommandContext(session);
        if (!commandContext) {
          return;
        }
        await this.ctx.dispatch(new YGOProCtosSurrender(), commandContext.client);
      });

    koishi.command('roomname', '').action(({ session }) => {
      const commandContext =
        this.koishiContextService.resolveCommandContext(session);
      if (!commandContext) {
        return;
      }
      return `#{room_name} ${commandContext.room.name}`;
    });

    koishi.command('refresh', '').action(async ({ session }) => {
      const commandContext =
        this.koishiContextService.resolveCommandContext(session);
      if (!commandContext) {
        return;
      }

      try {
        await this.refreshFieldService.sendRefreshFieldMessages(
          commandContext.client,
          commandContext.room,
        );
        return '#{refresh_success}';
      } catch (error) {
        this.logger.warn(
          {
            roomName: commandContext.room.name,
            clientName: commandContext.client.name,
            error: (error as Error).toString(),
          },
          'Failed refreshing field by /refresh',
        );
        return h('Chat', { color: 'Red' }, '#{refresh_fail}');
      }
    });

    koishi.command('ip', '').action(({ session }) => {
      const commandContext =
        this.koishiContextService.resolveCommandContext(session);
      if (!commandContext) {
        return;
      }
      const ip =
        commandContext.client.ip ||
        commandContext.client.physicalIp() ||
        'unknown';
      return `IP: ${ip}`;
    });
  }
}
