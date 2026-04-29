import YGOProDeck from 'ygopro-deck-encode';
import {
  YGOProMsgBase,
  YGOProStoc,
  YGOProStocGameMsg,
} from 'ygopro-msg-encode';
import { Client } from '../../../client';
import { Room } from '../../../room';

const RESPONSE_LENGTH_BYTES = 1;

export function resolvePlayerScore(room: Room, client: Client) {
  const duelPos = room.getDuelPos(client);
  return room.score[duelPos] || 0;
}

export function resolveIsFirstPlayer(
  room: Room,
  client: Client,
  wasSwapped: boolean,
) {
  const firstgoDuelPos = wasSwapped ? 1 : 0;
  return room.getDuelPos(client) === firstgoDuelPos;
}

export function encodeMessagesBase64(messages: YGOProMsgBase[]) {
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

export function encodeResponsesBase64(responses: Buffer[]) {
  if (!responses.length) {
    return '';
  }
  const payloads = responses.flatMap((response) => {
    const length = response.length & 0xff;
    const lengthBuffer = Buffer.alloc(RESPONSE_LENGTH_BYTES, 0);
    lengthBuffer.writeUInt8(length, 0);
    return [lengthBuffer, response];
  });
  return Buffer.concat(payloads).toString('base64');
}

export function encodeSeedBase64(seed: number[]) {
  const raw = Buffer.alloc(32, 0);
  for (let i = 0; i < 8 && i < seed.length; i += 1) {
    raw.writeUInt32LE(seed[i] >>> 0, i * 4);
  }
  return raw.toString('base64');
}

export function encodeDeckBase64(deck: YGOProDeck | undefined) {
  if (!deck || typeof deck.toUpdateDeckPayload !== 'function') {
    return '';
  }
  return Buffer.from(deck.toUpdateDeckPayload()).toString('base64');
}

export function resolveStartDeckMainc(client: Client) {
  return client.startDeck?.main?.length || 0;
}

function resolveRecordDeck(room: Room, client: Client) {
  const duelRecordPlayer = room.lastDuelRecord?.players[client.pos];
  return duelRecordPlayer?.deck;
}

function resolveCurrentDeck(room: Room, client: Client) {
  if (client.deck) {
    return client.deck;
  }
  return resolveRecordDeck(room, client);
}

export function resolveCurrentDeckMainc(room: Room, client: Client) {
  return resolveCurrentDeck(room, client)?.main?.length || 0;
}

export function encodeCurrentDeckBase64(room: Room, client: Client) {
  return encodeDeckBase64(resolveCurrentDeck(room, client));
}

export function encodeIngameDeckBase64(room: Room, client: Client) {
  return encodeDeckBase64(resolveRecordDeck(room, client));
}

export function resolveIngameDeckMainc(room: Room, client: Client) {
  return resolveRecordDeck(room, client)?.main?.length || 0;
}

export function decodeMessagesBase64(messagesBase64: string) {
  if (!messagesBase64) {
    return [];
  }
  const payload = Buffer.from(messagesBase64, 'base64');
  if (!payload.length) {
    return [];
  }
  const stocPackets = YGOProStoc.getInstancesFromPayload(payload);
  return stocPackets.filter(
    (packet): packet is YGOProStocGameMsg =>
      packet instanceof YGOProStocGameMsg && !!packet.msg,
  );
}

export function decodeResponsesBase64(responsesBase64: string) {
  if (!responsesBase64) {
    return [];
  }
  const payload = Buffer.from(responsesBase64, 'base64');
  if (!payload.length) {
    return [];
  }
  return decodeLengthPrefixedResponses(payload) || [];
}

function decodeLengthPrefixedResponses(payload: Buffer) {
  const responses: Buffer[] = [];
  let offset = 0;
  while (offset < payload.length) {
    if (offset + RESPONSE_LENGTH_BYTES > payload.length) {
      return undefined;
    }
    const length = payload.readUInt8(offset);
    offset += RESPONSE_LENGTH_BYTES;
    if (offset + length > payload.length) {
      return undefined;
    }
    responses.push(payload.subarray(offset, offset + length));
    offset += length;
  }
  return responses;
}

export function decodeSeedBase64(seedBase64: string) {
  const decoded = seedBase64
    ? Buffer.from(seedBase64, 'base64')
    : Buffer.alloc(0);
  const raw = Buffer.alloc(32, 0);
  decoded.copy(raw, 0, 0, Math.min(decoded.length, raw.length));
  const seed: number[] = [];
  for (let i = 0; i < 8; i += 1) {
    seed.push(raw.readUInt32LE(i * 4) >>> 0);
  }
  return seed;
}

export function decodeDeckBase64(deckBase64: string, mainc: number) {
  if (!deckBase64) {
    return new YGOProDeck();
  }
  const payload = Buffer.from(deckBase64, 'base64');
  if (!payload.length) {
    return new YGOProDeck();
  }
  return YGOProDeck.fromUpdateDeckPayload(payload, (_code, index) => {
    return index >= mainc;
  });
}
