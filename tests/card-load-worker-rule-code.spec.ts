import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import initSqlJs from 'sql.js';
import { CardDataEntry, YGOProCdb } from 'ygopro-cdb-encode';
import { OcgcoreCommonConstants } from 'ygopro-msg-encode';
import { CardLoadWorker } from '../src/ygopro/card-load-worker';

/**
 * Cards under test:
 *   10000 — original card (alias=0, ruleCode=0)
 *   20000 — reprint of 10000 (ruleCode=10000; stored as alias=10000 in datas)
 *   20001 — alt-art of the reprint (alias=20000, should inherit ruleCode=10000)
 *
 * All five topologies for splitting these cards across CDB files must resolve
 * correctly via cross-DB resolveRuleCode in CardLoadWorker.
 */

const TYPE = OcgcoreCommonConstants.TYPE_MONSTER;

async function makeCdbFile(
  SQL: Awaited<ReturnType<typeof initSqlJs>>,
  dir: string,
  filename: string,
  codes: number[],
): Promise<void> {
  const db = new YGOProCdb(SQL);
  const entries: CardDataEntry[] = codes.map((code) => {
    if (code === 10000) {
      return new CardDataEntry().fromPartial({ code, type: TYPE });
    }
    if (code === 20000) {
      // ruleCode=10000 → toSqljsRow writes it as alias=10000 in the DB
      return new CardDataEntry().fromPartial({ code, type: TYPE, ruleCode: 10000 });
    }
    // 20001: alt-art of 20000, alias within 20 range → stays as alias
    return new CardDataEntry().fromPartial({ code, type: TYPE, alias: 20000 });
  });
  db.addCard(entries);
  await fs.promises.writeFile(
    path.join(dir, filename),
    Buffer.from(db.export()),
  );
  db.finalize();
}

async function runWorker(dir: string) {
  const result = await new CardLoadWorker([dir]).load();
  return result.cardStorage;
}

function assertCards(storage: Awaited<ReturnType<typeof runWorker>>) {
  const original = storage.readCard(10000);
  expect(original).toBeDefined();
  expect(original?.alias).toBe(0);
  expect(original?.ruleCode).toBe(0);

  const reprint = storage.readCard(20000);
  expect(reprint).toBeDefined();
  expect(reprint?.alias).toBe(0);
  expect(reprint?.ruleCode).toBe(10000);

  const altArt = storage.readCard(20001);
  expect(altArt).toBeDefined();
  expect(altArt?.alias).toBe(20000);
  expect(altArt?.ruleCode).toBe(10000);
}

describe('CardLoadWorker cross-CDB ruleCode resolve', () => {
  let SQL: Awaited<ReturnType<typeof initSqlJs>>;
  let tempDir: string;

  beforeAll(async () => {
    SQL = await initSqlJs();
  });

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'srvpro2-card-load-test-'),
    );
  });

  afterEach(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  test('topology 1: all 3 cards in one CDB', async () => {
    await makeCdbFile(SQL, tempDir, 'cards.cdb', [10000, 20000, 20001]);
    assertCards(await runWorker(tempDir));
  });

  test('topology 2: [10000, 20000] in CDB-A, [20001] in CDB-B', async () => {
    await makeCdbFile(SQL, tempDir, 'a.cdb', [10000, 20000]);
    await makeCdbFile(SQL, tempDir, 'b.cdb', [20001]);
    assertCards(await runWorker(tempDir));
  });

  test('topology 2b: [10000, 20001] in CDB-A, [20000] in CDB-B', async () => {
    await makeCdbFile(SQL, tempDir, 'a.cdb', [10000, 20001]);
    await makeCdbFile(SQL, tempDir, 'b.cdb', [20000]);
    assertCards(await runWorker(tempDir));
  });

  test('topology 3: [10000] in CDB-A, [20000, 20001] in CDB-B', async () => {
    await makeCdbFile(SQL, tempDir, 'a.cdb', [10000]);
    await makeCdbFile(SQL, tempDir, 'b.cdb', [20000, 20001]);
    assertCards(await runWorker(tempDir));
  });

  test('topology 4: each card in its own CDB', async () => {
    await makeCdbFile(SQL, tempDir, 'a.cdb', [10000]);
    await makeCdbFile(SQL, tempDir, 'b.cdb', [20000]);
    await makeCdbFile(SQL, tempDir, 'c.cdb', [20001]);
    assertCards(await runWorker(tempDir));
  });
});
