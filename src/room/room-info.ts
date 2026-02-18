import { HostInfo } from 'ygopro-msg-encode';
import { DuelStage } from './duel-stage';

export interface RoomCurrentFieldInfoItem {
  lp: number;
  cardCount: number;
}

export type RoomCurrentFieldInfo = RoomCurrentFieldInfoItem[] | undefined;

export interface RoomInfoPlayer {
  name: string;
  pos: number;
  ip: string;
  deck: string | undefined;
  score: number | undefined;
  lp: number | undefined;
  cardCount: number | undefined;
}

export interface RoomInfoDuelPlayer {
  deck: string;
  isFirst: boolean;
}

export interface RoomInfoDuel {
  startTime: Date;
  endTime?: Date;
  winPosition?: number;
  players: RoomInfoDuelPlayer[];
}

export interface RoomInfo {
  watcherCount: number;
  players: RoomInfoPlayer[];
  duels: RoomInfoDuel[];
  identifier: string;
  name: string;
  hostinfo: HostInfo;
  duelStage: DuelStage;
  turnCount: number;
  createTime: Date;
}
