import {
  YGOProMsgBase,
  YGOProStoc,
  YGOProStocGameMsg,
} from 'ygopro-msg-encode';
import { ReplayRecordCodecDriver } from './types';

const RESPONSE_LENGTH_BYTES = 1;
const MAX_RESPONSE_LENGTH = 0xff;

export function encodeMessagesV0(messages: YGOProMsgBase[]) {
  if (!messages.length) {
    return '';
  }
  const payloads = messages.map((msg) =>
    Buffer.from(
      new YGOProStocGameMsg()
        .fromPartial({
          msg,
        })
        .toFullPayload(),
    ),
  );
  return Buffer.concat(payloads).toString('base64');
}

export function decodeMessagesV0(messagesBase64: string) {
  if (!messagesBase64) {
    return [];
  }
  const payload = Buffer.from(messagesBase64, 'base64');
  if (!payload.length) {
    return [];
  }
  const stocPackets = YGOProStoc.getInstancesFromPayload(payload);
  return stocPackets
    .filter(
      (packet): packet is YGOProStocGameMsg =>
        packet instanceof YGOProStocGameMsg && !!packet.msg,
    )
    .map((packet) => packet.msg!);
}

export function encodeResponsesV0(responses: Buffer[]) {
  if (!responses.length) {
    return '';
  }
  const payloads = responses.flatMap((response) => {
    if (response.length > MAX_RESPONSE_LENGTH) {
      throw new Error(
        `Replay response length ${response.length} exceeds v0 limit ${MAX_RESPONSE_LENGTH}`,
      );
    }
    const lengthBuffer = Buffer.alloc(RESPONSE_LENGTH_BYTES, 0);
    lengthBuffer.writeUInt8(response.length, 0);
    return [lengthBuffer, response];
  });
  return Buffer.concat(payloads).toString('base64');
}

export function decodeResponsesV0(responsesBase64: string) {
  if (!responsesBase64) {
    return [];
  }
  const payload = Buffer.from(responsesBase64, 'base64');
  if (!payload.length) {
    return [];
  }
  const responses: Buffer[] = [];
  let offset = 0;
  while (offset < payload.length) {
    if (offset + RESPONSE_LENGTH_BYTES > payload.length) {
      throw new Error('Malformed v0 replay responses payload');
    }
    const length = payload.readUInt8(offset);
    offset += RESPONSE_LENGTH_BYTES;
    if (offset + length > payload.length) {
      throw new Error('Malformed v0 replay responses payload');
    }
    responses.push(payload.subarray(offset, offset + length));
    offset += length;
  }
  return responses;
}

export const replayRecordCodecDriverV0: ReplayRecordCodecDriver = {
  schemaVersion: 0,
  encodeMessages: encodeMessagesV0,
  decodeMessages: decodeMessagesV0,
  encodeResponses: encodeResponsesV0,
  decodeResponses: decodeResponsesV0,
};
