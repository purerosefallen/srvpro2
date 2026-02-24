import {
  YGOProMsgBase,
  YGOProMsgHint,
  YGOProMsgNewPhase,
  YGOProMsgNewTurn,
  YGOProMsgResponseBase,
  YGOProMsgRetry,
} from 'ygopro-msg-encode';
import { Room } from '../room';
import { isUpdateMessage } from './is-update-message';

const isVerifySkippingMessage = (message: YGOProMsgBase) => 
  message instanceof YGOProMsgHint || isUpdateMessage(message);

export const sliceOcgcore = async (room: Room, i: number) => {
  if (
    !room.lastDuelRecord ||
    !room.ocgcore ||
    !(await room.createOcgcore(room.lastDuelRecord))
  ) {
    throw new Error('Failed to create ocgcore');
  }
  room.resetDuelState();
  const useResponses = room.lastDuelRecord.responses.slice(0, i);
  let messagePointer = 1; // 1st message is MSG_START and we skip it
  while (true) {
    for await (const { message, status, raw } of room.ocgcore!.advance()) {
      if (!message) {
        if (status) {
          throw new Error(
            `Got empty message but non-advance status: ${status}`,
          );
        }
        continue;
      }

      if (message instanceof YGOProMsgRetry) {
        // no retry here
        throw new Error('Unexpected retry message');
      }

      if (isVerifySkippingMessage(message)) {
        continue; // skip update messages
      }

      let expectedMessage = room.lastDuelRecord.messages[messagePointer++];
      while (expectedMessage && isVerifySkippingMessage(expectedMessage)) {
        expectedMessage = room.lastDuelRecord.messages[messagePointer++];
      }
      if (!expectedMessage) {
        throw new Error(
          `No more expected messages but got ${message.constructor.name} with payload ${Buffer.from(raw).toString('hex')} body ${JSON.stringify(message)}`,
        );
      }
      if (!Buffer.from(raw).equals(Buffer.from(expectedMessage.toPayload()))) {
        throw new Error(
          `Message mismatch at position ${messagePointer - 1}: expected ${expectedMessage.constructor.name} with payload ${Buffer.from(expectedMessage.toPayload()).toString('hex')} body ${JSON.stringify(expectedMessage)}, got ${message.constructor.name} with payload ${Buffer.from(raw).toString('hex')} body ${JSON.stringify(message)}`,
        );
      }
      if (message instanceof YGOProMsgNewTurn) {
        room.setNewTurn(message.player);
      } else if (message instanceof YGOProMsgNewPhase) {
        room.setNewPhase(message.phase);
      } else if (message instanceof YGOProMsgResponseBase) {
        room.setLastResponseRequestMsg(
          expectedMessage as YGOProMsgResponseBase, // use exact same reference as the one in the record to avoid issues in response matching
        );
      }
    }
    const response = useResponses.shift();
    if (!response) {
      break;
    }
    await room.ocgcore!.setResponse(response);
  }
  room.lastDuelRecord.responses.splice(i);
  room.lastDuelRecord.messages.splice(messagePointer);
};
