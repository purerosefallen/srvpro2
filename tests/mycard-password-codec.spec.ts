import {
  decodeMycardPassword,
  resolveHostInfoFromMycardPayload,
} from '../src/feats/mycard/password-codec';
import { DefaultHostinfo } from '../src/room/default-hostinfo';

function makePayload(
  action: number,
  options: Partial<{
    opt0: number;
    opt1: number;
    opt2: number;
    opt3: number;
  }> = {},
) {
  const buffer = Buffer.alloc(6);
  buffer.writeUInt8(0, 0);
  buffer.writeUInt8((action << 4) | (options.opt0 ?? 0), 1);
  buffer.writeUInt8(options.opt1 ?? 0, 2);
  buffer.writeUInt16LE(options.opt2 ?? 8000, 3);
  buffer.writeUInt8(options.opt3 ?? 0x51, 5);
  const checksum = buffer.reduce((sum, value, index) => {
    return index === 0 ? sum : sum + value;
  }, 0);
  buffer.writeUInt8(-checksum & 0xff, 0);
  return buffer;
}

function encodePass(payload: Buffer, rawSecret: number, suffix = 'ROOM') {
  const secret = (rawSecret % 65535) + 1;
  const encrypted = Buffer.allocUnsafe(6);
  for (const offset of [0, 2, 4]) {
    encrypted.writeUInt16LE(payload.readUInt16LE(offset) ^ secret, offset);
  }
  return encrypted.toString('base64') + suffix;
}

describe('mycard password codec', () => {
  test('rejects short and malformed payloads', () => {
    expect(decodeMycardPassword('short', [123])).toEqual({
      ok: false,
      reason: 'invalid_password_length',
    });
    expect(decodeMycardPassword('!!!!!!!!ROOM', [123])).toEqual({
      ok: false,
      reason: 'invalid_password_payload',
    });
  });

  test('decrypts current or previous u16Secret and parses action/options', () => {
    const payload = makePayload(4, {
      opt0: 3,
      opt1: 0b10101011,
      opt2: 12000,
      opt3: 0x62,
    });
    const pass = encodePass(payload, 456, 'MATCH');

    const result = decodeMycardPassword(pass, [123, 456]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.action).toBe(4);
    expect(result.payload.opt0).toBe(3);
    expect(result.payload.opt1).toBe(0b10101011);
    expect(result.payload.opt2).toBe(12000);
    expect(result.payload.opt3).toBe(0x62);
  });

  test('maps payload options into hostinfo', () => {
    const payload = makePayload(1, {
      opt0: 0b0011,
      opt1: 0b01011011,
      opt2: 6000,
      opt3: 0x74,
    });
    const pass = encodePass(payload, 777);
    const decoded = decodeMycardPassword(pass, [777]);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;

    const hostinfo = resolveHostInfoFromMycardPayload(
      decoded.payload,
      DefaultHostinfo,
    );
    expect(hostinfo.rule).toBe(2);
    expect(hostinfo.lflist).toBe(-1);
    expect(hostinfo.mode).toBe(3);
    expect(hostinfo.duel_rule).toBe(1);
    expect(hostinfo.no_check_deck).toBe(1);
    expect(hostinfo.no_shuffle_deck).toBe(1);
    expect(hostinfo.start_lp).toBe(6000);
    expect(hostinfo.start_hand).toBe(7);
    expect(hostinfo.draw_count).toBe(4);
    expect(hostinfo.auto_death).toBe(40);
  });
});
