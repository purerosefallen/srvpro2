import { h } from 'koishi';
import { Context } from '../../app';
import { Client } from '../../client';
import { KoishiContextService } from '../../koishi';
import { DuelStage, Room, RoomManager } from '../../room';
import { KoishiFragment } from '../../utility';
import { WindBotProvider } from './windbot-provider';
import { sliceOcgcore } from '../../utility/slice-ocgcore';
import { RefreshFieldService } from '../reconnect';
import {
  YGOProCtosChat,
  YGOProCtosResponse,
  YGOProMsgNewTurn,
  YGOProMsgResponseBase,
  YGOProMsgSelectChain,
  YGOProMsgSelectPlace,
  YGOProMsgSelectPosition,
  YGOProMsgWaiting,
  YGOProMsgWin,
  YGOProStocChangeSide,
  YGOProStocDuelStart,
  YGOProStocGameMsg,
} from 'ygopro-msg-encode';

declare module '../../client' {
  interface Client {
    rewindBanChat?: boolean;
  }
}

declare module '../../room' {
  interface Room {
    rebuildingOcgcore?: boolean;
  }
}

export class RewindService {
  private koishiContextService = this.ctx.get(() => KoishiContextService);
  private windBotProvider = this.ctx.get(() => WindBotProvider);
  private rewindResponseWaiters = new Map<
    string,
    {
      resolve: () => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(private ctx: Context) {}

  async init() {
    if (!this.windBotProvider.isEnabled) {
      return;
    }
    this.registerKoishiCommand();
    this.ctx
      .middleware(YGOProCtosResponse, async (_message, client, next) => {
        const room = this.ctx
          .get(() => RoomManager)
          .findByName(client.roomName);
        if (room?.rebuildingOcgcore) {
          return undefined;
        }
        const waitKey = this.getRewindResponseWaitKey(client);
        if (!waitKey) {
          return next();
        }
        const waiter = this.rewindResponseWaiters.get(waitKey);
        if (!waiter) {
          return next();
        }
        this.rewindResponseWaiters.delete(waitKey);
        clearTimeout(waiter.timeout);
        waiter.resolve();
        return undefined;
      })
      .middleware(YGOProCtosChat, async (message, client, next) => {
        if (client.rewindBanChat) {
          return undefined;
        }
        return next();
      });
  }

  private asRedError(message: string) {
    return h('Chat', { color: 'Red' }, message);
  }

  private registerKoishiCommand() {
    if (!this.windBotProvider.isEnabled) {
      return;
    }

    const koishi = this.koishiContextService.instance;
    this.koishiContextService.attachI18n('rewind', {
      description: 'koishi_cmd_rewind_desc',
    });

    koishi.command('rewind', '').action(async ({ session }) => {
      const commandContext =
        this.koishiContextService.resolveCommandContext(session);
      if (!commandContext) {
        return;
      }

      const { room, client } = commandContext;
      if (!room.windbot) {
        return this.asRedError('#{koishi_rewind_not_ai_room}');
      }
      if (room.duelStage !== DuelStage.Dueling) {
        return this.asRedError('#{koishi_rewind_duel_not_started}');
      }
      // if (room.responsePlayer !== client) {
      //   return this.asRedError('#{koishi_rewind_duel_not_self_responsing}');
      // }
      return this.rewind(room, client);
    });
  }

  private logger = this.ctx.createLogger(this.constructor.name);

  private getRewindResponseWaitKey(client: Pick<Client, 'roomName' | 'pos'>) {
    if (!client.roomName || client.pos == null) {
      return undefined;
    }
    return `${client.roomName}:${client.pos}`;
  }

  private waitForRewindResponse(client: Client) {
    const waitKey = this.getRewindResponseWaitKey(client);
    if (!waitKey) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const previous = this.rewindResponseWaiters.get(waitKey);
      if (previous) {
        this.rewindResponseWaiters.delete(waitKey);
        clearTimeout(previous.timeout);
        previous.resolve();
      }

      let settled = false;
      const waiter = {} as {
        resolve: () => void;
        timeout: ReturnType<typeof setTimeout>;
      };
      const settle = () => {
        if (settled) {
          return;
        }
        settled = true;
        if (this.rewindResponseWaiters.get(waitKey) === waiter) {
          this.rewindResponseWaiters.delete(waitKey);
        }
        clearTimeout(waiter.timeout);
        resolve();
      };
      waiter.resolve = settle;
      waiter.timeout = setTimeout(settle, 10_000);
      this.rewindResponseWaiters.set(waitKey, waiter);
    });
  }

  private async rewindSendToObserver(room: Room, client: Client) {
    for (const message of room.lastDuelRecord?.toPlayback((msg) =>
      msg.observerView(),
    ) || []) {
      await client.send(message);
    }
  }

  private async sendClosePopupMessage(client: Client) {
    await client.send(
      new YGOProStocGameMsg().fromPartial({
        msg: new YGOProMsgWin().fromPartial({
          player: 0x2, // DRAW_GAME
          type: 0x10, // just a reasonable reason
        }),
      }),
    );
    await client.send(new YGOProStocChangeSide());
    await client.send(new YGOProStocDuelStart());
  }

  private async rewindSendToPlayer(room: Room, client: Client) {
    if (client === room.responsePlayer) {
      await this.sendClosePopupMessage(client);
    }
    const refreshField = this.ctx.get(() => RefreshFieldService);
    return refreshField.sendReconnectDuelingMessages(client, room);
  }

  private async rewindSendToWindbot(room: Room, client: Client) {
    client.rewindBanChat = true;
    try {
      await this.sendClosePopupMessage(client);
      const ingameDuelPos = room.getIngameDuelPos(client);
      let turnCount = 0;
      const messages = [
        ...(room.lastDuelRecord?.toPlayback(
          (msg) => {
            if (msg instanceof YGOProMsgNewTurn && !(msg.player & 0x2)) {
              ++turnCount;
            }

            if (!msg.getSendTargets().includes(ingameDuelPos)) {
              return; // skip messages that are not sent to this player
            }

            if (
              client !== room.getIngameOperatingPlayer(ingameDuelPos, turnCount)
            ) {
              if (msg instanceof YGOProMsgResponseBase) {
                return; // skip every response for non-operating player
              }
              return msg.playerView(ingameDuelPos).teammateView();
            } else {
              return msg.playerView(ingameDuelPos);
            }
          },
          {
            includeResponse: true,
            includeNonObserver: true,
            msgStartPos: ingameDuelPos,
          },
        ) || []),
      ];
      for (let i = 0; i < messages.length; ++i) {
        const message = messages[i];
        await client.send(message);
        if (
          message.msg instanceof YGOProMsgResponseBase &&
          i < messages.length - 1
        ) {
          await this.waitForRewindResponse(client);
        }
      }
      if (client !== room.responsePlayer) {
        await client.send(
          new YGOProStocGameMsg().fromPartial({
            msg: new YGOProMsgWaiting(),
          }),
        );
      }
    } finally {
      client.rewindBanChat = false;
    }
  }

  async rewind(
    room: Room,
    client: Client,
  ): Promise<KoishiFragment | undefined> {
    let found = false;
    let turnCount = room.turnCount;
    const ingameDuelPos = room.getIngameDuelPos(client);
    const rewindMessageIndex =
      room.lastDuelRecord?.messages.findLastIndex((item, i) => {
        if (item instanceof YGOProMsgNewTurn && !(item.player & 0x2)) {
          --turnCount;
        }
        if (
          !(item instanceof YGOProMsgResponseBase) ||
          item.responsePlayer() !== ingameDuelPos ||
          room.getIngameOperatingPlayer(ingameDuelPos, turnCount) !== client
        ) {
          return false;
        }
        if (
          (item instanceof YGOProMsgSelectChain && !item.chains?.length) || // skip empty select chain messages
          item instanceof YGOProMsgSelectPosition || // skip select summon position / place
          item instanceof YGOProMsgSelectPlace ||
          (!found && room.responsePlayer === client) // skip messages before the first response message
        ) {
          found = true;
          return false;
        }
        return true;
      }) || -1;
    if (rewindMessageIndex === -1) {
      return this.asRedError('#{koishi_rewind_no_response_found}');
    }
    const rewindResponseIndex =
      room
        .lastDuelRecord!.messages.slice(0, rewindMessageIndex + 1)
        .filter((msg) => msg instanceof YGOProMsgResponseBase).length - 1;
    room.rebuildingOcgcore = true;
    try {
      await sliceOcgcore(room, rewindResponseIndex);
    } catch (e) {
      this.logger.warn(
        {
          error: e instanceof Error ? e.stack : e,
          pos: client.pos,
          rewindMessageIndex,
          rewindResponseIndex,
        },
        'Failed to rewind',
      );
      await room.finalize();
      return this.asRedError('#{koishi_rewind_failed}');
    } finally {
      room.rebuildingOcgcore = false;
    }
    await Promise.all([
      ...[...room.watchers].map((watcher) =>
        this.rewindSendToObserver(room, watcher),
      ),
      ...room.playingPlayers.map((player) =>
        player.windbot
          ? this.rewindSendToWindbot(room, player)
          : this.rewindSendToPlayer(room, player),
      ),
    ]);
    return '#{koishi_rewind_success}';
  }
}
