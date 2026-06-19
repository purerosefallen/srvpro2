import {
  YGOProMsgSelectYesNo,
  YGOProStocGameMsg,
} from 'ygopro-msg-encode';
import {
  CURRENT_REPLAY_RECORD_SCHEMA_VERSION,
  DuelRecordEntity,
  getCurrentReplayRecordCodecDriver,
  getReplayRecordCodecDriver,
} from '../src/feats/cloud-replay';

function encodeLegacyMessagesBase64(messages: YGOProMsgSelectYesNo[]) {
  return Buffer.concat(
    messages.map((msg) =>
      Buffer.from(
        new YGOProStocGameMsg()
          .fromPartial({
            msg,
          })
          .toFullPayload(),
      ),
    ),
  ).toString('base64');
}

function makeRecordEntity(
  schemaVersion: number,
  responses: string,
  messages = '',
) {
  const entity = new DuelRecordEntity();
  Object.assign(entity, {
    id: 1,
    startTime: new Date('2026-06-19T00:00:00Z'),
    endTime: new Date('2026-06-19T00:01:00Z'),
    name: 'room',
    roomIdentifier: 'r'.repeat(64),
    hostInfo: { mode: 0 } as any,
    duelCount: 1,
    winReason: null,
    messages,
    schemaVersion,
    responses,
    seed: Buffer.alloc(32).toString('base64'),
    players: [],
  });
  return entity;
}

describe('replay record codec drivers', () => {
  test('v0 decodes legacy messages and uint8 responses', () => {
    const driver = getReplayRecordCodecDriver(0);
    const message = new YGOProMsgSelectYesNo();
    const responses = Buffer.from([3, 1, 2, 3, 2, 4, 5]).toString('base64');

    expect(driver.decodeMessages(encodeLegacyMessagesBase64([message]))[0])
      .toBeInstanceOf(YGOProMsgSelectYesNo);
    expect(driver.decodeResponses(responses)).toEqual([
      Buffer.from([1, 2, 3]),
      Buffer.from([4, 5]),
    ]);
  });

  test('v1 round-trips messages and uint16le responses', () => {
    const driver = getReplayRecordCodecDriver(1);
    const message = new YGOProMsgSelectYesNo();
    const response = Buffer.from([1, 2, 3, 4]);

    expect(driver.decodeMessages(driver.encodeMessages([message]))[0])
      .toBeInstanceOf(YGOProMsgSelectYesNo);
    expect(driver.decodeResponses(driver.encodeResponses([response]))).toEqual([
      response,
    ]);
  });

  test('v1 stores a 260-byte response with a two-byte length', () => {
    const driver = getReplayRecordCodecDriver(1);
    const response = Buffer.alloc(260, 0xab);
    const encoded = driver.encodeResponses([response]);
    const payload = Buffer.from(encoded, 'base64');

    expect(payload.readUInt16LE(0)).toBe(260);
    expect(driver.decodeResponses(encoded)).toEqual([response]);
  });

  test('v1 rejects responses that exceed uint16 length', () => {
    const driver = getReplayRecordCodecDriver(1);

    expect(() => driver.encodeResponses([Buffer.alloc(0x10000)])).toThrow(
      /exceeds v1 limit/,
    );
  });

  test('drivers return empty arrays for empty strings and reject malformed data', () => {
    const driver = getReplayRecordCodecDriver(1);

    expect(driver.decodeMessages('')).toEqual([]);
    expect(driver.decodeResponses('')).toEqual([]);
    expect(() =>
      driver.decodeResponses(Buffer.from([4, 0, 1]).toString('base64')),
    ).toThrow(/Malformed v1/);
  });

  test('registry exposes v1 as current and rejects unknown versions', () => {
    expect(CURRENT_REPLAY_RECORD_SCHEMA_VERSION).toBe(1);
    expect(getCurrentReplayRecordCodecDriver().schemaVersion).toBe(1);
    expect(() => getReplayRecordCodecDriver(99)).toThrow(/Unsupported/);
  });
});

describe('DuelRecordEntity record codec integration', () => {
  test('schemaVersion 0 records decode legacy responses', () => {
    const responses = Buffer.from([3, 1, 2, 3]).toString('base64');
    const record = makeRecordEntity(0, responses).toDuelRecord();

    expect(record.responses).toEqual([Buffer.from([1, 2, 3])]);
  });

  test('schemaVersion 1 records decode long responses', () => {
    const response = Buffer.alloc(260, 0xcd);
    const responses = getReplayRecordCodecDriver(1).encodeResponses([
      response,
    ]);
    const record = makeRecordEntity(1, responses).toDuelRecord();

    expect(record.responses).toEqual([response]);
  });
});
