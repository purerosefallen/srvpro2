'use strict';

// This helper is sent over SSH to the existing account container. Passwords are
// returned only to the test process through its private stdin/stdout pipe.
const { pbkdf2Sync, randomBytes } = require('node:crypto');
const { Client } = require('/usr/src/app/node_modules/pg');
const config = require('/usr/src/app/config.js').default;

const action = process.argv[2];
const runId = process.argv[3];
if (!/^[a-f0-9]{8}$/.test(runId || '')) {
  throw new Error('Expected an eight-character test run ID');
}

const usernamePrefix = `sr${runId}`;
const roles = [
  'p1',
  'p2',
  'p3',
  'p4',
  'verified',
  'inactive',
  'multi',
  'control',
];

async function createAccounts(database) {
  const accounts = [];
  for (let index = 0; index < roles.length; index++) {
    const role = roles[index];
    const username = `${usernamePrefix}${index}`;
    const email = `${username}@risayuzuki.com`;
    const password = randomBytes(18).toString('base64url');
    const salt = randomBytes(8).toString('hex');
    const passwordHash = pbkdf2Sync(
      password,
      salt,
      64000,
      32,
      'sha256',
    ).toString('hex');
    const active = role !== 'inactive' && role !== 'p2';
    const result = await database.query(
      `INSERT INTO users
        (username, email, password_hash, salt, active, admin, locale,
         registration_ip_address, ip_address, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, false, 'zh-CN', '127.0.0.1', '127.0.0.1', NOW(), NOW())
       RETURNING id`,
      [username, email, passwordHash, salt, active],
    );
    accounts.push({ id: result.rows[0].id, role, username, password, active });
  }
  return { accounts };
}

async function deleteAccounts(database) {
  const existing = await database.query(
    'SELECT id FROM users WHERE username LIKE $1 AND email = username || $2',
    [`${usernamePrefix}%`, '@risayuzuki.com'],
  );
  const ids = existing.rows.map((user) => user.id);
  if (ids.length > 0) {
    await database.query(
      'DELETE FROM tokens WHERE user_id = ANY($1::varchar[])',
      [ids.map(String)],
    );
    await database.query(
      'DELETE FROM username_change_history WHERE userid = ANY($1::integer[])',
      [ids],
    );
    await database.query('DELETE FROM users WHERE id = ANY($1::integer[])', [
      ids,
    ]);
  }
  const remaining = await database.query(
    'SELECT COUNT(*)::integer AS count FROM users WHERE username LIKE $1',
    [`${usernamePrefix}%`],
  );
  return { deletedIds: ids, remaining: remaining.rows[0].count };
}

async function main() {
  const database = new Client({ connectionString: config.DATABASE });
  await database.connect();
  try {
    await database.query('BEGIN');
    let result;
    if (action === 'create') {
      result = await createAccounts(database);
    } else if (action === 'cleanup') {
      result = await deleteAccounts(database);
    } else {
      throw new Error('Expected create or cleanup');
    }
    await database.query('COMMIT');
    process.stdout.write(JSON.stringify(result));
  } catch (error) {
    await database.query('ROLLBACK');
    throw error;
  } finally {
    await database.end();
  }
}

main().catch((error) => {
  // Database error objects may contain query parameters. Do not print them.
  process.stderr.write(
    `Test account operation failed: ${error.code || error.name}\n`,
  );
  process.exitCode = 1;
});
