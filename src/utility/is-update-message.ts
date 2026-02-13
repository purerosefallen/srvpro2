import {
  YGOProMsgBase,
  YGOProMsgUpdateCard,
  YGOProMsgUpdateData,
} from 'ygopro-msg-encode';

export const isUpdateMessage = (message: YGOProMsgBase) =>
  message instanceof YGOProMsgUpdateData ||
  message instanceof YGOProMsgUpdateCard;

