import {
  ChatColor,
  NetPlayerType,
  OcgcoreScriptConstants,
  YGOProCtosBase,
  YGOProCtosJoinGame,
  YGOProCtosUpdateDeck,
  YGOProMsgHint,
  YGOProMsgNewPhase,
  YGOProMsgNewTurn,
  YGOProMsgStart,
  YGOProMsgWaiting,
  YGOProStocDuelStart,
  YGOProStocGameMsg,
  YGOProStocJoinGame,
  YGOProStocTypeChange,
  YGOProStocHsPlayerEnter,
  YGOProStocHsPlayerChange,
  YGOProStocSelectHand,
  YGOProStocSelectTp,
  YGOProStocChangeSide,
  ErrorMessageType,
  YGOProStocErrorMsg,
} from 'ygopro-msg-encode';
import { Context } from '../app';
import { Client } from '../client';
import { DuelStage } from '../room/duel-stage';
import { Room } from '../room';
import { RoomManager } from '../room/room-manager';
import { getSpecificFields } from '../utility/metadata';
import { YGOProCtosDisconnect } from '../utility/ygopro-ctos-disconnect';
import { isUpdateDeckPayloadEqual } from '../utility/deck-compare';
import { parseConfigBoolean } from '../utility/parse-config-boolean';

interface DisconnectInfo {
  roomName: string;
  clientPos: number;
  playerName: string;
  disconnectTime: Date;
  oldClient: Client;
  timeout: NodeJS.Timeout;
}

type ReconnectType = 'normal' | 'kick';

declare module '../client' {
  interface Client {
    preReconnecting?: boolean;
    reconnectType?: ReconnectType;
    preReconnectRoomName?: string; // 临时保存重连的目标房间名
  }
}

export class Reconnect {
  private disconnectList = new Map<string, DisconnectInfo>();
  private isLooseReconnectRule = false; // 宽松匹配模式，日后可能配置支持
  private reconnectTimeout = parseInt(
    this.ctx.getConfig('RECONNECT_TIMEOUT', '') || '180000',
    10,
  ); // 超时时间，单位：毫秒（默认 180000ms = 3分钟）

  constructor(private ctx: Context) {
    // 检查是否启用断线重连（默认启用）
    if (!parseConfigBoolean(this.ctx.getConfig('ENABLE_RECONNECT', ''), true)) {
      return;
    }

    // 拦截所有 CTOS 消息，过滤 pre_reconnecting 状态下的非法消息
    // 使用 true 参数确保这个 middleware 优先执行
    this.ctx.middleware(
      YGOProCtosBase,
      async (event, client, next) => {
        // 如果客户端处于 pre_reconnecting 状态
        if (client.preReconnecting) {
          // 只允许 UPDATE_DECK 消息通过
          if (event instanceof YGOProCtosUpdateDeck) {
            return next();
          }
          // 其他消息全部拒绝，不做任何处理
          return;
        }
        return next();
      },
      true, // 优先执行
    );

    // 拦截 DISCONNECT 消息
    this.ctx.middleware(YGOProCtosDisconnect, async (msg, client, next) => {
      // 如果是系统断线（如被踢），不允许重连
      if (msg.bySystem) {
        return next(); // 正常断线处理
      }

      if (!this.canReconnect(client)) {
        return next(); // 正常断线处理
      }

      await this.registerDisconnect(client);
      // 不调用 next()，阻止踢人
    });

    // 拦截 JOIN_GAME 消息
    this.ctx.middleware(YGOProCtosJoinGame, async (msg, client, next) => {
      if (await this.tryPreReconnect(client, msg)) {
        return; // 进入 pre_reconnect 状态
      }
      return next(); // 正常加入流程
    });

    // 拦截 UPDATE_DECK 消息
    this.ctx.middleware(YGOProCtosUpdateDeck, async (msg, client, next) => {
      if (client.preReconnecting) {
        await this.handleReconnectDeck(client, msg);
        return; // 处理完毕
      }
      return next(); // 正常更新卡组流程
    });
  }

