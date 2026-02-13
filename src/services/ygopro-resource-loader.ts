import initSqlJs, { SqlJsStatic } from 'sql.js';
import { Context } from '../app';
import { loadPaths } from '../utility/load-path';
import { DirCardReader, searchYGOProResource } from 'koishipro-core.js';
import { YGOProLFList, YGOProLFListItem } from 'ygopro-lflist-encode';
import path from 'node:path';

export class YGOProResourceLoader {
  constructor(private ctx: Context) {}

  ygoproPaths = loadPaths(this.ctx.getConfig('YGOPRO_PATH')).flatMap((p) => [
    path.join(p, 'expansions'),
    p,
  ]);
  extraScriptPaths = loadPaths(this.ctx.getConfig('EXTRA_SCRIPT_PATH'));

  private SQL!: SqlJsStatic;

  async init() {
    this.SQL = await initSqlJs();
  }

  async getCardReader() {
    return DirCardReader(this.SQL, ...this.ygoproPaths);
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
