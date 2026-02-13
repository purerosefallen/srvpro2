import { YGOProMsgBase } from 'ygopro-msg-encode';

export const getMessageIdentifier = (message: YGOProMsgBase) =>
  ((message.constructor as any).identifier as number) ?? 0;