  private canReconnect(client: Client): boolean {
    const room = this.getClientRoom(client);
    if (!room) {
      return false;
    }

    return (
      !client.isInternal && // 不是内部虚拟客户端
      client.pos < NetPlayerType.OBSERVER && // 是玩家
      room.duelStage !== DuelStage.Begin // 游戏已开始
    );
  }

  private async registerDisconnect(client: Client) {
    const room = this.getClientRoom(client)!;
    const key = this.getAuthorizeKey(client);

    // 通知房间
    await room.sendChat(
      `${client.name} #{disconnect_from_game}`,
      ChatColor.LIGHTBLUE,
    );

    // 保存断线信息
    const timeout = setTimeout(() => {
      this.handleTimeout(key);
    }, this.reconnectTimeout);

    this.disconnectList.set(key, {
      roomName: room.name,
      clientPos: client.pos,
      playerName: client.name,
      disconnectTime: new Date(),
      oldClient: client,
      timeout,
    });
  }

  private async tryPreReconnect(
    newClient: Client,
    msg: YGOProCtosJoinGame,
  ): Promise<boolean> {
    const key = this.getAuthorizeKey(newClient);
    const disconnectInfo = this.disconnectList.get(key);

    let room: Room | undefined;
    let oldClient: Client | undefined;
    let reconnectType: ReconnectType | undefined;

    // 1. 尝试正常断线重连
    if (disconnectInfo) {
      // 验证房间名（msg.pass 就是房间名）
      if (msg.pass !== disconnectInfo.roomName) {
        return false;
      }

      // 获取房间
      const roomManager = this.ctx.get(() => RoomManager);
      room = roomManager.findByName(disconnectInfo.roomName);
      if (!room) {
        // 房间已不存在，清理断线记录
        this.clearDisconnectInfo(disconnectInfo);
        return false;
      }

      oldClient = disconnectInfo.oldClient;
      reconnectType = 'normal';
    }

    // 2. 尝试踢人重连
    if (!room) {
      const kickTarget = this.findKickReconnectTarget(newClient);
      if (kickTarget) {
        room = this.getClientRoom(kickTarget)!;
        oldClient = kickTarget;
        reconnectType = 'kick';
      }
    }

    if (!room || !oldClient || !reconnectType) {
      return false; // 两种模式都不匹配
    }

    // 进入 pre_reconnect 阶段
    await this.sendPreReconnectInfo(newClient, room, oldClient, reconnectType);
    return true;
  }

  private async handleReconnectDeck(client: Client, msg: YGOProCtosUpdateDeck) {
    const reconnectType = client.reconnectType;
    if (!reconnectType) {
      // 不应该发生
      await client.sendChat('#{reconnect_failed}', ChatColor.RED);
      return client.disconnect();
    }

    // 验证卡组
    const isValid = await this.verifyReconnectDeck(client, msg, reconnectType);
    if (!isValid) {
      // 卡组不匹配
      await client.sendChat('#{deck_incorrect_reconnect}', ChatColor.RED);

      // 发送 HS_PLAYER_CHANGE (status = pos << 4 | 0xa)
      // 0xa = NOTREADY with deck error flag
      await client.send(
        new YGOProStocHsPlayerChange().fromPartial({
          playerPosition: client.pos,
          playerState: (client.pos << 4) | 0xa,
        }),
      );

      await client.send(
        new YGOProStocErrorMsg().fromPartial({
          msg: ErrorMessageType.DECKERROR,
          code: 0,
        }),
      );
      return;
    }

    // 卡组验证通过，执行真正的重连
    // 获取房间（可能房间已不存在）
    const roomManager = this.ctx.get(() => RoomManager);
    const room = client.preReconnectRoomName
      ? roomManager.findByName(client.preReconnectRoomName)
      : undefined;

    if (!room) {
      // 房间已不存在
      await client.sendChat('#{reconnect_failed}', ChatColor.RED);
      client.preReconnecting = false;
      client.reconnectType = undefined;
      client.preReconnectRoomName = undefined;
      return client.disconnect();
    }

    client.preReconnecting = false;
    client.reconnectType = undefined;
    client.preReconnectRoomName = undefined;

    if (reconnectType === 'normal') {
      const key = this.getAuthorizeKey(client);
      const disconnectInfo = this.disconnectList.get(key);
      if (!disconnectInfo) {
        await client.sendChat('#{reconnect_failed}', ChatColor.RED);
        return client.disconnect();
      }

      await this.performReconnect(client, disconnectInfo.oldClient, room);

      // 通知房间
      await room.sendChat(
        `${client.name} #{reconnect_to_game}`,
        ChatColor.LIGHTBLUE,
      );

      // 清理旧客户端
      disconnectInfo.oldClient.roomName = undefined;
      disconnectInfo.oldClient.pos = -1;
      disconnectInfo.oldClient.disconnect();

      // 清理断线记录
      this.clearDisconnectInfo(disconnectInfo);
    } else {
      // kick reconnect
      const oldClient = room.playingPlayers.find(
        (p) => p.name === client.name && p !== client,
      );
      if (!oldClient) {
        await client.sendChat('#{reconnect_failed}', ChatColor.RED);
        return client.disconnect();
      }

      await this.performReconnect(client, oldClient, room);

      // 通知房间
      await room.sendChat(
        `${client.name} #{reconnect_to_game}`,
        ChatColor.LIGHTBLUE,
      );

      // 清理旧客户端
      oldClient.roomName = undefined;
      oldClient.pos = -1;

      // kick reconnect 的区别：通知旧客户端被踢（不 await）
      oldClient
        .sendChat('#{reconnect_kicked}', ChatColor.RED)
        .then(() => oldClient.disconnect());
    }
  }

