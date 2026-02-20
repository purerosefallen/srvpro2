import { Context } from '../app';
import { searchYGOProResource, SqljsCardReader } from 'koishipro-core.js';
import { YGOProLFList } from 'ygopro-lflist-encode';
import path from 'node:path';
import { YGOProCdb } from 'ygopro-cdb-encode';

export class YGOProResourceLoader {
  constructor(private ctx: Context) {}

  ygoproPaths = this.ctx.config
    .getStringArray('YGOPRO_PATH')
    .map((p) => path.resolve(process.cwd(), p))
    .flatMap((p) => [path.join(p, 'expansions'), p]);
  extraScriptPaths = this.ctx.config
    .getStringArray('EXTRA_SCRIPT_PATH')
    .map((p) => path.resolve(process.cwd(), p));

  private logger = this.ctx.createLogger(this.constructor.name);

  private cardReader = this.mergeDatabase().then((db) => SqljsCardReader(db));

  async getCardReader() {
    return this.cardReader;
  }

  private async mergeDatabase() {
    const db = new YGOProCdb(this.ctx.SQL).noTexts();
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
          const cards = currentCdb.find();
          for (const card of cards) {
            if (!db.findById(card.code)) {
              db.addCard(card);
            }
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
    this.logger.info(
      `Merged database from ${dbCount} databases with ${db.find().length} cards`,
    );
    return db;
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
