import { Context } from '../app';
import { serviceEndpoint } from '../utility/service-endpoint';
import { createClient } from './generated/client';
import {
  cardsControllerLists,
  cardsControllerData,
  cardsControllerCheck,
  type CheckDeckRequestDto,
} from './generated';
import { AngelusClient } from './client';
import {
  DeckErrorType,
  OcgcoreCommonConstants,
  YGOProAngelusStart,
} from 'ygopro-msg-encode';

function payload<T>(envelope: {
  success: boolean;
  statusCode: number;
  data?: T;
}) {
  if (
    envelope?.success !== true ||
    envelope.statusCode !== 200 ||
    envelope.data == null
  )
    throw new Error('Invalid Angelus response envelope');
  return envelope.data;
}

function uint32(value: number) {
  return Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
}

export class AngelusService {
  private endpoint = this.ctx.config.getString('ANGELUS_ENDPOINT');
  private token = this.ctx.config.getString('ANGELUS_TOKEN');
  private options = {
    headers: this.token ? { 'x-server-token': this.token } : undefined,
    client: createClient({
      axios: this.ctx.http,
      baseURL: serviceEndpoint(this.endpoint, 'http').href.replace(/\/$/, ''),
      timeout: 10000,
    }),
    throwOnError: true as const,
  };
  constructor(private ctx: Context) {}

  async lists() {
    const { lists } = payload((await cardsControllerLists(this.options)).data);
    if (
      !Array.isArray(lists) ||
      !lists.every(
        (entry) =>
          typeof entry?.name === 'string' &&
          entry.name.length &&
          uint32(entry.hash),
      )
    )
      throw new Error('Invalid Angelus banlists');
    return lists;
  }

  async extraCards(codes: number[]) {
    const extra = new Set<number>();
    const ids = new Set(codes);
    if (!ids.size) return extra;
    const cards = payload(
      (
        await cardsControllerData({
          ...this.options,
          query: { id: [...ids].join(',') },
        })
      ).data,
    );
    if (!Array.isArray(cards)) throw new Error('Invalid Angelus card data');
    for (const card of cards) {
      if (!card || !ids.delete(card.code) || !uint32(card.type))
        throw new Error('Invalid Angelus card data');
      if (card.type & OcgcoreCommonConstants.TYPES_EXTRA_DECK)
        extra.add(card.code);
    }
    return extra;
  }

  async checkDeck(body: CheckDeckRequestDto) {
    const result = payload(
      (await cardsControllerCheck({ ...this.options, body })).data,
    );
    if (result.valid === true && result.error == null) return undefined;
    const error = result.error;
    if (
      result.valid !== false ||
      !error ||
      !Number.isInteger(error.reason) ||
      error.reason < DeckErrorType.LFLIST ||
      error.reason > DeckErrorType.NOTAVAIL ||
      !uint32(error.code)
    )
      throw new Error('Invalid Angelus deck check');
    return {
      toPayload: () => ((error.reason << 28) | (error.code & 0x0fffffff)) >>> 0,
    };
  }

  open(start: YGOProAngelusStart, onMessage?: AngelusClient['onMessage']) {
    return AngelusClient.open(
      new URL('duel', serviceEndpoint(this.endpoint, 'ws')),
      start,
      onMessage,
      this.token,
    );
  }
}
