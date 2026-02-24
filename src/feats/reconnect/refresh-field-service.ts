import {
  NetPlayerType,
  OcgcoreCommonConstants,
  OcgcoreScriptConstants,
  YGOProMsgDeckTop,
  YGOProMsgHint,
  YGOProMsgNewPhase,
  YGOProMsgNewTurn,
  YGOProMsgReverseDeck,
  YGOProMsgStart,
  YGOProMsgWaiting,
  YGOProStocGameMsg,
} from 'ygopro-msg-encode';
import { Context } from '../../app';
import { Client } from '../../client';
import { DuelStage, OnRoomDuelStart, Room, RoomManager } from '../../room';

declare module '../../room/' {
  interface Room {
    deckReversed?: boolean;
  }
}

export class RefreshFieldService {
  constructor(private ctx: Context) {}

  async init() {
    this.ctx
      .middleware(OnRoomDuelStart, async (event, client, next) => {
        const room = event.room;
        room.deckReversed = false;
        return next();
      })
      .middleware(YGOProMsgReverseDeck, async (event, client, next) => {
        const room = this.ctx
          .get(() => RoomManager)
          .findByName(client.roomName);
        if (room) {
          room.deckReversed = !room.deckReversed;
        }
        return next();
      });
  }

  async sendReconnectDuelingMessages(client: Client, room: Room) {
    this.assertRefreshAllowed(client, room);
    await this.sendMsgStart(client, room);
    await this.sendNewTurnMessages(client, room);
    await this.sendRefreshFieldMessages(client, room);
  }

  async sendRefreshFieldMessages(client: Client, room: Room) {
    this.assertRefreshAllowed(client, room);

    if (room.phase != null) {
      await client.send(
        new YGOProStocGameMsg().fromPartial({
          msg: new YGOProMsgNewPhase().fromPartial({
            phase: room.phase,
          }),
        }),
      );
    }

    await client.send(await this.requestField(room));
    await this.sendRefreshMessages(client, room);

    if (room.deckReversed) {
      await client.send(
        new YGOProStocGameMsg().fromPartial({
          msg: new YGOProMsgReverseDeck(),
        }),
      );
    }

    for (let igp = 0; igp < 2; ++igp) {
      const deckQuery = await room.ocgcore.queryFieldCard({
        player: igp,
        location: OcgcoreScriptConstants.LOCATION_DECK,
        queryFlag:
          OcgcoreCommonConstants.QUERY_CODE |
          OcgcoreCommonConstants.QUERY_POSITION,
        useCache: 0,
      });
      const lastCard = deckQuery.cards[deckQuery.cards.length - 1];
      if (lastCard) {
        let code = lastCard.code;
        const isFaceUp =
          (lastCard.position & OcgcoreCommonConstants.POS_FACEUP) !== 0;
        if (isFaceUp) {
          code |= 0x80000000;
        }
        if (room.deckReversed || isFaceUp) {
          await client.send(
            new YGOProStocGameMsg().fromPartial({
              msg: new YGOProMsgDeckTop().fromPartial({
                player: igp,
                sequence: 0,
                code,
              }),
            }),
          );
        }
      }
    }

    await room.sendTimeLimit(1 - room.getDuelPos(client), client);

    if (client === room.responsePlayer) {
      const lastHint = this.findLastHintForClient(client, room);
      if (lastHint) {
        await client.send(
          new YGOProStocGameMsg().fromPartial({
            msg: lastHint,
          }),
        );
      }

      if (room.lastResponseRequestMsg) {
        await client.send(
          new YGOProStocGameMsg().fromPartial({
            msg: room.lastResponseRequestMsg.playerView(
              room.getIngameDuelPos(client),
            ),
          }),
        );
        await room.setResponseTimer(room.getDuelPos(client));
      }
    } else {
      await client.send(
        new YGOProStocGameMsg().fromPartial({
          msg: new YGOProMsgWaiting(),
        }),
      );
      await room.sendTimeLimit(room.getDuelPos(client), client);
    }
  }

  private assertRefreshAllowed(client: Client, room: Room) {
    if (room.duelStage !== DuelStage.Dueling) {
      throw new Error(`Room ${room.name} is not in dueling stage`);
    }
    if (client.pos >= NetPlayerType.OBSERVER) {
      throw new Error(
        `Client ${client.name || client.ip} is not an active duelist`,
      );
    }
  }

  async sendMsgStart(client: Client, room: Room) {
    const playerType = room.getIngameDuelPos(client);
    await client.send(
      new YGOProStocGameMsg().fromPartial({
        msg: new YGOProMsgStart().fromPartial({
          playerType,
          duelRule: room.hostinfo.duel_rule,
          startLp0: room.hostinfo.start_lp,
          startLp1: room.hostinfo.start_lp,
          player0: {
            deckCount: 0,
            extraCount: 0,
          },
          player1: {
            deckCount: 0,
            extraCount: 0,
          },
        }),
      }),
    );
  }

  async sendNewTurnMessages(client: Client, room: Room) {
    const turnCount = Math.max(1, room.turnCount || 0);
    if (room.isTag) {
      const newTurnCount = turnCount % 4 || 4;
      for (let i = 0; i < newTurnCount; i += 1) {
        await client.send(
          new YGOProStocGameMsg().fromPartial({
            msg: new YGOProMsgNewTurn().fromPartial({
              player: i % 2,
            }),
          }),
        );
      }
      return;
    }

    const newTurnCount = turnCount % 2 === 0 ? 2 : 1;
    for (let i = 0; i < newTurnCount; i += 1) {
      await client.send(
        new YGOProStocGameMsg().fromPartial({
          msg: new YGOProMsgNewTurn().fromPartial({
            player: i,
          }),
        }),
      );
    }
  }

  private async requestField(room: Room): Promise<YGOProStocGameMsg> {
    if (!room.ocgcore) {
      throw new Error('OCGCore not initialized');
    }
    const info = await room.ocgcore.queryFieldInfo();
    return new YGOProStocGameMsg().fromPartial({
      msg: info.field,
    });
  }

  private async sendRefreshMessages(client: Client, room: Room) {
    const queryFlag = 0xefffff;
    const selfIngamePos = room.getIngameDuelPos(client);
    const opponentIngamePos = 1 - selfIngamePos;

    const locations = [
      OcgcoreScriptConstants.LOCATION_MZONE,
      OcgcoreScriptConstants.LOCATION_SZONE,
      OcgcoreScriptConstants.LOCATION_HAND,
      OcgcoreScriptConstants.LOCATION_GRAVE,
      OcgcoreScriptConstants.LOCATION_EXTRA,
      OcgcoreScriptConstants.LOCATION_REMOVED,
    ];
    const players = [opponentIngamePos, selfIngamePos];

    for (const location of locations) {
      for (const player of players) {
        await room.refreshLocations(
          { player, location },
          { queryFlag, sendToClient: client, useCache: 0 },
        );
      }
    }
  }

  private findLastHintForClient(
    client: Client,
    room: Room,
  ): YGOProMsgHint | undefined {
    const messages = room.lastDuelRecord?.messages;
    if (!messages) {
      return undefined;
    }

    const clientIngamePos = room.getIngameDuelPos(client);

    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i];
      if (!(msg instanceof YGOProMsgHint)) {
        continue;
      }
      try {
        const targets = msg.getSendTargets();
        if (targets.includes(clientIngamePos)) {
          return msg.playerView(clientIngamePos);
        }
      } catch {
        continue;
      }
    }

    return undefined;
  }
}
