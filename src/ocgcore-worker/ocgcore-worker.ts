import {
  OcgcoreDuel,
  OcgcoreMessageType,
  OcgcoreWrapper,
  createOcgcoreWrapper,
  DirScriptReaderEx,
  DirCardReader,
  _OcgcoreConstants,
  parseCardQuery,
  parseFieldCardQuery,
  parseFieldInfo,
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
import { YGOProMessages, OcgcoreCommonConstants } from 'ygopro-msg-encode';

const { OcgcoreScriptConstants } = _OcgcoreConstants;

// Serializable types for transport (noParse mode: only send binary data)
interface SerializableProcessResult {
  length: number;
  raw: Uint8Array;
  status: number;
}

interface SerializableCardQueryResult {
  length: number;
  raw: Uint8Array;
}

interface SerializableFieldCardQueryResult {
  length: number;
  raw: Uint8Array;
}

interface SerializableFieldInfoResult {
  length: number;
  raw: Uint8Array;
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
    // serialize in worker: only send raw
    (result) => ({
      length: result.length,
      raw: result.raw,
      status: result.status,
    }),
    // deserialize in main thread: re-parse from raw
    (serialized) => ({
      length: serialized.length,
      raw: serialized.raw,
      status: serialized.status,
      message:
        serialized.raw.length > 0
          ? (() => {
              try {
                return YGOProMessages.getInstanceFromPayload(serialized.raw);
              } catch {
                return undefined;
              }
            })()
          : undefined,
    }),
  )
  async process(): Promise<OcgcoreProcessResult> {
    return this.duel.process({ noParse: true });
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
    // serialize in worker: only send raw
    (result) => ({
      length: result.length,
      raw: result.raw,
    }),
    // deserialize in main thread: re-parse from raw
    (serialized) => ({
      length: serialized.length,
      raw: serialized.raw,
      card: parseCardQuery(serialized.raw, serialized.length),
    }),
  )
  async queryCard(
    @TransportType() query: OcgcoreQueryCardParams,
  ): Promise<OcgcoreCardQueryResult> {
    return this.duel.queryCard(query, { noParse: true });
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
    // serialize in worker: only send raw
    (result) => ({
      length: result.length,
      raw: result.raw,
    }),
    // deserialize in main thread: re-parse from raw
    (serialized) => ({
      length: serialized.length,
      raw: serialized.raw,
      cards: parseFieldCardQuery(serialized.raw, serialized.length),
    }),
  )
  async queryFieldCard(
    @TransportType() query: OcgcoreQueryFieldCardParams,
  ): Promise<OcgcoreFieldCardQueryResult> {
    return this.duel.queryFieldCard(query, { noParse: true });
  }

  @WorkerMethod()
  @TransportEncoder<OcgcoreFieldInfoResult, SerializableFieldInfoResult>(
    // serialize in worker: only send raw
    (result) => ({
      length: result.length,
      raw: result.raw,
    }),
    // deserialize in main thread: re-parse from raw
    (serialized) => ({
      length: serialized.length,
      raw: serialized.raw,
      field: parseFieldInfo(serialized.raw),
    }),
  )
  async queryFieldInfo(): Promise<OcgcoreFieldInfoResult> {
    return this.duel.queryFieldInfo({ noParse: true });
  }

  @WorkerMethod()
  @TransportEncoder<OcgcoreProcessResult[], SerializableProcessResult[]>(
    // serialize in worker: only send raw
    (results) =>
      results.map((result) => ({
        length: result.length,
        raw: result.raw,
        status: result.status,
      })),
    // deserialize in main thread: re-parse from raw
    (serializedArray) =>
      serializedArray.map((serialized) => ({
        length: serialized.length,
        raw: serialized.raw,
        status: serialized.status,
        message:
          serialized.raw.length > 0
            ? (() => {
                try {
                  return YGOProMessages.getInstanceFromPayload(serialized.raw);
                } catch {
                  return undefined;
                }
              })()
            : undefined,
      })),
  )
  async advance(): Promise<OcgcoreProcessResult[]> {
    const results: OcgcoreProcessResult[] = [];
    while (true) {
      const res = this.duel.process({ noParse: true });
      results.push(res);
      if (res.status > 0) {
        break;
      }
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
