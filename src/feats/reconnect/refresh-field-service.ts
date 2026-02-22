import {
  NetPlayerType,
  OcgcoreScriptConstants,
  YGOProMsgHint,
  YGOProMsgNewPhase,
  YGOProMsgNewTurn,
  YGOProMsgWaiting,
  YGOProStocGameMsg,
} from 'ygopro-msg-encode';
import { Context } from '../../app';
import { Client } from '../../client';
import { DuelStage, Room } from '../../room';

export class RefreshFieldService {
  constructor(private ctx: Context) {}

  async sendReconnectDuelingMessages(client: Client, room: Room) {
    this.assertRefreshAllowed(client, room);
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

    const needResendRequest = this.isReconnectingPlayerOperating(client, room);

    if (needResendRequest) {
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
      return;
    }

    await client.send(
      new YGOProStocGameMsg().fromPartial({
        msg: new YGOProMsgWaiting(),
      }),
    );
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

  private async sendNewTurnMessages(client: Client, room: Room) {
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

  private isReconnectingPlayerOperating(client: Client, room: Room): boolean {
    const ingameDuelPos = room.getIngameDuelPos(client);
    const operatingPlayer = room.getIngameOperatingPlayer(ingameDuelPos);
    return operatingPlayer === client;
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
