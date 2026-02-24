import { HostInfo } from 'ygopro-msg-encode';
import YGOProDeck from 'ygopro-deck-encode';
import {
  Column,
  Entity,
  Generated,
  Index,
  OneToMany,
  PrimaryColumn,
} from 'typeorm';
import { BaseTimeEntity, BigintTransformer } from '../../utility';
import { DuelRecord } from '../../room';
import { DuelRecordPlayer } from './duel-record-player.entity';
import {
  decodeDeckBase64,
  decodeMessagesBase64,
  decodeResponsesBase64,
  decodeSeedBase64,
} from './utility';

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

  @Index()
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
  duelCount!: number; // room.duelRecords.length

  @Index()
  @Column('smallint')
  winReason!: number; // OnRoomWin.winMsg.type

  @Column({
    type: 'text',
  })
  messages!: string; // duelRecord.messages 全部 map 成 YGOProStocGameMsg 然后全部 toFullPayload 拼接在一起然后 base64

  @Column({
    type: 'text',
  })
  responses!: string; // duelRecord.responses 按 [uint8 len][payload]... 拼接再 base64

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

  toDuelRecord() {
    const seatCount = this.resolveSeatCount();
    const players = Array.from({ length: seatCount }, () => ({
      name: '',
      deck: new YGOProDeck(),
    }));
    const sortedPlayers = [...(this.players || [])].sort(
      (a, b) => a.pos - b.pos,
    );

    for (const player of sortedPlayers) {
      const deckBuffer = player.ingameDeckBuffer || player.currentDeckBuffer;
      const mainc = player.ingameDeckMainc ?? player.currentDeckMainc ?? 0;
      if (player.pos < 0 || player.pos >= seatCount) {
        continue;
      }
      players[player.pos] = {
        name: player.name,
        deck: decodeDeckBase64(deckBuffer, mainc),
      };
    }

    const duelRecord = new DuelRecord(
      decodeSeedBase64(this.seed),
      players,
      this.resolveSwappedByIsFirst(),
    );
    duelRecord.startTime = this.startTime;
    duelRecord.endTime = this.endTime;
    duelRecord.winPosition = this.resolveWinPosition();
    duelRecord.winReason = this.winReason;
    duelRecord.messages = decodeMessagesBase64(this.messages).map(
      (packet) => packet.msg!,
    );
    duelRecord.responses = decodeResponsesBase64(this.responses);
    return duelRecord;
  }

  private resolveWinPosition() {
    const winnerPlayer = (this.players || []).find((player) => player.winner);
    if (!winnerPlayer) {
      return undefined;
    }
    return this.resolveDuelPosBySeat(winnerPlayer.pos);
  }

  private resolveSwappedByIsFirst() {
    const pos0Player = (this.players || []).find((player) => player.pos === 0);
    if (!pos0Player) {
      return false;
    }
    return !pos0Player.isFirst;
  }

  private resolveDuelPosBySeat(pos: number) {
    const teamOffsetBit = this.isTagMode() ? 1 : 0;
    return (pos & (0x1 << teamOffsetBit)) >>> teamOffsetBit;
  }

  private isTagMode() {
    return (this.hostInfo.mode & 0x2) !== 0;
  }

  private resolveSeatCount() {
    return this.isTagMode() ? 4 : 2;
  }
}
