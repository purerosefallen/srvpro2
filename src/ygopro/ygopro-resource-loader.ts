import { Context } from '../app';
import type { CardReaderFn } from 'koishipro-core.js';
import { searchYGOProResource } from 'koishipro-core.js';
import { YGOProLFList } from 'ygopro-lflist-encode';
import path from 'node:path';
import { runInWorker } from 'yuzuthread';
import BetterLock from 'better-lock';
import { CardStorage } from './card-storage';
import { CardLoadWorker } from './card-load-worker';

export class YGOProResourceLoader {
  constructor(private ctx: Context) {
    void this.loadYGOProCdbs();
  }

  ygoproPaths = this.ctx.config
    .getStringArray('YGOPRO_PATH')
    .map((p) => path.resolve(process.cwd(), p))
    .flatMap((p) => [path.join(p, 'expansions'), p]);
  extraScriptPaths = this.ctx.config
    .getStringArray('EXTRA_SCRIPT_PATH')
    .map((p) => path.resolve(process.cwd(), p));

  private logger = this.ctx.createLogger(this.constructor.name);
  private loadingLock = new BetterLock();
  private loadingCardStorage?: Promise<CardStorage>;
  private currentCardStorage?: CardStorage;
  private currentCardReader?: CardReaderFn;
  private currentOcgcoreWasmBinary?: Buffer;

  async getCardStorage() {
    if (this.currentCardStorage) {
      return this.currentCardStorage;
    }
    if (this.loadingCardStorage) {
      return this.loadingCardStorage;
    }
    return this.loadYGOProCdbs();
  }

  async getCardReader(): Promise<CardReaderFn> {
    if (this.currentCardReader) {
      return this.currentCardReader;
    }
    const storage = await this.getCardStorage();
    const reader = storage.toCardReader();
    this.currentCardReader = reader;
    return reader;
  }

  async getOcgcoreWasmBinary() {
    await this.getCardStorage();
    return this.currentOcgcoreWasmBinary;
  }

  async loadYGOProCdbs() {
    if (this.loadingCardStorage) {
      return this.loadingCardStorage;
    }
    const loading = this.loadingLock.acquire(async () => {
      const storage = await this.loadCardStorage();
      this.currentCardStorage = storage;
      this.currentCardReader = storage.toCardReader();
      return storage;
    });
    this.loadingCardStorage = loading;
    try {
      return await loading;
    } finally {
      if (this.loadingCardStorage === loading) {
        this.loadingCardStorage = undefined;
      }
    }
  }

  private async loadCardStorage() {
    const ocgcoreWasmPathConfig =
      this.ctx.config.getString('OCGCORE_WASM_PATH');
    const ocgcoreWasmPath = ocgcoreWasmPathConfig
      ? path.resolve(process.cwd(), ocgcoreWasmPathConfig)
      : undefined;
    const { cardStorage, dbCount, failedFiles, ocgcoreWasmBinary } =
      await runInWorker(
        CardLoadWorker,
        (worker) => worker.load(),
        this.ygoproPaths,
        ocgcoreWasmPath,
      );

    this.currentOcgcoreWasmBinary = ocgcoreWasmBinary;
    for (const failedFile of failedFiles) {
      this.logger.warn(`Failed to read ${failedFile}`);
    }
    this.logger.info(
      {
        size: cardStorage.byteLength,
      },
      `Merged database from ${dbCount} databases with ${cardStorage.size} cards`,
    );
    return cardStorage;
  }

  async *getLFLists() {
    for await (const file of searchYGOProResource(...this.ygoproPaths)) {
      const filename = path.basename(file.path);
      if (filename !== 'lflist.conf') {
        continue;
      }
      const buf = await file.read();
      const lflist = new YGOProLFList().fromText(
        Buffer.from(buf).toString('utf-8'),
      );
      for (const item of lflist.items) {
        yield item;
      }
    }
  }
}
