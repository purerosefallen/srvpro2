import 'reflect-metadata';
import { Context } from '../app';
import { getSpecificFields } from '../utility/metadata';
import { RoomMethodOptions } from '../utility/decorators';
import { Room } from './room';
import { Client } from '../client';
import { YGOProCtosBase } from 'ygopro-msg-encode';
import { RoomManager } from './room-manager';
import { makeArray } from 'nfkit';

export class RoomEventRegister {
  private logger = this.ctx.createLogger('RoomEventRegister');

  constructor(private ctx: Context) {}

  async init() {
    this.registerRoomEvents();
  }

  private registerRoomEvents() {
    const roomMethods = getSpecificFields('roomMethod', Room);
    for (const { key: method, metadata } of roomMethods) {
      // 获取方法的参数类型
      const paramTypes: any[] =
        Reflect.getMetadata('design:paramtypes', Room.prototype, method) || [];

      // 如果找不到参数类型，输出警告
      if (!paramTypes || paramTypes.length === 0) {
        this.logger.warn(
          `Method ${method} has no parameter types metadata. Make sure tsconfig has "emitDecoratorMetadata": true`,
        );
        continue;
      }

      // 查找 Client 类型的参数和 YGOProCtosBase 派生类的参数
      let clientParamIndex = -1;
      let ctosParamIndex = -1;
      let ctosParamType: any = null;

      for (let i = 0; i < paramTypes.length; i++) {
        const paramType = paramTypes[i];
        if (paramType === Client) {
          clientParamIndex = i;
        } else if (paramType && paramType.prototype instanceof YGOProCtosBase) {
          ctosParamIndex = i;
          ctosParamType = paramType;
        }
      }

      // 如果没有 YGOProCtosBase 派生类参数，跳过
      if (ctosParamIndex === -1 || !ctosParamType) {
        continue;
      }
      if (clientParamIndex === -1) {
        const fallbackClientIndex = paramTypes.findIndex(
          (_paramType, index) => index !== ctosParamIndex,
        );
        if (fallbackClientIndex === -1) {
          this.logger.warn(
            `Method ${method} has no resolvable client parameter index, skipping`,
          );
          continue;
        }
        clientParamIndex = fallbackClientIndex;
        // this.logger.warn(
        //   `Method ${method} has no explicit Client param metadata, fallback to arg[${clientParamIndex}] for client`,
        // );
      }

      // 获取方法选项
      const options: RoomMethodOptions = metadata;

      // 注册 middleware
      this.ctx.middleware(ctosParamType, async (msg, client, next) => {
        // 如果 client 没有关联的 room，直接跳过
        if (!client.roomName) {
          return next();
        }

        // 通过 roomName 查找 room
        const roomManager = this.ctx.get(() => RoomManager);
        const room = roomManager.findByName(client.roomName);
        if (!room || room.finalizing) {
          return next();
        }

        // 检查 DuelStage 限制
        if (options?.allowInDuelStages) {
          const allowedStages = makeArray(options.allowInDuelStages);
          if (!allowedStages.includes(room.duelStage)) {
            return next();
          }
        }

        // 构造参数数组
        const args = new Array(paramTypes.length);
        for (let i = 0; i < paramTypes.length; i++) {
          if (i === clientParamIndex) {
            args[i] = client;
          } else if (i === ctosParamIndex) {
            args[i] = msg;
          }
        }

        // 调用 Room 实例的方法
        await (room as any)[method](...args);

        return next();
      });
    }
  }
}
