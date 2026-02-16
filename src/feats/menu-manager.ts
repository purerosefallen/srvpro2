import {
  GameMode,
  NetPlayerType,
  YGOProCtosBase,
  YGOProCtosHsToDuelist,
  YGOProCtosKick,
  YGOProStocHsPlayerEnter,
  YGOProStocJoinGame,
  YGOProStocTypeChange,
} from 'ygopro-msg-encode';
import { Context } from '../app';
import { Chnroute, Client, I18nService } from '../client';
import { DefaultHostinfo } from '../room';
import { resolvePanelPageLayout } from '../utility';

export type MenuEntry = {
  title: string;
  callback: (client: Client) => Promise<unknown> | unknown;
};

type MenuAction =
  | {
      type: 'entry';
      entry: MenuEntry;
    }
  | {
      type: 'next';
      title: string;
      offset: number;
    }
  | {
      type: 'prev';
      title: string;
      offset: number;
    };

type MenuView = {
  actions: MenuAction[];
  mode: GameMode;
  slotCount: number;
};

export class MenuManager {
  private i18n = this.ctx.get(() => I18nService);
  private chnroute = this.ctx.get(() => Chnroute);

  constructor(private ctx: Context) {
    this.ctx.middleware(
      YGOProCtosBase,
      async (msg, client, next) => {
        if (!client.currentMenu) {
          return next();
        }
        if (msg instanceof YGOProCtosHsToDuelist || msg instanceof YGOProCtosKick) {
          return next();
        }
        return undefined;
      },
      true,
    );

    this.ctx.middleware(YGOProCtosHsToDuelist, async (msg, client, next) => {
      if (!client.currentMenu) {
        return next();
      }
      await this.renderMenu(client);
      return msg;
    });

    this.ctx.middleware(YGOProCtosKick, async (msg, client, next) => {
      if (!client.currentMenu) {
        return next();
      }
      await this.handleKick(client, Number(msg.pos));
      return undefined;
    });
  }

  async launchMenu(client: Client, menu: MenuEntry[]) {
    client.currentMenu = menu;
    if (client.menuOffset == null) {
      client.menuOffset = 0;
    }
    await this.renderMenu(client);
  }

  clearMenu(client: Client) {
    client.currentMenu = undefined;
    client.menuOffset = undefined;
  }

  private buildMenuView(client: Client): MenuView {
    const menu = client.currentMenu || [];
    if (menu.length <= 2) {
      return {
        actions: menu.map((entry) => ({ type: 'entry', entry })),
        mode: GameMode.SINGLE,
        slotCount: 2,
      };
    }
    if (menu.length <= 4) {
      return {
        actions: menu.map((entry) => ({ type: 'entry', entry })),
        mode: GameMode.TAG,
        slotCount: 4,
      };
    }

    const layout = resolvePanelPageLayout(menu.length, client.menuOffset || 0);
    client.menuOffset = layout.pageStart;
    const actions: MenuAction[] = [];

    if (layout.isFirstPage) {
      for (const entry of menu.slice(layout.pageStart, layout.pageStart + 3)) {
        actions.push({ type: 'entry', entry });
      }
      actions.push({
        type: 'next',
        title: '#{menu_next_page}',
        offset: layout.pageStarts[layout.pageIndex + 1],
      });
    } else if (layout.isLastPage) {
      actions.push({
        type: 'prev',
        title: '#{menu_prev_page}',
        offset: layout.pageStarts[layout.pageIndex - 1],
      });
      for (const entry of menu.slice(layout.pageStart, layout.pageStart + 3)) {
        actions.push({ type: 'entry', entry });
      }
    } else {
      actions.push({
        type: 'prev',
        title: '#{menu_prev_page}',
        offset: layout.pageStarts[layout.pageIndex - 1],
      });
      for (const entry of menu.slice(layout.pageStart, layout.pageStart + 2)) {
        actions.push({ type: 'entry', entry });
      }
      actions.push({
        type: 'next',
        title: '#{menu_next_page}',
        offset: layout.pageStarts[layout.pageIndex + 1],
      });
    }

    return {
      actions,
      mode: GameMode.TAG,
      slotCount: 4,
    };
  }

  private async renderMenu(client: Client) {
    if (!client.currentMenu) {
      return;
    }

    const view = this.buildMenuView(client);
    await client.send(
      new YGOProStocJoinGame().fromPartial({
        info: {
          ...DefaultHostinfo,
          mode: view.mode,
        },
      }),
    );
    await client.send(
      new YGOProStocTypeChange().fromPartial({
        type: NetPlayerType.OBSERVER | 0x10,
      }),
    );

    const locale = this.chnroute.getLocale(client.ip);
    for (let i = 0; i < view.slotCount; i++) {
      const action = view.actions[i];
      const rawTitle =
        action?.type === 'entry' ? action.entry.title : action?.title || '';
      const title = rawTitle
        ? String(await this.i18n.translate(locale, rawTitle)).slice(0, 20)
        : '';
      await client.send(
        new YGOProStocHsPlayerEnter().fromPartial({
          name: title,
          pos: i,
        }),
      );
    }
  }

  private async handleKick(client: Client, index: number) {
    if (!client.currentMenu) {
      return;
    }

    const view = this.buildMenuView(client);
    const selected = view.actions[index];
    if (!selected) {
      await this.renderMenu(client);
      return;
    }

    if (selected.type === 'next' || selected.type === 'prev') {
      client.menuOffset = selected.offset;
      await this.renderMenu(client);
      return;
    }

    const callback = selected.entry.callback;
    this.clearMenu(client);
    await callback(client);
  }
}

declare module '../client' {
  interface Client {
    currentMenu?: MenuEntry[];
    menuOffset?: number;
  }
}
