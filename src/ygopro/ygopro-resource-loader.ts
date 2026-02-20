import { Context } from '../app';
import type { CardReaderFn } from 'koishipro-core.js';
import { searchYGOProResource } from 'koishipro-core.js';
import { YGOProLFList } from 'ygopro-lflist-encode';
import path from 'node:path';
import type { CardDataEntry } from 'ygopro-cdb-encode';
import { YGOProCdb } from 'ygopro-cdb-encode';
import { toShared } from 'yuzuthread';
import BetterLock from 'better-lock';
import { CardStorage } from './card-storage';

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
    const cards: CardDataEntry[] = [];
    const seen = new Set<number>();
    let dbCount = 0;

    for await (const file of searchYGOProResource(...this.ygoproPaths)) {
      const filename = path.basename(file.path);
      if (!filename?.endsWith('.cdb')) {
        continue;
      }
      try {
        const currentDb = new this.ctx.SQL.Database(await file.read());
        try {
          const currentCdb = new YGOProCdb(currentDb).noTexts();
          for (const card of currentCdb.find()) {
            const cardId = card.code >>> 0;
            if (seen.has(cardId)) {
              continue;
            }
            seen.add(cardId);
            cards.push(card);
          }
          ++dbCount;
        } finally {
          currentDb.close();
        }
      } catch (e) {
        this.logger.warn(`Failed to read ${file.path}: ${e}`);
        continue;
      }
    }

    const storage = toShared(CardStorage.fromCards(cards));
    this.logger.info(
      {
        size: storage.byteLength,
      },
      `Merged database from ${dbCount} databases with ${storage.size} cards`,
    );
    return storage;
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
