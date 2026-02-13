import { AppContext } from 'nfkit';
import type { SqlJsStatic } from 'sql.js';
import initSqlJs from 'sql.js';

export class SqljsLoader {
  constructor(private ctx: AppContext) {}

  SQL!: SqlJsStatic;

  setSqlJs(SQL: SqlJsStatic) {
    this.SQL = SQL;
    return this;
  }
}

export const SqljsFactory = async (ctx: AppContext) => {
  const SQL = await initSqlJs();
  return new SqljsLoader(ctx).setSqlJs(SQL);
};
