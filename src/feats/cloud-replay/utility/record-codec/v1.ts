import { Buffer } from 'buffer';
import { ReplayRecordCodecDriver } from './types';
import { decodeMessagesV0, encodeMessagesV0 } from './v0';

const RESPONSE_LENGTH_BYTES = 2;
const MAX_RESPONSE_LENGTH = 0xffff;

export function encodeResponsesV1(responses: Buffer[]) {
  if (!responses.length) {
    return '';
  }
  const payloads = responses.flatMap((response) => {
    if (response.length > MAX_RESPONSE_LENGTH) {
      throw new Error(
        `Replay response length ${response.length} exceeds v1 limit ${MAX_RESPONSE_LENGTH}`,
      );
    }
    const lengthBuffer = Buffer.alloc(RESPONSE_LENGTH_BYTES, 0);
    lengthBuffer.writeUInt16LE(response.length, 0);
    return [lengthBuffer, response];
  });
  return Buffer.concat(payloads).toString('base64');
}

export function decodeResponsesV1(responsesBase64: string) {
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
      throw new Error('Malformed v1 replay responses payload');
    }
    const length = payload.readUInt16LE(offset);
    offset += RESPONSE_LENGTH_BYTES;
    if (offset + length > payload.length) {
      throw new Error('Malformed v1 replay responses payload');
    }
    responses.push(payload.subarray(offset, offset + length));
    offset += length;
  }
  return responses;
}

export const replayRecordCodecDriverV1: ReplayRecordCodecDriver = {
  schemaVersion: 1,
  encodeMessages: encodeMessagesV0,
  decodeMessages: decodeMessagesV0,
  encodeResponses: encodeResponsesV1,
  decodeResponses: decodeResponsesV1,
};
