import { ChatColor, YGOProCtosJoinGame } from 'ygopro-msg-encode';
import { Context } from '../app';
import { Client } from '../client';
import { MenuEntry, MenuManager } from '../feats';
import { JoinWindbotAi, WindBotProvider } from '../feats/windbot';

export class JoinBotlist {
  private menuManager = this.ctx.get(() => MenuManager);
  private joinWindbotAi = this.ctx.get(() => JoinWindbotAi);
  private windbotProvider = this.ctx.get(() => WindBotProvider);

  constructor(private ctx: Context) {}

  async init() {
    if (!this.windbotProvider.enabled) {
      return;
    }

    this.ctx.middleware(YGOProCtosJoinGame, async (msg, client, next) => {
      const pass = (msg.pass || '').trim();
      if (!pass || pass.toUpperCase() !== 'B') {
        return next();
      }

      await this.openBotListMenu(client);
      return msg;
    });
  }

  private async openBotListMenu(client: Client) {
    const bots = (await this.windbotProvider.loadBotList())
      .filter((bot) => !bot.hidden)
      .map((bot) => ({ name: bot.name, deck: bot.deck }));

    if (!bots.length)
      return client.die('#{windbot_deck_not_found}', ChatColor.RED);
    const menu: MenuEntry[] = bots.map((bot) => ({
      title: `${bot.name} - ${bot.deck}`,
      callback: async (menuClient) => {
        await this.openBotActionMenu(menuClient, bot.name);
      },
    }));

    await this.menuManager.launchMenu(client, menu);
  }

  private async openBotActionMenu(client: Client, botName: string) {
    const bot = this.windbotProvider.selectBot(
      await this.windbotProvider.loadBotList(),
      botName,
    );
    if (!bot) return client.die('#{windbot_deck_not_found}', ChatColor.RED);
    const botTitle = `${bot.name} - ${bot.deck}`;
    const menu: MenuEntry[] = [
      {
        title: botTitle,
        callback: async (menuClient) => {
          await this.openBotActionMenu(menuClient, botName);
        },
      },
      {
        title: '#{botlist_menu_single}',
        callback: async (menuClient) => {
          await this.joinWindbotAi.joinByPass(`AI#${botName}`, menuClient);
        },
      },
      {
        title: '#{botlist_menu_match}',
        callback: async (menuClient) => {
          await this.joinWindbotAi.joinByPass(`AI,M#${botName}`, menuClient);
        },
      },
      {
        title: '#{botlist_menu_back}',
        callback: async (menuClient) => {
          await this.openBotListMenu(menuClient);
        },
      },
    ];
    await this.menuManager.launchMenu(client, menu);
  }
}
