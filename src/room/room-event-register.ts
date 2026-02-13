import 'reflect-metadata';
import { Context } from '../app';
import { getSpecificFields } from '../utility/metadata';
import { Room } from './room';
import { Client } from '../client/client';
import { YGOProCtosBase } from 'ygopro-msg-encode';
import { RoomManager } from './room-manager';

export class RoomEventRegister {
  private logger = this.ctx.createLogger('RoomEventRegister');

  constructor(private ctx: Context) {
    this.registerRoomEvents();
  }

  private registerRoomEvents() {
    const roomMethods = getSpecificFields('roomMethod', Room);
    for (const { key: method } of roomMethods) {
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

      // 注册 middleware
      this.ctx.middleware(ctosParamType, async (msg, client, next) => {
        // 如果 client 没有关联的 room，直接跳过
        if (!client.roomName) {
          return next();
        }

        // 通过 roomName 查找 room
        const roomManager = this.ctx.get(() => RoomManager);
        const room = roomManager.findByName(client.roomName);
        if (!room) {
          return next();
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
