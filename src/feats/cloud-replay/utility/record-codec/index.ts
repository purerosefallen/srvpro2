import { YGOProMsgBase } from 'ygopro-msg-encode';
import {
  CURRENT_REPLAY_RECORD_SCHEMA_VERSION,
  getReplayRecordCodecDriver,
} from './registry';

export * from './registry';
export * from './types';
export * from './v0';
export * from './v1';

export function encodeMessagesBase64(
  messages: YGOProMsgBase[],
  schemaVersion = CURRENT_REPLAY_RECORD_SCHEMA_VERSION,
) {
  return getReplayRecordCodecDriver(schemaVersion).encodeMessages(messages);
}

export function decodeMessagesBase64(
  messagesBase64: string,
  schemaVersion = 0,
) {
  return getReplayRecordCodecDriver(schemaVersion).decodeMessages(
    messagesBase64,
  );
}

export function encodeResponsesBase64(
  responses: Buffer[],
  schemaVersion = CURRENT_REPLAY_RECORD_SCHEMA_VERSION,
) {
  return getReplayRecordCodecDriver(schemaVersion).encodeResponses(responses);
}

export function decodeResponsesBase64(
  responsesBase64: string,
  schemaVersion = 0,
) {
  return getReplayRecordCodecDriver(schemaVersion).decodeResponses(
    responsesBase64,
  );
}