  private async sendPreReconnectInfo(
    client: Client,
    room: Room,
    oldClient: Client,
    reconnectType: ReconnectType,
  ) {
    // 设置 pre_reconnecting 状态
    client.preReconnecting = true;
    client.reconnectType = reconnectType;
    client.preReconnectRoomName = room.name; // 保存目标房间名
    client.pos = oldClient.pos;

    // 发送房间信息
    await client.sendChat('#{pre_reconnecting_to_room}', ChatColor.BABYBLUE);
    await client.send(room.joinGameMessage);

    // 发送 TYPE_CHANGE
    const typeChangePos = oldClient.isHost
      ? oldClient.pos | 0x10
      : oldClient.pos;
    await client.send(
      new YGOProStocTypeChange().fromPartial({
        type: typeChangePos,
      }),
    );

    // 发送其他玩家信息
    for (const player of room.players) {
      if (player) {
        await client.send(
          new YGOProStocHsPlayerEnter().fromPartial({
            name: player.name,
            pos: player.pos,
          }),
        );
      }
    }
  }

  private async verifyReconnectDeck(
    client: Client,
    msg: YGOProCtosUpdateDeck,
    reconnectType: ReconnectType,
  ): Promise<boolean> {
    if (reconnectType === 'normal') {
      // 正常重连：验证 disconnectInfo 中的 startDeck
      const key = this.getAuthorizeKey(client);
      const disconnectInfo = this.disconnectList.get(key);
      if (!disconnectInfo) {
        return false;
      }

      const oldStartDeck = disconnectInfo.oldClient.startDeck;
      if (!oldStartDeck) {
        return false;
      }

      // 比较卡组
      return isUpdateDeckPayloadEqual(msg.deck, oldStartDeck);
    } else {
      // 踢人重连：验证房间内玩家的 startDeck
      const roomManager = this.ctx.get(() => RoomManager);
      const room = client.preReconnectRoomName
        ? roomManager.findByName(client.preReconnectRoomName)
        : undefined;
      if (!room) {
        return false;
      }

      const oldClient = room.playingPlayers.find(
        (p) => p.name === client.name && p !== client,
      );
      if (!oldClient?.startDeck) {
        return false;
      }

      // 比较卡组
      return isUpdateDeckPayloadEqual(msg.deck, oldClient.startDeck);
    }
  }

