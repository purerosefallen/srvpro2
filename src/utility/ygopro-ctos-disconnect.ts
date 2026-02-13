import { YGOProCtosLeaveGame } from 'ygopro-msg-encode';

export class YGOProCtosDisconnect extends YGOProCtosLeaveGame {
  bySystem = false;
}
