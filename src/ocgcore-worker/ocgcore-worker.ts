import {
  OcgcoreDuel,
  OcgcoreMessageType,
  OcgcoreWrapper,
  createOcgcoreWrapper,
  DirScriptReaderEx,
  DirCardReader,
  _OcgcoreConstants,
} from 'koishipro-core.js';
import type {
  OcgcoreQueryCardParams,
  OcgcoreQueryFieldCardParams,
  OcgcoreQueryFieldCountParams,
  OcgcoreProcessResult,
  OcgcoreCardQueryResult,
  OcgcoreFieldCardQueryResult,
  OcgcoreFieldInfoResult,
} from 'koishipro-core.js';
import {
  DefineWorker,
  WorkerCallback,
  WorkerFinalize,
  WorkerInit,
  WorkerMethod,
  TransportType,
  TransportEncoder,
} from 'yuzuthread';
import { OcgcoreWorkerOptions } from './ocgcore-worker-options';
import { Subject } from 'rxjs';
import { calculateDuelOptions } from '../utility/calculate-duel-options';
import initSqlJs from 'sql.js';
import { YGOProMessages, CardQuery } from 'ygopro-msg-encode';

const { OcgcoreScriptConstants } = _OcgcoreConstants;

// Serializable types for transport
interface SerializableProcessResult {
  length: number;
  raw: Uint8Array;
  status: number;
  messagePayload?: Uint8Array;
}

interface SerializableCardQueryResult {
  length: number;
  raw: Uint8Array;
  cardPayload: Uint8Array | null;
}

interface SerializableFieldCardQueryResult {
  length: number;
  raw: Uint8Array;
  cardsPayload: Uint8Array[];
}

interface SerializableFieldInfoResult {
  length: number;
  raw: Uint8Array;
  fieldPayload: Uint8Array;
}

@DefineWorker()
export class OcgcoreWorker {
  private ocgcore: OcgcoreWrapper;
  private duel: OcgcoreDuel;

  constructor(private options: OcgcoreWorkerOptions) {}

  message$ = new Subject<{
    message: string;
    type: OcgcoreMessageType;
  }>();
  registry$ = new Subject<Record<string, string>>();

  // this only exists in the worker thread
  @WorkerCallback()
  async handleMessage(message: string, type: OcgcoreMessageType) {
    this.message$.next({ message, type });
  }

  @WorkerCallback()
  private async masterFinalize(registryData: Record<string, string>) {
    this.registry$.next(registryData);
    this.registry$.complete();
    this.message$.complete();
  }

  @WorkerInit()
  async init() {
    // Create ocgcore wrapper
    this.ocgcore = await createOcgcoreWrapper();
    this.ocgcore.setMessageHandler((_, message, type) =>
      this.handleMessage(message, type),
    );

    // Load script reader and card reader
    const sqlJs = await initSqlJs();
    const scriptReader = await DirScriptReaderEx(...this.options.ygoproPaths);
    const cardReader = await DirCardReader(sqlJs, ...this.options.ygoproPaths);
    this.ocgcore.setScriptReader(scriptReader);
    this.ocgcore.setCardReader(cardReader);

    // Create duel with seed
    this.duel = this.ocgcore.createDuelV2(this.options.seed);

    // Load registry if provided
    if (this.options.registry) {
      this.duel.loadRegistry(this.options.registry);
    }

    // Set player info for both players
    const { hostinfo } = this.options;
    for (let i = 0; i < 2; i++) {
      this.duel.setPlayerInfo({
        player: i,
        lp: hostinfo.start_lp,
        startHand: hostinfo.start_hand,
        drawCount: hostinfo.draw_count,
      });
    }

    // Load extra scripts
    for (const path of this.options.extraScriptPaths) {
      this.duel.preloadScript(path);
    }

    // Calculate duel options
    const opt = calculateDuelOptions(hostinfo, this.options.isTag ?? false);

    // Helper function to load a deck
    const loadDeck = (
      deck: (typeof this.options.decks)[0],
      owner: number,
      player: number,
    ) => {
      for (const card of [...deck.main].reverse()) {
        this.duel.newCard({
          code: card,
          owner,
          player,
          location: OcgcoreScriptConstants.LOCATION_DECK,
          sequence: 0,
          position: OcgcoreScriptConstants.POS_FACEDOWN_DEFENSE,
        });
      }
      for (const card of [...deck.extra].reverse()) {
        this.duel.newCard({
          code: card,
          owner,
          player,
          location: OcgcoreScriptConstants.LOCATION_EXTRA,
          sequence: 0,
          position: OcgcoreScriptConstants.POS_FACEDOWN_DEFENSE,
        });
      }
    };

    // Helper function to load a tag deck
    const loadTagDeck = (
      deck: (typeof this.options.decks)[0],
      owner: number,
    ) => {
      for (const card of [...deck.main].reverse()) {
        this.duel.newTagCard({
          code: card,
          owner,
          location: OcgcoreScriptConstants.LOCATION_DECK,
        });
      }
      for (const card of [...deck.extra].reverse()) {
        this.duel.newTagCard({
          code: card,
          owner,
          location: OcgcoreScriptConstants.LOCATION_EXTRA,
        });
      }
    };

    // Load decks
    if (this.options.isTag) {
      // Tag duel: decks[0] for player 0 main, decks[1] for player 0 tag,
      //           decks[2] for player 1 main, decks[3] for player 1 tag
      // In tag mode: player 0 main and player 1 tag start, using newCard
      //              player 0 tag and player 1 main use newTagCard
      if (this.options.decks[0]) loadDeck(this.options.decks[0], 0, 0);
      if (this.options.decks[1]) loadTagDeck(this.options.decks[1], 0);
      if (this.options.decks[3]) loadDeck(this.options.decks[3], 1, 1);
      if (this.options.decks[2]) loadTagDeck(this.options.decks[2], 1);
    } else {
      // Single duel: decks[0] for player 0, decks[1] for player 1
      for (let i = 0; i < 2 && i < this.options.decks.length; i++) {
        loadDeck(this.options.decks[i], i, i);
      }
    }

    // Start duel
    this.duel.startDuel(opt);
  }

