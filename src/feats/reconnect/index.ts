import {
  ChatColor,
  NetPlayerType,
  YGOProCtosBase,
  YGOProCtosJoinGame,
  YGOProCtosUpdateDeck,
  YGOProStocDuelStart,
  YGOProStocTypeChange,
  YGOProStocHsPlayerChange,
  YGOProStocSelectHand,
  YGOProStocSelectTp,
  YGOProStocChangeSide,
  ErrorMessageType,
  YGOProStocErrorMsg,
} from 'ygopro-msg-encode';
import { Context } from '../../app';
import { Client } from '../../client';
import { DuelStage, OnRoomFinalize, Room, RoomManager } from '../../room';
import { getSpecificFields } from '../../utility/metadata';
import { YGOProCtosDisconnect } from '../../utility/ygopro-ctos-disconnect';
import { isUpdateDeckPayloadEqual } from '../../utility/deck-compare';
import { PlayerName } from '../../utility';
import { CanReconnectCheck } from './can-reconnect-check';
import { ClientKeyProvider } from '../client-key-provider';
import { RefreshFieldService } from './refresh-field-service';
import { HidePlayerNameProvider } from '../hide-player-name-provider';
import { ChallongeService } from '../challonge-service';

interface DisconnectInfo {
  key: string;
  roomName: string;
  roomPos: number;
  disconnectTime: Date;
  timeout: NodeJS.Timeout;
}

type ReconnectType = 'normal' | 'kick';

declare module '../../client' {
  interface Client {
    preReconnecting?: boolean;
    reconnectType?: ReconnectType;
    preReconnectRoomName?: string; // 临时保存重连的目标房间名
    preReconnectRoomPos?: number; // 临时保存重连的目标玩家槽位
    preReconnectDisconnectKey?: string;
  }
}

declare module '../../room' {
  interface Room {
    noReconnect?: boolean;
  }
}

declare module '../../utility/ygopro-ctos-disconnect' {
  interface YGOProCtosDisconnect {
    byReconnectTimeout?: boolean;
  }
}

export class Reconnect {
  private disconnectList = new Map<string, DisconnectInfo>();
  private disconnectListByRoomName = new Map<string, Set<string>>();
  private reconnectTimeout = this.ctx.config.getInt('RECONNECT_TIMEOUT'); // 超时时间，单位：毫秒（默认 180000ms = 3分钟）
  private clientKeyProvider = this.ctx.get(() => ClientKeyProvider);
  private refreshFieldService = this.ctx.get(() => RefreshFieldService);
  private logger = this.ctx.createLogger(this.constructor.name);

  constructor(private ctx: Context) {}

  async init() {
    // 检查是否启用断线重连（默认启用）
    if (!this.ctx.config.getBoolean('ENABLE_RECONNECT')) {
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
      // 如果是系统断线（如被踢）或重连超时后的补发断线，不允许再次进入重连
      if (msg.bySystem || msg.byReconnectTimeout) {
        return next(); // 正常断线处理
      }

      const room = this.getClientRoom(client);
      if (!room) {
        return next();
      }

      if (!(await this.canReconnect(client, room))) {
        return next(); // 正常断线处理
      }

      await this.registerDisconnect(client, room);
      // 不调用 next()，阻止踢人
    });

    // 拦截 JOIN_GAME 消息
    this.ctx.middleware(YGOProCtosJoinGame, async (_msg, client, next) => {
      if (await this.tryPreReconnect(client)) {
        return; // 进入 pre_reconnect 状态
      }
      return next(); // 正常加入流程
    });

