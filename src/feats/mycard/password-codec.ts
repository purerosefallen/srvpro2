import { HostInfo } from 'ygopro-msg-encode';

export type MycardPasswordPayload = {
  buffer: Buffer;
  action: number;
  opt0: number;
  opt1: number;
  opt2: number;
  opt3: number;
};

export type MycardPasswordDecodeResult =
  | {
      ok: true;
      payload: MycardPasswordPayload;
    }
  | {
      ok: false;
      reason:
        | 'invalid_password_length'
        | 'invalid_password_payload'
        | 'invalid_password_unauthorized';
    };

export function decodeMycardPassword(
  pass: string,
  secrets: Array<number | string | null | undefined>,
): MycardPasswordDecodeResult {
  if (pass.length <= 8) {
    return { ok: false, reason: 'invalid_password_length' };
  }

  const encrypted = Buffer.from(pass.slice(0, 8), 'base64');
  if (encrypted.length !== 6) {
    return { ok: false, reason: 'invalid_password_payload' };
  }

  for (const rawSecret of secrets) {
    const secretNumber = Number(rawSecret);
    if (!Number.isFinite(secretNumber)) {
      continue;
    }
    const decrypted = decryptPayload(encrypted, secretNumber);
    if (!isChecksumValid(decrypted)) {
      continue;
    }
    return {
      ok: true,
      payload: parsePayload(decrypted),
    };
  }

  return { ok: false, reason: 'invalid_password_unauthorized' };
}

export function parsePayload(buffer: Buffer): MycardPasswordPayload {
  const firstByte = buffer.readUInt8(1);
  return {
    buffer,
    action: firstByte >> 4,
    opt0: firstByte & 0xf,
    opt1: buffer.readUInt8(2),
    opt2: buffer.readUInt16LE(3),
    opt3: buffer.readUInt8(5),
  };
}

export function decryptPayload(encrypted: Buffer, rawSecret: number) {
  const secret = (rawSecret % 65535) + 1;
  const decrypted = Buffer.allocUnsafe(6);
  for (const offset of [0, 2, 4]) {
    decrypted.writeUInt16LE(encrypted.readUInt16LE(offset) ^ secret, offset);
  }
  return decrypted;
}

export function isChecksumValid(buffer: Buffer) {
  let checksum = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    checksum += buffer.readUInt8(i);
  }
  return (checksum & 0xff) === 0;
}

export function resolveHostInfoFromMycardPayload(
  payload: MycardPasswordPayload,
  defaultHostinfo: HostInfo,
): Partial<HostInfo> {
  const rule = (payload.opt1 >> 5) & 0x7;
  const hostinfo: Partial<HostInfo> = {
    lflist: defaultHostinfo.lflist,
    time_limit: defaultHostinfo.time_limit,
    rule,
    mode: (payload.opt1 >> 3) & 0x3,
    duel_rule: payload.opt0 >> 1 || 5,
    no_check_deck: (payload.opt1 >> 1) & 1,
    no_shuffle_deck: payload.opt1 & 1,
    start_lp: payload.opt2,
    start_hand: payload.opt3 >> 4,
    draw_count: payload.opt3 & 0xf,
    no_watch: defaultHostinfo.no_watch,
    auto_death: payload.opt0 & 0x1 ? 40 : 0,
  };
  if (rule === 2) {
    hostinfo.lflist = -1;
  }
  return hostinfo;
}
