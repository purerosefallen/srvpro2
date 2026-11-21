/* eslint-disable @typescript-eslint/no-require-imports -- Standalone CommonJS runner and in-image native-driver probe. */
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createHash, randomBytes } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const runId = `${Date.now()}-${process.pid}-${randomBytes(3).toString('hex')}`;
const project = `srvpro2-image-${runId}`;
const room = `NF#${randomBytes(6).toString('hex')}`;
const artifacts = path.join(root, 'output', 'docker-image-test', runId);
const resources = fs.mkdtempSync(path.join(os.tmpdir(), 'srvpro2-image-'));
const image = process.env.SRVPRO_IMAGE || `srvpro2-image-test:${runId}`;
const windbot = process.env.WINDBOT_IMAGE || `srvpro2-windbot-test:${runId}`;
const angelus = process.env.ANGELUS_IMAGE || `srvpro2-angelus-test:${runId}`;
const builds = [
  [image, '.', process.env.SRVPRO_IMAGE, []],
  [angelus, '../ygoangelus', process.env.ANGELUS_IMAGE, []],
  [
    windbot,
    '../ygopro/windbot',
    process.env.WINDBOT_IMAGE,
    ['--build-arg', 'NO_RESOURCE=1'],
  ],
];
const abort = new AbortController();
const startedAt = Date.now();
const summary = {
  project,
  room,
  image,
  windbot,
  startedAt: new Date(startedAt),
};
let sequence = 0;
let stackAttempted = false;

fs.mkdirSync(artifacts, { recursive: true });
const envFile = path.join(artifacts, 'empty.env');
fs.writeFileSync(envFile, '');
const env = {
  ...process.env,
  TEST_ANGELUS_IMAGE: angelus,
  TEST_SRVPRO_IMAGE: image,
  TEST_WINDBOT_IMAGE: windbot,
  TEST_RESOURCE_DIR: resources,
  TEST_ROOM: room,
};
const composeArgs = [
  'compose',
  '--env-file',
  envFile,
  '-p',
  project,
  '-f',
  path.join(__dirname, 'docker-image.compose.yml'),
  '--profile',
  'duel',
];

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () =>
    abort.abort(new Error(`Interrupted by ${signal}`)),
  );
}

