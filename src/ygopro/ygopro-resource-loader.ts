import { Context } from '../app';
import type { CardReaderFn } from 'koishipro-core.js';
import { searchYGOProResource } from 'koishipro-core.js';
import { YGOProLFList } from 'ygopro-lflist-encode';
import path from 'node:path';
import { runInWorker } from 'yuzuthread';
import BetterLock from 'better-lock';
import { CardStorage } from './card-storage';
import { CardLoadWorker } from './card-load-worker';

const CARD_STORAGE_RELOAD_INTERVAL_MS = 10 * 60 * 1000;

export class YGOProResourceLoader {
  constructor(private ctx: Context) {
    void this.loadYGOProCdbs();
    this.registerReloadTimer();
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
  private currentCardStorageSha512?: Buffer;
  private reloadTimerRegistered = false;

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
    const storage = await this.getCardStorage();
    return storage.toCardReader();
  }

  async getOcgcoreWasmBinary() {
    const storage = await this.getCardStorage();
    return storage.ocgcoreWasmBinary;
  }

  async loadYGOProCdbs() {
    if (this.loadingCardStorage) {
      return this.loadingCardStorage;
    }
    const loading = this.loadingLock.acquire(async () => {
      const { cardStorage, sha512 } = await this.loadCardStorage();
      const storage = cardStorage;
      this.currentCardStorage = storage;
      this.currentCardStorageSha512 = sha512;
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

  private registerReloadTimer() {
    if (this.reloadTimerRegistered) {
      return;
    }
    this.reloadTimerRegistered = true;
    setInterval(() => {
      this.reloadYGOProCdbsIfChanged().catch((error) => {
        this.logger.warn(
          { error },
          'Failed reloading card storage by periodic refresh',
        );
      });
    }, CARD_STORAGE_RELOAD_INTERVAL_MS);
  }

  private async reloadYGOProCdbsIfChanged() {
    if (!this.currentCardStorage) {
      await this.loadYGOProCdbs();
      return;
    }
    if (this.loadingCardStorage) {
      await this.loadingCardStorage;
      return;
    }
    const loading = this.loadingLock.acquire(async () => {
      const { cardStorage, sha512 } = await this.loadCardStorage();
      if (this.currentCardStorageSha512?.equals(sha512)) {
        this.logger.debug('Card storage hash unchanged, keeping current data');
        return this.currentCardStorage!;
      }
      this.currentCardStorage = cardStorage;
      this.currentCardStorageSha512 = sha512;
      this.logger.info('Card storage hash changed, replaced current data');
      return cardStorage;
    });
    this.loadingCardStorage = loading;
    try {
      await loading;
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
    const { cardStorage, dbCount, failedFiles, sha512 } = await runInWorker(
      CardLoadWorker,
      (worker) => worker.load(),
      this.ygoproPaths,
      ocgcoreWasmPath,
    );

    for (const failedFile of failedFiles) {
      this.logger.warn(`Failed to read ${failedFile}`);
    }
    this.logger.info(
      {
        size: cardStorage.byteLength,
      },
      `Merged database from ${dbCount} databases with ${cardStorage.size} cards`,
    );
    return {
      cardStorage,
      sha512,
    };
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