  private async performReconnect(
    newClient: Client,
    oldClient: Client,
    room: Room,
  ) {
    // 1. 数据迁移（@ClientRoomField）
    this.importClientData(newClient, oldClient, room);

    // 2. 通知客户端正在重连
    await newClient.sendChat('#{reconnecting_to_room}', ChatColor.BABYBLUE);

    // 3. 根据 duelStage 发送不同的消息
    switch (room.duelStage) {
      case DuelStage.Finger:
        await this.performReconnectFinger(newClient, room);
        break;
      case DuelStage.FirstGo:
        await this.performReconnectFirstGo(newClient, room);
        break;
      case DuelStage.Siding:
        await this.performReconnectSiding(newClient, room);
        break;
      case DuelStage.Dueling:
        await this.performReconnectDueling(newClient, room);
        break;
      default:
        // Begin 或 End 阶段不应该重连
        break;
    }
  }

  private async performReconnectFinger(newClient: Client, room: Room) {
    // Finger 阶段：猜拳
    await newClient.send(new YGOProStocDuelStart());
    await newClient.send(room.prepareStocDeckCount(newClient.pos));

    // 检查是否需要发送 SELECT_HAND
    // 判断方法：getDuelPosPlayers 本端是第一个
    const duelPos = room.getDuelPos(newClient);
    const duelPosPlayers = room.getDuelPosPlayers(duelPos);
    const isFirstPlayer = duelPosPlayers[0] === newClient;

    // 检查是否已经猜过拳
    const hasSelected = room.handResult && room.handResult[duelPos] !== 0;

    // 只有每方的第一个玩家猜拳，并且没有猜过拳
    if (isFirstPlayer && !hasSelected) {
      await newClient.send(new YGOProStocSelectHand());
    }
  }

  private async performReconnectFirstGo(newClient: Client, room: Room) {
    // FirstGo 阶段：选先后手
    await newClient.send(new YGOProStocDuelStart());
    await newClient.send(room.prepareStocDeckCount(newClient.pos));

    // 检查是否是该玩家选先后手（duelPos 的第一个玩家）
    const duelPos = room.getDuelPos(newClient);
    if (duelPos === room.firstgoPos) {
      const firstgoPlayers = room.getDuelPosPlayers(duelPos);
      if (newClient === firstgoPlayers[0]) {
        await newClient.send(new YGOProStocSelectTp());
      }
    }
  }

  private async performReconnectSiding(newClient: Client, room: Room) {
    // Siding 阶段：更换副卡组
    await newClient.send(new YGOProStocDuelStart());

    // 检查玩家是否已经提交过卡组
    // Siding 阶段无论有没有换完都不发 DeckCount
    if (!newClient.deck) {
      // 还没有提交，发送 CHANGE_SIDE
      await newClient.send(new YGOProStocChangeSide());
    }
  }