function saveJson(name, value) {
  fs.writeFileSync(
    path.join(artifacts, name),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

function docker(args, options = {}) {
  const logFile = path.join(
    artifacts,
    `${String(++sequence).padStart(3, '0')}-${options.label || args[0]}.log`,
  );
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(logFile);
    const child = spawn('docker', args, {
      cwd: root,
      env,
      signal: options.cleanup ? undefined : abort.signal,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let tail = '';
    let failure;
    const timer = setTimeout(() => {
      failure = new Error(`Timed out: docker ${args.join(' ')}`);
      child.kill('SIGKILL');
    }, options.timeout || 60_000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      output.write(chunk);
      tail = (tail + chunk).slice(-8000);
    });
    child.stderr.on('data', (chunk) => {
      output.write(chunk);
      tail = (tail + chunk).slice(-8000);
    });
    child.stdin.on('error', (error) => {
      if (error.code !== 'EPIPE') failure = error;
    });
    child.once('error', (error) => {
      failure = error;
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      output.end();
      if (failure || code !== 0) {
        reject(
          failure ||
            new Error(`docker ${args.join(' ')} exited ${code}\n${tail}`),
        );
      } else resolve(stdout.trim());
    });
    child.stdin.end(options.input);
  });
}

function compose(args, options) {
  return docker([...composeArgs, ...args], options);
}

async function imageProbe() {
  // This function runs inside the production image, with its own native driver.
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const path = require('node:path');
  const pg = require('pg');
  assert.equal(Number(process.versions.node.split('.')[0]), 26);
  assert.ok(process.env.NODE_PG_FORCE_NATIVE);
  assert.equal(typeof require('pg-native'), 'function');
  assert.equal(pg.Client, require('pg/lib/native/index.js'));
  const client = new pg.Client({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    connectionTimeoutMillis: 5000,
    query_timeout: 5000,
  });
  await client.connect();
  try {
    if (process.argv[2] === 'inspect') {
      const result = await client.query(
        "SELECT current_database() AS database, to_regclass('public.duel_record')::text AS records, to_regclass('public.duel_record_player')::text AS players",
      );
      assert.equal(result.rows[0].database, 'srvpro2');
      assert.equal(result.rows[0].records, 'duel_record');
      assert.equal(result.rows[0].players, 'duel_record_player');
      console.log(
        JSON.stringify({
          node: process.version,
          platform: `${process.platform}/${process.arch}`,
          pg: require('pg/package.json').version,
          pgNative: JSON.parse(
            fs.readFileSync(
              path.join(
                path.dirname(require.resolve('pg-native')),
                'package.json',
              ),
              'utf8',
            ),
          ).version,
          nativeDriver: true,
          schema: result.rows[0],
        }),
      );
    } else {
      let room = process.argv[3];
      if (process.argv[2] === 'player') {
        const result = await client.query(
          'SELECT r.name FROM duel_record r JOIN duel_record_player p ON p."duelRecordId"=r.id WHERE p.name=$1 AND r."deleteTime" IS NULL',
          [room],
        );
        assert.equal(result.rowCount, 1);
        room = result.rows[0].name;
      }
      const records = await client.query(
        `SELECT id, name, "roomIdentifier", "duelCount", "winReason", "startTime", "endTime", "hostInfo", "schemaVersion",
          octet_length(decode(messages, 'base64')) AS "messageBytes",
          octet_length(decode(responses, 'base64')) AS "responseBytes",
          octet_length(decode(seed, 'base64')) AS "seedBytes",
          encode(decode(seed, 'base64'), 'hex') AS "seedHex"
         FROM duel_record WHERE name = $1 AND "deleteTime" IS NULL ORDER BY id`,
        [room],
      );
      const players = await client.query(
        `SELECT p.id, p.name, p.pos, p.winner, p.score, p."isFirst", p."duelRecordId", p."startDeckMainc", p."ingameDeckMainc"
         FROM duel_record_player p JOIN duel_record r ON r.id = p."duelRecordId"
         WHERE r.name = $1 AND r."deleteTime" IS NULL AND p."deleteTime" IS NULL ORDER BY p.pos`,
        [room],
      );
      console.log(
        JSON.stringify({ records: records.rows, players: players.rows }),
      );
    }
  } finally {
    await client.end();
  }
}

async function probe(action, lookup = room) {
  const source = `(${imageProbe.toString()})().catch(error => { console.error(error); process.exitCode = 1; });`;
  const result = await compose(
    ['exec', '-T', 'srvpro2', 'node', '-', action, lookup],
    { input: source, label: action },
  );
  return JSON.parse(result);
}

function checkRecords(data, results, expectedRoom = room) {
  assert.equal(data.records.length, 1, 'Expected exactly one duel record');
  const record = data.records[0];
  assert.equal(record.name, expectedRoom);
  assert.equal(record.duelCount, 1);
  assert.notEqual(record.winReason, null, 'Duel must be finished');
  const start = Date.parse(record.startTime);
  const end = Date.parse(record.endTime);
  assert.ok(start >= startedAt && end >= start && end <= Date.now());
  assert.ok(record.messageBytes > 0, 'Missing duel messages');
  assert.ok(record.responseBytes > 0, 'Missing duel responses');
  assert.equal(record.seedBytes, 32);
  assert.equal(record.hostInfo.mode, 0);
  assert.equal(record.hostInfo.lflist, -1);
  assert.equal(record.hostInfo.no_check_deck, 0);
  assert.equal(data.players.length, 2);
  assert.deepEqual(
    data.players.map((p) => p.name).sort(),
    Object.keys(results).sort(),
  );
  assert.deepEqual(data.players.map((p) => p.pos).sort(), [0, 1]);
  for (const player of data.players) {
    assert.equal(player.duelRecordId, record.id);
    assert.equal(player.winner, results[player.name] === 'Win');
    assert.equal(player.score, results[player.name] === 'Win' ? 1 : 0);
    assert.ok(player.startDeckMainc >= 40 && player.ingameDeckMainc >= 40);
  }
}

async function main() {
  console.log(`Docker image acceptance: ${artifacts}`);
  try {
    for (const [tag, context, override, args] of builds) {
      if (!override)
        await docker(
          ['build', '--progress=plain', ...args, '-t', tag, context],
          {
            timeout: 30 * 60_000,
            label: 'build-' + path.basename(path.resolve(context)),
          },
        );
    }
    await compose(['pull', 'postgres'], { timeout: 600000 });
    summary.images = JSON.parse(
      await docker([
        'image',
        'inspect',
        image,
        angelus,
        windbot,
        'postgres:17-alpine',
      ]),
    ).map(({ Id, RepoTags, RepoDigests, Architecture, Os }) => ({
      Id,
      RepoTags,
      RepoDigests,
      Architecture,
      Os,
    }));
    saveJson('images.json', summary.images);
    console.log('Starting the isolated application and PostgreSQL...');
    stackAttempted = true;
    await compose(
      ['up', '-d', '--wait', '--wait-timeout', '180', 'postgres', 'srvpro2'],
      {
        timeout: 210_000,
        label: 'startup',
      },
    );
    summary.runtime = await probe('inspect');
    console.log(
      `Native PostgreSQL and schema ready: ${JSON.stringify(summary.runtime)}`,
    );
    await compose([
      'cp',
      'angelus:/app/ygopro/cards.cdb',
      path.join(resources, 'cards.cdb'),
    ]);
    summary.cardsSha256 = createHash('sha256')
      .update(fs.readFileSync(path.join(resources, 'cards.cdb')))
      .digest('hex');

    await compose([
      'run',
      '--rm',
      '--no-deps',
      '--entrypoint',
      'sh',
      'windbot-a',
      '-c',
      'test -s /windbot/Decks/AI_Burn.ydk && test -s /windbot/Decks/AI_BlueEyes.ydk',
    ]);
    console.log(`Playing Burn versus BlueEyes in ${room}...`);
    await compose(['up', '-d', 'windbot-a', 'windbot-b']);
    const botIds = (await compose(['ps', '-a', '-q', 'windbot-a', 'windbot-b']))
      .split(/\s+/)
      .filter(Boolean);
    assert.equal(botIds.length, 2);
    await docker(['wait', ...botIds], {
      timeout: 10 * 60_000,
      label: 'duel-wait',
    });
    const bots = JSON.parse(await docker(['inspect', ...botIds]));
    assert.ok(
      bots.every(
        (bot) => bot.State.Status === 'exited' && bot.State.ExitCode === 0,
      ),
      'Both WindBots must exit normally',
    );
    const results = {};
    for (const [service, name, opponent] of [
      ['windbot-a', 'WindBot-A', 'WindBot-B'],
      ['windbot-b', 'WindBot-B', 'WindBot-A'],
    ]) {
      const log = await compose([
        'logs',
        '--no-color',
        '--no-log-prefix',
        service,
      ]);
      fs.writeFileSync(path.join(artifacts, `${service}.log`), `${log}\n`);
      assert.ok(log.includes('Duel started:'), `${name} did not start a duel`);
      const result = log.match(
        new RegExp(
          `Duel finished against ${opponent}, result: (Win|Lose|Draw)`,
        ),
      );
      assert.ok(result, `${name} did not receive the duel result`);
      results[name] = result[1];
    }
    assert.ok(
      (results['WindBot-A'] === 'Win' && results['WindBot-B'] === 'Lose') ||
        (results['WindBot-A'] === 'Lose' && results['WindBot-B'] === 'Win'),
      'WindBot results disagree',
    );
    summary.results = results;

    console.log(
      'Checking the completed duel and both players in PostgreSQL...',
    );
    const deadline = Date.now() + 30_000;
    while (true) {
      summary.database = await probe('records');
      saveJson('database.json', summary.database);
      try {
        checkRecords(summary.database, results);
        const logs = await compose([
          'logs',
          '--no-color',
          '--no-log-prefix',
          'srvpro2',
        ]);
        assert.ok(
          logs.includes('Room finalized and removed') && logs.includes(room),
          'Room was not cleaned up',
        );
        break;
      } catch (error) {
        if (Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    await compose(['up', '-d', '--wait', 'windbot']);
    const catalog = JSON.parse(
      await compose([
        'exec',
        '-T',
        'srvpro2',
        'node',
        '-e',
        "fetch('http://windbot:2399/bots').then(r=>r.text()).then(console.log)",
      ]),
    );
    const opponent = catalog.windbots.find((bot) => bot.deck === 'Burn').name;
    for (const name of ['HumanPlayer', 'UndoPlayer']) {
      let results;
      if (name === 'HumanPlayer') {
        const log = await compose(
          [
            'run',
            '--rm',
            '--no-deps',
            'windbot-b',
            'ServerMode=false',
            'Name=' + name,
            'Deck=Blue-Eyes',
            'Host=srvpro2',
            'Port=7911',
            'HostInfo=AI#Burn',
            'Version=4962',
            'Hand=1',
            'Chat=false',
            'DbPath=/test-resources/cards.cdb',
          ],
          { timeout: 600000, label: name },
        );
        const outcome = log.match(
          /Duel finished against (.*), result: (Win|Lose)/,
        );
        assert.ok(
          log.includes('Duel started:') && outcome,
          'Human versus bot duel did not finish',
        );
        assert.equal(outcome[1], opponent);
        results = {
          [name]: outcome[2],
          [opponent]: outcome[2] === 'Win' ? 'Lose' : 'Win',
        };
      } else {
        await compose(['run', '--rm', '--no-deps', 'undo-player'], {
          timeout: 60000,
          label: name,
        });
        results = { [name]: 'Lose', [opponent]: 'Win' };
      }
      const deadline = Date.now() + 30000;
      for (;;) {
        try {
          const data = await probe('player', name);
          assert.match(data.records[0].name, /^AI(?:,ROCK)?#/);
          checkRecords(data, results, data.records[0].name);
          if (name === 'UndoPlayer') {
            const seed = Buffer.alloc(32);
            for (let i = 0; i < 8; ++i) seed.writeUInt32LE(i + 1, i * 4);
            assert.equal(data.records[0].seedHex, seed.toString('hex'));
            assert.equal(data.records[0].winReason, 0);
          }
          const logs = await compose(['logs', '--no-color', 'srvpro2']);
          const finalized = logs
            .split('Room finalized and removed')
            .slice(1)
            .some((part) => part.slice(0, 500).includes(data.records[0].name));
          assert.ok(finalized, 'AI room was not finalized');
          summary[name] = data;
          saveJson(name + '.json', data);
          break;
        } catch (error) {
          if (Date.now() >= deadline) throw error;
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
    }
    summary.status = 'passed';
    console.log(
      `PASS: ${JSON.stringify(results)}, completed duel record ${summary.database.records[0].id}`,
    );
  } catch (error) {
    summary.status = 'failed';
    summary.error = error.stack || String(error);
    process.exitCode = 1;
    console.error(summary.error);
  } finally {
    const cleanupErrors = [];
    if (stackAttempted) {
      for (const [args, label] of [
        [['logs', '--no-color'], 'stack-logs'],
        [['ps', '-a', '--format', 'json'], 'stack-state'],
        [['down', '-v', '--remove-orphans', '--timeout', '10'], 'cleanup'],
      ]) {
        try {
          await compose(args, { label, cleanup: true });
        } catch (error) {
          cleanupErrors.push(error.message);
        }
      }
    }
    for (const [tag, , override] of builds) {
      if (override) continue;
      try {
        await docker(['image', 'rm', tag], {
          cleanup: true,
          label: 'image-cleanup',
        });
      } catch (error) {
        // A failed build may never have created the temporary image.
        if (!error.message.includes('No such image'))
          cleanupErrors.push(error.message);
      }
    }
    if (stackAttempted) {
      try {
        for (const command of [
          ['ps', '-a', '-q'],
          ['network', 'ls', '-q'],
        ]) {
          const remaining = await docker(
            [
              ...command,
              '--filter',
              `label=com.docker.compose.project=${project}`,
            ],
            { cleanup: true, label: 'verify-cleanup' },
          );
          assert.equal(remaining, '', 'Test resources remain after cleanup');
        }
      } catch (error) {
        cleanupErrors.push(error.message);
      }
    }
    fs.rmSync(resources, { recursive: true, force: true });
    summary.cleanupErrors = cleanupErrors;
    if (cleanupErrors.length) {
      summary.status = 'failed';
      process.exitCode = 1;
      console.error(`Cleanup errors: ${cleanupErrors.join('\n')}`);
    }
    summary.finishedAt = new Date();
    saveJson('summary.json', summary);
    console.log(`Evidence: ${artifacts}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
