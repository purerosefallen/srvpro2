import { HostInfo } from 'ygopro-msg-encode';
import {
  Column,
  Entity,
  Generated,
  Index,
  OneToMany,
  PrimaryColumn,
} from 'typeorm';
import { BaseTimeEntity } from './base-time.entity';
import { BigintTransformer } from './bigint-transformer';
import { DuelRecordPlayer } from './duel-record-player.entity';

@Entity('duel_record')
export class DuelRecordEntity extends BaseTimeEntity {
  @PrimaryColumn({
    type: 'bigint',
    unsigned: true,
    transformer: new BigintTransformer(),
  })
  @Generated('increment')
  id!: number;

  @Index()
  @Column('timestamp')
  startTime!: Date; // duelRecord.time

  @Column('timestamp')
  endTime!: Date; // 入库时间

  @Index()
  @Column({
    type: 'varchar',
    length: 20,
  })
  name!: string; // room.name

  @Index()
  @Column({
    type: 'char',
    length: 64,
  })
  roomIdentifier!: string; // declare module 依赖合并声明 room.identifier，然后监听事件 OnRoomCreate 用 crypto-random-string 大小写字母数字 64 字符赋值

  @Column({
    type: 'jsonb',
  })
  hostInfo!: HostInfo; // room.hostInfo

  @Index()
  @Column('smallint', {
    unsigned: true,
  })
  duelCount!: number; // room.duelCount.length

  @Column('smallint')
  winReason!: number; // OnRoomWin.winMsg.type

  @Column({
    type: 'text',
  })
  messages!: string; // duelRecord.messages 全部 map 成 YGOProStocGameMsg 然后全部 toFullPayload 拼接在一起然后 base64

  @Column({
    type: 'text',
  })
  responses!: string; // duelRecord.responses 直接拼接 base64

  // 32 bytes binary seed => 44 chars base64.
  @Column({
    type: 'varchar',
    length: 44,
  })
  seed!: string; // duelRecord.seed 每个数字当作 base64 直接拼接

  @OneToMany(() => DuelRecordPlayer, (player) => player.duelRecord, {
    cascade: true,
  })
  players!: DuelRecordPlayer[];
}
