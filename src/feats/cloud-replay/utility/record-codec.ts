import YGOProDeck from 'ygopro-deck-encode';
import { YGOProMsgBase, YGOProStocGameMsg } from 'ygopro-msg-encode';
import { Client } from '../../../client';
import { Room } from '../../../room';

export function resolvePlayerScore(room: Room, client: Client) {
  const duelPos = room.getIngameDuelPos(client);
  return room.score[duelPos] || 0;
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
  return Buffer.concat(responses).toString('base64');
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

function resolveCurrentDeck(room: Room, client: Client) {
  if (client.deck) {
    return client.deck;
  }
  const ingamePos = room.getIngamePos(client);
  const duelRecordPlayer = room.lastDuelRecord?.players[ingamePos];
  return duelRecordPlayer?.deck;
}

export function resolveCurrentDeckMainc(room: Room, client: Client) {
  return resolveCurrentDeck(room, client)?.main?.length || 0;
}

export function encodeCurrentDeckBase64(room: Room, client: Client) {
  return encodeDeckBase64(resolveCurrentDeck(room, client));
}