  private async performReconnectDueling(newClient: Client, room: Room) {
    // Dueling 阶段：决斗中
    // 这是原来的完整重连逻辑
    await newClient.send(new YGOProStocDuelStart());
    // Dueling 阶段不发 DeckCount

    // 发送 MSG_START，卡组数量全部为 0（重连时不显示卡组数量）
    const playerType = room.getIngameDuelPos(newClient);
    await newClient.send(
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

    // 发送回合/阶段消息
    await newClient.send(
      new YGOProStocGameMsg().fromPartial({
        msg: new YGOProMsgNewTurn().fromPartial({
          player: room.turnIngamePos,
        }),
      }),
    );

    if (room.phase != null) {
      await newClient.send(
        new YGOProStocGameMsg().fromPartial({
          msg: new YGOProMsgNewPhase().fromPartial({
            phase: room.phase,
          }),
        }),
      );
    }

    // 发送 MSG_RELOAD_FIELD（核心状态重建）
    await newClient.send(await this.requestField(room));

    // 发送刷新消息
    await this.sendRefreshMessages(newClient, room);

    // 判断是否需要重发响应请求
    const needResendRequest =
      room.hostinfo.time_limit > 0 && // 有计时器
      this.isReconnectingPlayerOperating(newClient, room); // 重连玩家在操作

    if (needResendRequest) {
      // 重发 lastHintMsg（从 messages 找）
      const lastHint = this.findLastHintForClient(newClient, room);
      if (lastHint) {
        await newClient.send(
          new YGOProStocGameMsg().fromPartial({
            msg: lastHint,
          }),
        );
      }

      // 重发 lastResponseRequestMsg
      if (room.lastResponseRequestMsg) {
        await newClient.send(
          new YGOProStocGameMsg().fromPartial({
            msg: room.lastResponseRequestMsg.playerView(
              room.getIngameDuelPos(newClient),
            ),
          }),
        );
      }
    } else {
      // 不是重连玩家操作，发送 WAITING
      await newClient.send(
        new YGOProStocGameMsg().fromPartial({
          msg: new YGOProMsgWaiting(),
        }),
      );
    }
  }

  private importClientData(newClient: Client, oldClient: Client, room: Room) {
    // 获取所有 @ClientRoomField 装饰的字段
    const fields = getSpecificFields('clientRoomField', oldClient);

    // 迁移数据
    for (const { key } of fields) {
      (newClient as any)[key] = (oldClient as any)[key];
    }

    // 替换 room 中的引用
    this.replaceClientReferences(room, oldClient, newClient);
  }

  private replaceClientReferences(
    room: Room,
    oldClient: Client,
    newClient: Client,
  ) {
    // 替换 players 数组中的引用
    const playerIndex = room.players.indexOf(oldClient);
    if (playerIndex !== -1) {
      room.players[playerIndex] = newClient;
    }

    // 替换 watchers Set 中的引用（虽然重连只针对玩家，但以防万一）
    if (room.watchers.has(oldClient)) {
      room.watchers.delete(oldClient);
      room.watchers.add(newClient);
    }
  }

  private async requestField(room: Room): Promise<YGOProStocGameMsg> {
    if (!room.ocgcore) {
      throw new Error('OCGCore not initialized');
    }
    const info = await room.ocgcore.queryFieldInfo();

    // info.field 已经是 YGOProMsgReloadField 对象
    return new YGOProStocGameMsg().fromPartial({
      msg: info.field,
    });
  }

  private async sendRefreshMessages(client: Client, room: Room) {
    // 参考 ygopro RequestField 的逻辑，刷新各个区域
    // 使用 0xefffff queryFlag（重连专用，包含更完整的信息）
    const queryFlag = 0xefffff;

    // 按照 ygopro RequestField 的顺序刷新
    // 先对方，后自己（使用 ingame pos）
    const selfIngamePos = room.getIngameDuelPosByDuelPos(client.pos);
    const opponentIngamePos = 1 - selfIngamePos;

    // RefreshMzone
    await room.refreshLocations(
      {
        player: opponentIngamePos,
        location: OcgcoreScriptConstants.LOCATION_MZONE,
      },
      { queryFlag, sendToClient: client, useCache: 0 },
    );
    await room.refreshLocations(
      {
        player: selfIngamePos,
        location: OcgcoreScriptConstants.LOCATION_MZONE,
      },
      { queryFlag, sendToClient: client, useCache: 0 },
    );

    // RefreshSzone
    await room.refreshLocations(
      {
        player: opponentIngamePos,
        location: OcgcoreScriptConstants.LOCATION_SZONE,
      },
      { queryFlag, sendToClient: client, useCache: 0 },
    );
    await room.refreshLocations(
      {
        player: selfIngamePos,
        location: OcgcoreScriptConstants.LOCATION_SZONE,
      },
      { queryFlag, sendToClient: client, useCache: 0 },
    );

    // RefreshHand
    await room.refreshLocations(
      {
        player: opponentIngamePos,
        location: OcgcoreScriptConstants.LOCATION_HAND,
      },
      { queryFlag, sendToClient: client },
    );
    await room.refreshLocations(
      { player: selfIngamePos, location: OcgcoreScriptConstants.LOCATION_HAND },
      { queryFlag, sendToClient: client, useCache: 0 },
    );

    // RefreshGrave
    await room.refreshLocations(
      {
        player: opponentIngamePos,
        location: OcgcoreScriptConstants.LOCATION_GRAVE,
      },
      { queryFlag, sendToClient: client, useCache: 0 },
    );
    await room.refreshLocations(
      {
        player: selfIngamePos,
        location: OcgcoreScriptConstants.LOCATION_GRAVE,
      },
      { queryFlag, sendToClient: client, useCache: 0 },
    );

    // RefreshExtra
    await room.refreshLocations(
      {
        player: opponentIngamePos,
        location: OcgcoreScriptConstants.LOCATION_EXTRA,
      },
      { queryFlag, sendToClient: client, useCache: 0 },
    );
    await room.refreshLocations(
      {
        player: selfIngamePos,
        location: OcgcoreScriptConstants.LOCATION_EXTRA,
      },
      { queryFlag, sendToClient: client, useCache: 0 },
    );

    // RefreshRemoved
    await room.refreshLocations(
      {
        player: opponentIngamePos,
        location: OcgcoreScriptConstants.LOCATION_REMOVED,
      },
      { queryFlag, sendToClient: client, useCache: 0 },
    );
    await room.refreshLocations(
      {
        player: selfIngamePos,
        location: OcgcoreScriptConstants.LOCATION_REMOVED,
      },
      { queryFlag, sendToClient: client, useCache: 0 },
    );
  }

  private isReconnectingPlayerOperating(client: Client, room: Room): boolean {
    // 检查重连玩家是否是当前操作玩家
    const ingameDuelPos = room.getIngameDuelPosByDuelPos(client.pos);
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

    // 提前计算 ingame pos
    const clientIngamePos = room.getIngameDuelPosByDuelPos(client.pos);

    // 从后往前找
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];

      // 只找 Hint 消息
      if (!(msg instanceof YGOProMsgHint)) {
        continue;
      }

      // 检查 getSendTargets 是否包含重连玩家
      try {
        const targets = msg.getSendTargets(); // 返回 number[] (ingame pos 数组)
        if (targets.includes(clientIngamePos)) {
          return msg.playerView(clientIngamePos);
        }
      } catch {
        // getSendTargets 可能失败，忽略
        continue;
      }
    }

