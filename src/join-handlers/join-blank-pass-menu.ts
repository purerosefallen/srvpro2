import { YGOProCtosJoinGame } from 'ygopro-msg-encode';
import { Context } from '../app';
import { Client } from '../client';
import { MenuEntry, MenuManager, Welcome } from '../feats';

interface MenuNode {
  [key: string]: string | MenuNode;
}

export class JoinBlankPassMenu {
  private logger = this.ctx.createLogger(this.constructor.name);
  private menuManager = this.ctx.get(() => MenuManager);
  private enabled = this.ctx.config.getBoolean('ENABLE_MENU');
  private rootMenu = this.loadRootMenu();

  constructor(private ctx: Context) {
    if (!this.enabled) {
      return;
    }
    if (!this.rootMenu || !Object.keys(this.rootMenu).length) {
      this.logger.warn('MENU is empty or invalid, panel feature disabled');
      return;
    }

    this.ctx.middleware(YGOProCtosJoinGame, async (msg, client, next) => {
      msg.pass = (msg.pass || '').trim();
      if (msg.pass) {
        this.clearMenuContext(client);
        return next();
      }

      if (client.menuDispatchingJoin) {
        this.clearMenuContext(client);
        return next();
      }

      this.enterMenuContext(client, msg);
      await this.openMenuByPath(client, client.menuPath || []);
      return msg;
    });
  }

  private loadRootMenu() {
    const raw = this.ctx.config.getString('MENU').trim();
    if (!raw) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      return this.parseMenuNode(parsed, 'MENU');
    } catch (e) {
      this.logger.warn(
        { error: (e as Error).message },
        'Failed to parse MENU config',
      );
      return undefined;
    }
  }

  private parseMenuNode(value: unknown, path: string): MenuNode {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`${path} must be a JSON object`);
    }
    const parsed: MenuNode = {};
    for (const [label, entryValue] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (typeof entryValue === 'string') {
        parsed[label] = entryValue;
        continue;
      }
      if (
        entryValue &&
        typeof entryValue === 'object' &&
        !Array.isArray(entryValue)
      ) {
        parsed[label] = this.parseMenuNode(entryValue, `${path}.${label}`);
        continue;
      }
      throw new Error(`${path}.${label} must be a string or object`);
    }
    return parsed;
  }

  private enterMenuContext(client: Client, msg: YGOProCtosJoinGame) {
    client.menuPath = [];
    client.menuJoinVersion = msg.version;
    client.menuJoinGameId = msg.gameid;
  }

  private clearMenuContext(client: Client) {
    client.menuPath = undefined;
    client.menuJoinVersion = undefined;
    client.menuJoinGameId = undefined;
    client.menuDispatchingJoin = undefined;
  }

  private resolveMenuNode(path: string[]) {
    if (!this.rootMenu) {
      return undefined;
    }
    let node: MenuNode = this.rootMenu;
    for (const key of path) {
      const next = node[key];
      if (!next || typeof next === 'string') {
        return undefined;
      }
      node = next;
    }
    return node;
  }

  private buildMenuEntries(path: string[], node: MenuNode): MenuEntry[] {
    return Object.entries(node).map(([title, value]) => ({
      title,
      callback: async (client) => {
        if (typeof value === 'string') {
          await this.dispatchJoinGameFromMenu(client, value);
          return;
        }
        if (!Object.keys(value).length) {
          await this.returnToPreviousMenu(client, path);
          return;
        }
        client.menuPath = [...path, title];
        client.menuOffset = 0;
        await this.openMenuByPath(client, client.menuPath);
      },
    }));
  }

  private async openMenuByPath(client: Client, path: string[]) {
    const node = this.resolveMenuNode(path);
    if (!node) {
      client.disconnect();
      return;
    }
    client.menuPath = [...path];
    client.menuOffset = 0;
    const menu = this.buildMenuEntries(path, node);
    await this.menuManager.launchMenu(client, menu);
  }

  private async returnToPreviousMenu(client: Client, currentPath: string[]) {
    if (!currentPath.length) {
      client.disconnect();
      return;
    }
    const parentPath = currentPath.slice(0, -1);
    await this.openMenuByPath(client, parentPath);
  }

  private async dispatchJoinGameFromMenu(client: Client, pass: string) {
    const joinMsg = new YGOProCtosJoinGame().fromPartial({
      version:
        client.menuJoinVersion || this.ctx.config.getInt('YGOPRO_VERSION'),
      gameid: client.menuJoinGameId || 0,
      pass,
    });
    joinMsg.bypassEstablished = true;
    client.menuDispatchingJoin = !pass;
    await this.ctx.dispatch(joinMsg, client);
  }
}

declare module '../client' {
  interface Client {
    menuPath?: string[];
    menuJoinVersion?: number;
    menuJoinGameId?: number;
    menuDispatchingJoin?: boolean;
  }
}
