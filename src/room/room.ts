import { Awaitable } from 'nfkit';
import { Context } from '../app';
import {
  HostInfo,
  NetPlayerType,
  YGOProStocHsWatchChange,
  YGOProStocJoinGame,
} from 'ygopro-msg-encode';
import { DefaultHostInfoProvider } from './default-hostinfo-provder';
import { CardReaderFinalized } from 'koishipro-core.js';
import { YGOProResourceLoader } from '../services/ygopro-resource-loader';
import { blankLFList } from '../utility/blank-lflist';
import { Client } from '../client/client';

export type RoomFinalizor = (self: Room) => Awaitable<any>;

export class Room {
  constructor(
    private ctx: Context,
    public name: string,
    private partialHostinfo: Partial<HostInfo> = {},
  ) {}

  hostinfo = this.ctx
    .get(() => DefaultHostInfoProvider)
    .parseHostinfo(this.name, this.partialHostinfo);

  players = new Array<Client>(this.hostinfo.mode === 2 ? 4 : 2);
  watchers = new Set<Client>();
  get allPlayers() {
    return [...this.players.filter((p) => p), ...this.watchers];
  }

  private get resourceLoader() {
    return this.ctx.get(() => YGOProResourceLoader);
  }
  private cardReader!: CardReaderFinalized;
  private lflist = blankLFList;

  private async findLFList() {
    const isTCG = this.hostinfo.rule === 1 && this.hostinfo.lflist === 0;
    let index = 0;
    for await (const lflist of this.resourceLoader.getLFLists()) {
      if (isTCG) {
        if (lflist.name?.includes(' TCG')) {
          return lflist;
        }
      } else {
        if (index === this.hostinfo.lflist) {
          return lflist;
        } else if (index > this.hostinfo.lflist) {
          return undefined;
        }
      }
      ++index;
    }
  }

  async init() {
    this.cardReader = await this.resourceLoader.getCardReader();
    if (this.hostinfo.lflist >= 0) {
      this.lflist = (await this.findLFList()) || blankLFList;
    }
    return this;
  }

  private finalizors: RoomFinalizor[] = [];
  addFinalizor(finalizor: RoomFinalizor) {
    this.finalizors.push(finalizor);
    return this;
  }

  async finalize() {
    while (this.finalizors.length) {
      const finalizor = this.finalizors.pop()!;
      await finalizor(this);
    }
  }

  get joinGameMessage() {
    return new YGOProStocJoinGame().fromPartial({
      info: {
        ...this.hostinfo,
        lflist: this.lflist === blankLFList ? 0 : this.lflist.getHash(),
      },
    });
  }

  get watcherSizeMessage() {
    return new YGOProStocHsWatchChange().fromPartial({
      watch_count: this.watchers.size,
    });
  }

  async join(client: Client) {
    client.roomName = this.name;
    client.disconnect$.subscribe(({ bySystem }) =>
      this.onPlayerDisconnect(client, bySystem),
    );
    client.isHost = !this.allPlayers.length;
    const firstEmptyPlayerSlot = this.players.findIndex((p) => !p);
    if (firstEmptyPlayerSlot >= 0) {
      this.players[firstEmptyPlayerSlot] = client;
      client.pos = firstEmptyPlayerSlot;
    } else {
      this.watchers.add(client);
      client.pos = NetPlayerType.OBSERVER;
    }
    await client.send(this.joinGameMessage);
    await client.sendTypeChange();
    for (let i = 0; i < this.players.length; ++i) {
      const p = this.players[i];
      if (p) {
        await client.send(p.prepareEnterPacket());
        await p.send(client.prepareEnterPacket());
        if (p.deck) {
          await client.send(p.prepareChangePacket());
        }
      }
    }
    if (this.watchers.size) {
      await client.send(this.watcherSizeMessage);
    }
  }

  async onPlayerDisconnect(client: Client) {
    if (client.pos === NetPlayerType.OBSERVER) {
      this.watchers.delete(client);
      for (const p of this.allPlayers) {
        p.send(this.watcherSizeMessage).then();
      }
      return;
    }
    client.roomName = undefined;
  }
}
