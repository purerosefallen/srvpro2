import { initWorker, type WorkerInstance } from 'yuzuthread';
import { Context } from '../app';
import { DuelRecord, DuelRecordReplayContext } from '../room';
import { createReplayLogSummary, ReplayLogSummary } from './replay-log-summary';
import { ReplayEncodeWorker } from './replay-encode-worker';
import { YGOProStocReplayCompressed } from './ygopro-stoc-replay-compressed';

type EncodedReplay = {
  payload: Buffer;
  summary: ReplayLogSummary;
};

/** Prefetches beyond this are dropped, oldest first; they are only a head start. */
const MAX_PREFETCH_QUEUE = 64;

type ReplayWorker = WorkerInstance<ReplayEncodeWorker>;
type ReplayWorkerPromise = Promise<ReplayWorker>;
export type ReplayWorkerFactory = () => ReplayWorkerPromise;

export class ReplayEncodeService {
  private logger = this.ctx.createLogger(this.constructor.name);
  private workerFactory: ReplayWorkerFactory = () =>
    initWorker(ReplayEncodeWorker);
  private workerPromise?: ReplayWorkerPromise;
  private completedReplayCache = new WeakMap<
    DuelRecord,
    Map<string, Promise<EncodedReplay>>
  >();
  /** Encodes someone is waiting for (players, arena, cloud replay). */
  private waitedEncodes = 0;
  private prefetchQueue: {
    duelRecord: DuelRecord;
    replayContext: DuelRecordReplayContext;
  }[] = [];
  private prefetching = false;

  constructor(private ctx: Context) {}

  /**
   * Encode a finished duel's replay ahead of time, at low priority: it starts
   * only while no waited encode is running, one at a time, so it delays a
   * waited encode by at most the one prefetch already on the worker. The
   * result lands in the same cache the waited calls read.
   */
  prefetch(duelRecord: DuelRecord, replayContext: DuelRecordReplayContext) {
    if (!duelRecord.endTime || this.isCached(duelRecord, replayContext)) {
      return;
    }
    this.prefetchQueue.push({
      duelRecord,
      replayContext: {
        hostinfo: replayContext.hostinfo,
        isTag: replayContext.isTag,
      },
    });
    if (this.prefetchQueue.length > MAX_PREFETCH_QUEUE) {
      this.prefetchQueue.shift();
    }
    this.pumpPrefetch();
  }

  init() {
    process.once('exit', () => {
      void this.finalize();
    });
  }

  async encodePayload(
    duelRecord: DuelRecord,
    replayContext: DuelRecordReplayContext,
  ): Promise<Buffer> {
    return (await this.encode(duelRecord, replayContext)).payload;
  }

  async encodePacket(
    duelRecord: DuelRecord,
    replayContext: DuelRecordReplayContext,
  ): Promise<YGOProStocReplayCompressed> {
    const encoded = await this.encode(duelRecord, replayContext);
    return new YGOProStocReplayCompressed(encoded.payload, encoded.summary);
  }

  async finalize(): Promise<void> {
    const workerPromise = this.workerPromise;
    this.workerPromise = undefined;
    if (!workerPromise) {
      return;
    }
    try {
      const worker = await workerPromise;
      await worker.finalize();
    } catch {
      // The worker has already failed or exited.
    }
  }

  private pumpPrefetch() {
    if (this.prefetching || this.waitedEncodes > 0) {
      return;
    }
    let next: (typeof this.prefetchQueue)[number] | undefined;
    while ((next = this.prefetchQueue.shift())) {
      if (!this.isCached(next.duelRecord, next.replayContext)) {
        break;
      }
    }
    if (!next) {
      return;
    }
    this.prefetching = true;
    void this.encode(next.duelRecord, next.replayContext, false)
      .catch(() => undefined)
      .finally(() => {
        this.prefetching = false;
        this.pumpPrefetch();
      });
  }

  private isCached(
    duelRecord: DuelRecord,
    replayContext: DuelRecordReplayContext,
  ) {
    return !!this.completedReplayCache
      .get(duelRecord)
      ?.has(this.getCacheKey(replayContext));
  }

  private encode(
    duelRecord: DuelRecord,
    replayContext: DuelRecordReplayContext,
    waited = true,
  ): Promise<EncodedReplay> {
    if (!duelRecord.endTime) {
      return this.encodeUncached(duelRecord, replayContext, waited);
    }

    const cacheKey = this.getCacheKey(replayContext);
    let recordCache = this.completedReplayCache.get(duelRecord);
    if (!recordCache) {
      recordCache = new Map();
      this.completedReplayCache.set(duelRecord, recordCache);
    }

    const cached = recordCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const encoded = this.encodeUncached(
      duelRecord,
      replayContext,
      waited,
    ).catch(
      (error) => {
        recordCache!.delete(cacheKey);
        throw error;
      },
    );
    recordCache.set(cacheKey, encoded);
    return encoded;
  }

  private async encodeUncached(
    duelRecord: DuelRecord,
    replayContext: DuelRecordReplayContext,
    waited = true,
  ): Promise<EncodedReplay> {
    const replay = duelRecord.toYrp(replayContext);
    if (waited) {
      this.waitedEncodes += 1;
    }
    try {
      const payload = await this.encodeInWorker(replay);
      return {
        payload,
        summary: createReplayLogSummary(replay, payload.byteLength),
      };
    } finally {
      if (waited) {
        this.waitedEncodes -= 1;
        this.pumpPrefetch();
      }
    }
  }

  private async encodeInWorker(
    replay: ReturnType<DuelRecord['toYrp']>,
  ): Promise<Buffer> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const workerPromise = this.getWorker();
      try {
        const worker = await workerPromise;
        return await worker.encode(replay);
      } catch (error) {
        lastError = error;
        await this.discardWorker(workerPromise);
        this.logger.warn(
          { attempt: attempt + 1, error },
          'Replay encode worker failed',
        );
      }
    }
    throw lastError;
  }

  private getWorker(): ReplayWorkerPromise {
    this.workerPromise ||= this.workerFactory().catch((error) => {
      this.workerPromise = undefined;
      throw error;
    });
    return this.workerPromise;
  }

  private async discardWorker(workerPromise: ReplayWorkerPromise) {
    if (this.workerPromise === workerPromise) {
      this.workerPromise = undefined;
    }
    try {
      const worker = await workerPromise;
      await worker.finalize();
    } catch {
      // The worker is already unusable.
    }
  }

  private getCacheKey(replayContext: DuelRecordReplayContext) {
    return JSON.stringify({
      hostinfo: replayContext.hostinfo,
      isTag: replayContext.isTag,
    });
  }
}