    return undefined;
  }

  private getAuthorizeKey(client: Client): string {
    // 参考 srvpro 逻辑
    // 如果有 vpass 且不是宽松匹配模式，优先用 name_vpass
    if (!this.isLooseReconnectRule && client.vpass) {
      return client.name_vpass;
    }

    // 宽松匹配模式或内部客户端
    if (this.isLooseReconnectRule) {
      return client.name || client.ip || 'undefined';
    }

    // 默认：ip:name
    return `${client.ip}:${client.name}`;
  }

  private getClientRoom(client: Client): Room | undefined {
    if (!client.roomName) {
      return undefined;
    }
    const roomManager = this.ctx.get(() => RoomManager);
    return roomManager.findByName(client.roomName);
  }

  private handleTimeout(key: string) {
    const disconnectInfo = this.disconnectList.get(key);
    if (!disconnectInfo) {
      return;
    }

    // 先清理断线记录，避免重复处理
    this.disconnectList.delete(key);

    // 然后重新 dispatch 带 bySystem 的 Disconnect 事件
    const msg = new YGOProCtosDisconnect();
    msg.bySystem = true; // 标记为系统断线，防止再次进入重连逻辑
    this.ctx.dispatch(msg, disconnectInfo.oldClient);
  }

  private clearDisconnectInfo(disconnectInfo: DisconnectInfo) {
    clearTimeout(disconnectInfo.timeout);
    const key = this.getAuthorizeKey(disconnectInfo.oldClient);
    this.disconnectList.delete(key);
  }

  private findKickReconnectTarget(newClient: Client): Client | undefined {
    const roomManager = this.ctx.get(() => RoomManager);
    const allRooms = roomManager.allRooms();

    for (const room of allRooms) {
      // 只在游戏进行中的房间查找
      if (room.duelStage === DuelStage.Begin) {
        continue;
      }

      // 查找符合条件的在线玩家
      for (const player of room.playingPlayers) {
        // if (player.disconnected) {
        //   continue; // 跳过已断线的玩家
        // }

        // 名字必须匹配
        if (player.name !== newClient.name) {
          continue;
        }

        // 宽松模式或匹配条件
        const matchCondition =
          this.isLooseReconnectRule ||
          player.ip === newClient.ip ||
          (newClient.vpass && newClient.vpass === player.vpass);

        if (matchCondition) {
          return player;
        }
      }
    }

    return undefined;
  }
}
