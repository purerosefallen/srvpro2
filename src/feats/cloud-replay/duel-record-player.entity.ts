import {
  Column,
  Entity,
  Generated,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { BaseTimeEntity } from './base-time.entity';
import { BigintTransformer } from './bigint-transformer';
import { DuelRecordEntity } from './duel-record.entity';

@Entity('duel_record_player')
export class DuelRecordPlayer extends BaseTimeEntity {
  @PrimaryColumn({
    type: 'bigint',
    unsigned: true,
    transformer: new BigintTransformer(),
  })
  @Generated('increment')
  id!: number;

  @Column({
    type: 'varchar',
    length: 20,
  })
  name!: string; // client.name

  @Column({
    type: 'smallint',
  })
  pos!: number; // client.pos

  @Index()
  @Column({
    type: 'varchar',
    length: 20,
  })
  realName!: string; // client.name_vpass

  @Column({
    type: 'varchar',
    length: 64,
  })
  ip!: string; // client.ip

  @Index()
  @Column({
    type: 'varchar',
    length: 60, // 21 + max IPv6 string length(39)
  })
  clientKey!: string; // getClientKey(client)

  @Column('bool')
  isFirst!: boolean; // 如果 room.getIngameDuelPos(client) === 0 就是 true

  @Index()
  @Column('smallint')
  score!: number; // 就是 room.score 自己槽位

  @Column('text', {})
  startDeckBuffer!: string; // client.startDeck.toPayload() base64

  @Column('smallint')
  startDeckMainc!: number; // client.startDeck.main.length

  @Column('text', {})
  currentDeckBuffer!: string; // client.currentDeck.toPayload() base64

  @Column('smallint')
  currentDeckMainc!: number; // client.currentDeck.main.length

  @Column('bool')
  winner!: boolean;

  @Column({
    type: 'bigint',
    unsigned: true,
    transformer: new BigintTransformer(),
  })
  duelRecordId!: number;

  @ManyToOne(() => DuelRecordEntity, (duelRecord) => duelRecord.players, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({
    name: 'duelRecordId',
  })
  duelRecord!: DuelRecordEntity;
}