  // Wrapper methods for OcgcoreDuel

  @WorkerMethod()
  @TransportEncoder<OcgcoreProcessResult, SerializableProcessResult>(
    (result) => ({
      length: result.length,
      raw: result.raw,
      status: result.status,
      messagePayload: result.message?.toPayload(),
    }),
    (serialized) => ({
      length: serialized.length,
      raw: serialized.raw,
      status: serialized.status,
      message: serialized.messagePayload
        ? YGOProMessages.getInstanceFromPayload(serialized.messagePayload)
        : undefined,
    }),
  )
  async process(): Promise<OcgcoreProcessResult> {
    return this.duel.process();
  }

  @WorkerMethod()
  async setResponseInt(@TransportType() value: number) {
    this.duel.setResponseInt(value);
  }

  @WorkerMethod()
  async setResponse(@TransportType() response: Uint8Array | number) {
    this.duel.setResponse(response);
  }

  @WorkerMethod()
  @TransportEncoder<OcgcoreCardQueryResult, SerializableCardQueryResult>(
    (result) => ({
      length: result.length,
      raw: result.raw,
      cardPayload: result.card?.toPayload() ?? null,
    }),
    (serialized) => ({
      length: serialized.length,
      raw: serialized.raw,
      card: serialized.cardPayload
        ? new CardQuery().fromPayload(serialized.cardPayload)
        : null,
    }),
  )
  async queryCard(
    @TransportType() query: OcgcoreQueryCardParams,
  ): Promise<OcgcoreCardQueryResult> {
    return this.duel.queryCard(query);
  }

  @WorkerMethod()
  async queryFieldCount(
    @TransportType() query: OcgcoreQueryFieldCountParams,
  ): Promise<number> {
    return this.duel.queryFieldCount(query);
  }

  @WorkerMethod()
  @TransportEncoder<
    OcgcoreFieldCardQueryResult,
    SerializableFieldCardQueryResult
  >(
    (result) => ({
      length: result.length,
      raw: result.raw,
      cardsPayload: result.cards.map((card) => card.toPayload()),
    }),
    (serialized) => ({
      length: serialized.length,
      raw: serialized.raw,
      cards: serialized.cardsPayload.map((payload) =>
        new CardQuery().fromPayload(payload),
      ),
    }),
  )
  async queryFieldCard(
    @TransportType() query: OcgcoreQueryFieldCardParams,
  ): Promise<OcgcoreFieldCardQueryResult> {
    return this.duel.queryFieldCard(query);
  }

  @WorkerMethod()
  @TransportEncoder<OcgcoreFieldInfoResult, SerializableFieldInfoResult>(
    (result) => ({
      length: result.length,
      raw: result.raw,
      fieldPayload: result.field.toPayload(),
    }),
    (serialized) => ({
      length: serialized.length,
      raw: serialized.raw,
      field: YGOProMessages.getInstanceFromPayload(
        serialized.fieldPayload,
      ) as any,
    }),
  )
  async queryFieldInfo(): Promise<OcgcoreFieldInfoResult> {
    return this.duel.queryFieldInfo();
  }

  @WorkerMethod()
  @TransportEncoder<OcgcoreProcessResult[], SerializableProcessResult[]>(
    (results) =>
      results.map((result) => ({
        length: result.length,
        raw: result.raw,
        status: result.status,
        messagePayload: result.message?.toPayload(),
      })),
    (serializedArray) =>
      serializedArray.map((serialized) => ({
        length: serialized.length,
        raw: serialized.raw,
        status: serialized.status,
        message: serialized.messagePayload
          ? YGOProMessages.getInstanceFromPayload(serialized.messagePayload)
          : undefined,
      })),
  )
  async advance(): Promise<OcgcoreProcessResult[]> {
    // Use the original advance generator without advancor, collect results into array
    const results: OcgcoreProcessResult[] = [];
    for (const res of this.duel.advance()) {
      results.push(res);
    }
    return results;
  }

  @WorkerMethod()
  async getRegistryValue(@TransportType() key: string) {
    return this.duel.getRegistryValue(key);
  }

  @WorkerMethod()
  async setRegistryValue(
    @TransportType() key: string,
    @TransportType() value: string,
  ) {
    this.duel.setRegistryValue(key, value);
  }

  @WorkerMethod()
  async getRegistryKeys() {
    return this.duel.getRegistryKeys();
  }

  @WorkerMethod()
  async clearRegistry() {
    this.duel.clearRegistry();
  }

  @WorkerMethod()
  async dumpRegistry() {
    return this.duel.dumpRegistry();
  }

  @WorkerMethod()
  async loadRegistry(
    @TransportType() input: Uint8Array | Record<string, string>,
  ) {
    this.duel.loadRegistry(input);
  }

  @WorkerMethod()
  @WorkerFinalize()
  async dispose() {
    // Dump registry and send to master thread via masterFinalize
    if (this.duel && !this.duel.ended) {
      const registryDump = this.duel.dumpRegistry();
      await this.masterFinalize(registryDump.dict);
    }

    if (this.duel && !this.duel.ended) {
      this.duel.endDuel();
    }
    this.ocgcore.finalize();
  }
}
