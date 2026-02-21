import * as fs from 'node:fs';
import { searchYGOProResource } from 'koishipro-core.js';
import type { CardDataEntry } from 'ygopro-cdb-encode';
import { YGOProCdb } from 'ygopro-cdb-encode';
import initSqlJs from 'sql.js';
import { DefineWorker, TransportType, WorkerMethod, toShared } from 'yuzuthread';
import { CardStorage } from './card-storage';

const isFileNotFoundError = (error: unknown): error is NodeJS.ErrnoException =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as NodeJS.ErrnoException).code === 'ENOENT';

export class CardLoadWorkerResult {
  @TransportType(() => CardStorage)
  cardStorage: CardStorage;

  dbCount: number;
  failedFiles: string[];

  @TransportType(() => Buffer)
  ocgcoreWasmBinary?: Buffer;
}

@DefineWorker()
export class CardLoadWorker {
  constructor(
    private ygoproPaths: string[],
    private ocgcoreWasmPath?: string,
  ) {}

  @WorkerMethod()
  @TransportType(() => CardLoadWorkerResult)
  async load(): Promise<CardLoadWorkerResult> {
    const SQL = await initSqlJs();
    const cards: CardDataEntry[] = [];
    const seen = new Set<number>();
    let dbCount = 0;
    const failedFiles: string[] = [];

    for await (const file of searchYGOProResource(...this.ygoproPaths)) {
      if (!file.path.endsWith('.cdb')) {
        continue;
      }

      try {
        const currentDb = new SQL.Database(await file.read());
        try {
          const currentCdb = new YGOProCdb(currentDb).noTexts();
          for (const card of currentCdb.step()) {
            const cardId = (card.code ?? 0) >>> 0;
            if (cardId === 0 || seen.has(cardId)) {
              continue;
            }
            seen.add(cardId);
            cards.push(card);
          }
          ++dbCount;
        } finally {
          currentDb.close();
        }
      } catch (error) {
        failedFiles.push(`${file.path}: ${error}`);
        continue;
      }
    }

    let ocgcoreWasmBinary: Buffer | undefined;
    if (this.ocgcoreWasmPath) {
      try {
        const wasmBinary = await fs.promises.readFile(this.ocgcoreWasmPath);
        ocgcoreWasmBinary = toShared(wasmBinary);
      } catch (error) {
        if (!isFileNotFoundError(error)) {
          throw error;
        }
      }
    }

    const result = new CardLoadWorkerResult();
    result.cardStorage = toShared(CardStorage.fromCards(cards));
    result.dbCount = dbCount;
    result.failedFiles = failedFiles;
    result.ocgcoreWasmBinary = ocgcoreWasmBinary;
    return result;
  }
}
