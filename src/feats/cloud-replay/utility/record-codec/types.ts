import { YGOProMsgBase } from 'ygopro-msg-encode';

export type ReplayRecordSchemaVersion = 0 | 1;

export interface ReplayRecordCodecDriver {
  schemaVersion: ReplayRecordSchemaVersion;
  encodeMessages(messages: YGOProMsgBase[]): string;
  decodeMessages(messagesBase64: string): YGOProMsgBase[];
  encodeResponses(responses: Buffer[]): string;
  decodeResponses(responsesBase64: string): Buffer[];
}