    this.ctx.middleware(OnRoomFinalize, async (event, _client, next) => {
      this.clearDisconnectInfoByRoomName(event.room.name);
      return next();
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

  private async canReconnect(client: Client, room: Room): Promise<boolean> {
    const canReconnect =
      !client.isInternal && // 不是内部虚拟客户端
      !room.noReconnect &&
      client.pos < NetPlayerType.OBSERVER && // 是玩家
      room.duelStage !== DuelStage.Begin; // 游戏已开始
    if (!canReconnect) {
      return false;
    }
    const check = await this.ctx.dispatch(
      new CanReconnectCheck(client, room),
      client,
    );
    return !!check?.canReconnect;
  }

  private async registerDisconnect(client: Client, room: Room) {
    const key = this.clientKeyProvider.getClientKey(client);
    const oldDisconnectInfo = this.disconnectList.get(key);
    if (oldDisconnectInfo) {
      this.clearDisconnectInfo(oldDisconnectInfo);
    }

    // 通知房间
    await room.sendChat(
      [PlayerName(client), ' #{disconnect_from_game}'],
      ChatColor.LIGHTBLUE,
    );

    // 保存断线信息
    const timeout = setTimeout(() => {
      this.handleTimeout(key);
    }, this.reconnectTimeout);

    this.disconnectList.set(key, {
      key,
      roomName: room.name,
      roomPos: client.pos,
      disconnectTime: new Date(),
      timeout,
    });

    let keySet = this.disconnectListByRoomName.get(room.name);
    if (!keySet) {
      keySet = new Set<string>();
      this.disconnectListByRoomName.set(room.name, keySet);
    }
    keySet.add(key);
  }

  private async tryPreReconnect(newClient: Client): Promise<boolean> {
    let room: Room | undefined;
    let roomPos: number | undefined;
    let reconnectType: ReconnectType | undefined;
    let disconnectInfo: DisconnectInfo | undefined;

    // 1. 尝试正常断线重连
    disconnectInfo = this.findDisconnectInfo(newClient);
    if (disconnectInfo) {
      room = this.ctx
        .get(() => RoomManager)
        .findByName(disconnectInfo.roomName);
      if (!room) {
        // 房间已不存在，清理断线记录
        this.clearDisconnectInfo(disconnectInfo);
        return false;
      }

      roomPos = disconnectInfo.roomPos;
      reconnectType = 'normal';
    }

    // 2. 尝试踢人重连
    if (!room) {
      const kickTarget = await this.findKickReconnectTarget(newClient);
      if (kickTarget) {
        room = this.getClientRoom(kickTarget)!;
        roomPos = kickTarget.pos;
        reconnectType = 'kick';
      }
    }

    if (
      !room ||
      roomPos === undefined ||
      !this.getRoomPlayer(room, roomPos) ||
      !reconnectType
    ) {
      return false; // 两种模式都不匹配
    }

    // 进入 pre_reconnect 阶段
    await this.sendPreReconnectInfo(
      newClient,
      room,
      roomPos,
      reconnectType,
      disconnectInfo?.key,
    );
    return true;
  }

  private async handleReconnectDeck(client: Client, msg: YGOProCtosUpdateDeck) {
    const reconnectType = client.reconnectType;
    if (!reconnectType) {
      // 不应该发生
      await client.sendChat('#{reconnect_failed}', ChatColor.RED);
      return client.disconnect();
    }

    const failReconnect = async () => {
      client.preReconnecting = false;
      client.reconnectType = undefined;
      client.preReconnectRoomName = undefined;
      client.preReconnectRoomPos = undefined;
      client.preReconnectDisconnectKey = undefined;
      await client.sendChat('#{reconnect_failed}', ChatColor.RED);
      return client.disconnect();
    };

    const roomManager = this.ctx.get(() => RoomManager);
    const room = client.preReconnectRoomName
      ? roomManager.findByName(client.preReconnectRoomName)
      : undefined;
    const preReconnectRoomPos = client.preReconnectRoomPos;
    if (!room || preReconnectRoomPos === undefined) {
      return failReconnect();
    }

    const roomPlayer = this.getRoomPlayer(room, preReconnectRoomPos);
    if (!roomPlayer) {
      return failReconnect();
    }

    if (!roomPlayer.startDeck) {
      return failReconnect();
    }

    if (!isUpdateDeckPayloadEqual(msg.deck, roomPlayer.startDeck)) {
      // 卡组不匹配
      await client.sendChat('#{deck_incorrect_reconnect}', ChatColor.RED);

      // 发送 HS_PLAYER_CHANGE (status = pos << 4 | 0xa)
      // 0xa = NOTREADY with deck error flag
      await client.send(
        new YGOProStocHsPlayerChange().fromPartial({
          playerPosition: preReconnectRoomPos,
          playerState: (preReconnectRoomPos << 4) | 0xa,
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
    client.preReconnecting = false;
    client.reconnectType = undefined;
    client.preReconnectRoomName = undefined;
    client.preReconnectRoomPos = undefined;
    const preReconnectDisconnectKey = client.preReconnectDisconnectKey;
    client.preReconnectDisconnectKey = undefined;

    if (preReconnectDisconnectKey) {
      const disconnectInfo = this.disconnectList.get(preReconnectDisconnectKey);
      if (disconnectInfo) {
        this.clearDisconnectInfo(disconnectInfo);
      }
    }

    if (!(await this.performReconnect(client, room, preReconnectRoomPos))) {
      await client.sendChat('#{reconnect_failed}', ChatColor.RED);
      return client.disconnect();
    }

    // 通知房间
    await room.sendChat(
      [PlayerName(client), ' #{reconnect_to_game}'],
      ChatColor.LIGHTBLUE,
    );

    // 清理旧客户端
    roomPlayer.roomName = undefined;
    roomPlayer.pos = -1;

    if (reconnectType === 'kick') {
      roomPlayer
        .sendChat('#{reconnect_kicked}', ChatColor.RED)
        .then(() => roomPlayer.disconnect());
      return;
    }

    roomPlayer.disconnect();
  }

  private async sendPreReconnectInfo(
    client: Client,
    room: Room,
    roomPos: number,
    reconnectType: ReconnectType,
    disconnectKey?: string,
  ) {
    const roomPlayer = this.getRoomPlayer(room, roomPos);
    if (!roomPlayer) {
      return;
    }

    // 设置 pre_reconnecting 状态
    client.preReconnecting = true;
    client.reconnectType = reconnectType;
    client.preReconnectRoomName = room.name; // 保存目标房间名
    client.preReconnectRoomPos = roomPos;
    client.preReconnectDisconnectKey = disconnectKey;

    // 发送房间信息
    await client.sendChat('#{pre_reconnecting_to_room}', ChatColor.BABYBLUE);
    await client.send(room.joinGameMessage);

    // 发送 TYPE_CHANGE
    const typeChangePos = roomPlayer.isHost ? roomPos | 0x10 : roomPos;
    await client.send(
      new YGOProStocTypeChange().fromPartial({
        type: typeChangePos,
      }),
    );

    const hidePlayerNameService = this.ctx.get(() => HidePlayerNameProvider);

    // 发送其他玩家信息
    for (const player of room.players) {
      if (player) {
        const packet = player.prepareEnterPacket();
        packet.name = hidePlayerNameService.getHidPlayerName(
          player,
          roomPlayer,
        );
        await client.send(packet);
      }
    }
  }

  private async performReconnect(
    newClient: Client,
    room: Room,
    roomPos: number,
  ): Promise<boolean> {
    const roomPlayer = this.getRoomPlayer(room, roomPos);
    if (!roomPlayer) {
      return false;
    }

    // 1. 数据迁移（@ClientRoomField）
    this.importClientData(newClient, roomPlayer, room, roomPos);

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

    return true;
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

    await this.refreshFieldService.sendReconnectDuelingMessages(
      newClient,
      room,
    );
  }

  private importClientData(
    newClient: Client,
    roomPlayer: Client,
    room: Room,
    roomPos: number,
  ) {
    // 获取所有 @ClientRoomField 装饰的字段
    const fields = getSpecificFields('clientRoomField', roomPlayer);

    // 迁移数据
    for (const { key } of fields) {
      (newClient as any)[key] = (roomPlayer as any)[key];
    }

    // 替换 room 中的引用
    this.replaceClientReferences(room, roomPos, newClient);
  }

  private replaceClientReferences(
    room: Room,
    roomPos: number,
    newClient: Client,
  ) {
    room.players[roomPos] = newClient;
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

    this.clearDisconnectInfo(disconnectInfo);

    // 然后重新 dispatch 一个“非系统断线但不再允许重连”的 Disconnect 事件
    const msg = new YGOProCtosDisconnect();
    msg.byReconnectTimeout = true;
    const room = this.ctx
      .get(() => RoomManager)
      .findByName(disconnectInfo.roomName);
    const roomPlayer = room
      ? this.getRoomPlayer(room, disconnectInfo.roomPos)
      : undefined;
    if (roomPlayer) {
      this.ctx.dispatch(msg, roomPlayer);
    }
  }

  private clearDisconnectInfo(disconnectInfo: DisconnectInfo) {
    clearTimeout(disconnectInfo.timeout);
    this.disconnectList.delete(disconnectInfo.key);

    const keySet = this.disconnectListByRoomName.get(disconnectInfo.roomName);
    keySet?.delete(disconnectInfo.key);
    if (keySet?.size === 0) {
      this.disconnectListByRoomName.delete(disconnectInfo.roomName);
    }
  }

  private clearDisconnectInfoByRoomName(roomName: string) {
    const keySet = this.disconnectListByRoomName.get(roomName);
    if (!keySet) {
      return;
    }

    for (const key of [...keySet]) {
      const disconnectInfo = this.disconnectList.get(key);
      if (!disconnectInfo) {
        keySet.delete(key);
        continue;
      }
      this.clearDisconnectInfo(disconnectInfo);
    }

    if (keySet.size === 0) {
      this.disconnectListByRoomName.delete(roomName);
    }
  }

  private async findKickReconnectTarget(
    newClient: Client,
  ): Promise<Client | undefined> {
    const roomManager = this.ctx.get(() => RoomManager);
    const allRooms = roomManager.allRooms();

    for (const room of allRooms) {
      // 只在游戏进行中的房间查找
      if (room.duelStage === DuelStage.Begin) {
        continue;
      }

      // 查找符合条件的在线玩家
      for (const player of room.playingPlayers) {
        if (!(await this.canReconnect(player, room))) {
          continue;
        }
        // if (player.disconnected) {
        //   continue; // 跳过已断线的玩家
        // }

        // 名字必须匹配
        if (player.name !== newClient.name) {
          continue;
        }

        if (
          !this.ctx.get(() => ChallongeService).enabled &&
          player.roompass !== newClient.roompass
        ) {
          continue;
        }

        // 宽松模式或匹配条件
        const matchCondition =
          this.clientKeyProvider.getClientKey(player) ===
          this.clientKeyProvider.getClientKey(newClient);

        if (matchCondition) {
          return player;
        }
      }
    }

    return undefined;
  }

  private findDisconnectInfo(newClient: Client): DisconnectInfo | undefined {
    const key = this.clientKeyProvider.getClientKey(newClient);
    const disconnectInfo = this.disconnectList.get(key);
    if (!disconnectInfo) {
      return undefined;
    }

    const room = this.ctx
      .get(() => RoomManager)
      .findByName(disconnectInfo.roomName);
    if (!room || !this.getRoomPlayer(room, disconnectInfo.roomPos)) {
      this.clearDisconnectInfo(disconnectInfo);
      return undefined;
    }

    return disconnectInfo;
  }

  private getRoomPlayer(room: Room, roomPos: number): Client | undefined {
    return room.players[roomPos];
  }
}

export * from './can-reconnect-check';
export * from './refresh-field-service';
