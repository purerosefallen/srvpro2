import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MycardProtocolClient, waitUntil } from './mycard-protocol-client';
import { MycardWindbotPlayer } from './mycard-windbot-player';

type Account = {
  id: number;
  role: string;
  username: string;
  password: string;
  active: boolean;
};
type JoinTiming = 'before-start' | 'after-start';
type ConcurrentAction = 'keep-both' | 'leave-second' | 'rejoin-first';
type CreatedAccounts = { accounts: Account[] };
type AccountCleanup = { deletedIds: number[]; remaining: number };

const serverHost = process.env.MYCARD_TEST_HOST || 'tiramisu.moenext.com';
const serverPort = Number(process.env.MYCARD_TEST_PORT || 27911);
const protocolVersion = Number(process.env.MYCARD_TEST_VERSION || 4962);
const accountBaseUrl =
  process.env.MYCARD_TEST_ACCOUNT_URL ||
  'https://sapi.moecube.com:444/accounts';
const accountSshHost =
  process.env.MYCARD_TEST_ACCOUNT_SSH || 'root@poi.moenext.com';
const accountContainer =
  process.env.MYCARD_TEST_ACCOUNT_CONTAINER || 'mycard_accounts_3';
const windbotExecutable = resolve(
  process.env.MYCARD_TEST_WINDBOT ||
    '../ygopro/windbot/bin/Release/WindBot.exe',
);
const runId = randomBytes(4).toString('hex');
const accounts = new Map<string, Account>();
const secretCache = new Map<string, { secret: number; expiresAt: number }>();
const openMatches = new Set<TestMatch>();
const openSpectators = new Set<MycardProtocolClient>();
const results: unknown[] = [];
let roomSequence = 0;
let accountCreation: Promise<CreatedAccounts> | undefined;
let cleanupPromise: Promise<void> | undefined;

function accountOperation(action: 'create'): Promise<CreatedAccounts>;
function accountOperation(action: 'cleanup'): Promise<AccountCleanup>;
async function accountOperation(action: 'create' | 'cleanup') {
  const script = readFileSync(
    join(process.cwd(), 'e2e/mycard-test-accounts.cjs'),
  );
  return new Promise<CreatedAccounts | AccountCleanup>(
    (resolveResult, reject) => {
      const remoteProcess = spawn(
        'ssh',
        [
          '-o',
          'BatchMode=yes',
          '-o',
          'ConnectTimeout=12',
          accountSshHost,
          'docker',
          'exec',
          '-i',
          accountContainer,
          'node',
          '-',
          action,
          runId,
        ],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
      let output = '';
      remoteProcess.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      remoteProcess.stderr.on('data', () => {});
      remoteProcess.on('error', reject);
      remoteProcess.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`Account ${action} exited with status ${code}`));
          return;
        }
        try {
          resolveResult(JSON.parse(output));
        } catch {
          reject(new Error(`Account ${action} returned an invalid response`));
        }
      });
      remoteProcess.stdin.end(script);
    },
  );
}

async function accountRequest(path: string, options: RequestInit) {
  const response = await fetch(`${accountBaseUrl}${path}`, {
    ...options,
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`Account endpoint ${path} returned ${response.status}`);
  }
  return response.json();
}

async function getSecret(account: Account): Promise<number> {
  const cached = secretCache.get(account.username);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.secret;
  }
  const signedIn = await accountRequest('/signin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      account: account.username,
      password: account.password,
    }),
  });
  const user = await accountRequest('/authUser', {
    headers: { Authorization: `Bearer ${signedIn.token}` },
  });
  assert.equal(
    user.active,
    account.active,
    'account state must match the SQL fixture',
  );
  assert.equal(typeof user.u16Secret, 'number');
  secretCache.set(account.username, {
    secret: user.u16Secret,
    expiresAt: Date.now() + 180_000,
  });
  return user.u16Secret;
}

async function encodePassword(
  account: Account,
  action: number,
  suffix: string,
) {
  const payload = Buffer.alloc(6);
  payload[1] = action << 4;
  if (action === 1 || action === 2) {
    payload[1] |= 5 << 1;
    payload[2] = (2 << 5) | (1 << 3) | (1 << 1); // Any cards, match mode, no deck check.
    payload.writeUInt16LE(8000, 3);
    payload[5] = 0x51;
  }
  payload[0] =
    -payload.subarray(1).reduce((sum, value) => sum + value, 0) & 0xff;
  const secret = ((await getSecret(account)) % 65535) + 1;
  for (let offset = 0; offset < payload.length; offset += 2) {
    payload.writeUInt16LE(payload.readUInt16LE(offset) ^ secret, offset);
  }
  const password = payload.toString('base64') + suffix;
  assert.ok(
    password.length <= 20,
    'join passwords must fit the native protocol',
  );
  return password;
}

function getAccount(role: string) {
  const account = accounts.get(role);
  assert.ok(account, `missing test account ${role}`);
  return account;
}

class TestMatch {
  private finishing = false;
  private surrenderTimers = new Set<ReturnType<typeof setTimeout>>();
  readonly host: MycardWindbotPlayer;
  readonly opponent: MycardWindbotPlayer;

  constructor(
    public readonly roomName: string,
    first: Account,
    second: Account,
  ) {
    this.host = new MycardWindbotPlayer(first.username);
    this.opponent = new MycardWindbotPlayer(second.username);
    this.host.on('gameStart', () => {
      if (this.finishing) {
        this.scheduleSurrender();
      }
    });
  }

  async start() {
    await this.host.startDuel();
    await waitUntil(
      'both players entering the duel',
      () => this.opponent.gameStarts > 0,
    );
  }

  async finish() {
    if (this.host.gameStarts === 0) {
      await this.start();
    }
    this.finishing = true;
    this.host.resumeGame();
    this.opponent.resumeGame();
    this.scheduleSurrender();
    await waitUntil(
      'complete match and player disconnects',
      () => this.host.closed && this.opponent.closed,
      60_000,
    );
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    for (const player of [this.host, this.opponent]) {
      assert.ok(
        player.gameStarts >= 2,
        'a complete match must include both games',
      );
      assert.ok(
        player.replay.packets > 0,
        `duelist ${player.username} must receive replays`,
      );
      assert.ok(
        player.duelLog.some((line) => line.includes('Duel finished against')),
        'WindBot must observe the actual duel result',
      );
    }
  }

  async close() {
    for (const timer of this.surrenderTimers) {
      clearTimeout(timer);
    }
    await Promise.all([this.host.close(), this.opponent.close()]);
    openMatches.delete(this);
  }

  report() {
    return {
      roomName: this.roomName,
      players: [this.host, this.opponent].map((player) => ({
        username: player.username,
        gameStarts: player.gameStarts,
        replay: player.replay,
        duelLog: player.duelLog,
      })),
    };
  }

  private scheduleSurrender() {
    const timer = setTimeout(() => {
      this.surrenderTimers.delete(timer);
      if (!this.host.closed) {
        this.host.surrender();
      }
    }, 400);
    this.surrenderTimers.add(timer);
  }
}

async function createMatch(firstRole = 'p1', secondRole = 'p2') {
  const first = getAccount(firstRole);
  const second = getAccount(secondRole);
  let createPassword: string;
  let roomName: string;
  do {
    const title = `sr${runId.slice(0, 4)}${++roomSequence}`;
    createPassword = await encodePassword(first, 1, title);
    roomName = createHash('md5')
      .update(createPassword + first.username)
      .digest('base64')
      .slice(0, 10);
    // Both server generations must resolve the same room ID.
  } while (
    (roomName.match(/\+/g) || []).length > 1 ||
    (roomName.match(/\//g) || []).length > 1
  );
  roomName = roomName.replace('+', '-').replace('/', '_');
  const match = new TestMatch(roomName, first, second);
  openMatches.add(match);
  const options = {
    host: serverHost,
    port: serverPort,
    version: protocolVersion,
    executable: windbotExecutable,
  };
  await match.host.join({ ...options, password: createPassword, deck: 'Burn' });
  const joinPassword = await encodePassword(second, 3, roomName);
  await match.opponent.join({
    ...options,
    password: joinPassword,
    deck: 'OldSchool',
  });
  return match;
}

async function spectate(match: TestMatch, role: string) {
  const account = getAccount(role);
  const client = new MycardProtocolClient(account.username);
  openSpectators.add(client);
  const password = await encodePassword(account, 3, match.roomName);
  await client.join(serverHost, serverPort, protocolVersion, password);
  return client;
}

async function enterAt(match: TestMatch, timing: JoinTiming) {
  if (timing === 'after-start') {
    await match.start();
  }
}

function spectatorReport(client: MycardProtocolClient) {
  return {
    username: client.username,
    position: client.position,
    replay: client.replay,
    replayHints: client.replayHints,
  };
}

async function singleTable(timing: JoinTiming) {
  const match = await createMatch();
  await enterAt(match, timing);
  const verified = await spectate(match, 'verified');
  const inactive = await spectate(match, 'inactive');
  await match.finish();
  assert.ok(
    verified.replay.packets > 0,
    'verified single-table spectator must receive replays',
  );
  assert.equal(
    inactive.replay.packets,
    0,
    'inactive spectator must receive no replay',
  );
  assert.equal(
    inactive.replayHints,
    0,
    'inactive spectators must receive no replay hint',
  );
  assert.ok(
    verified.replayHints > 0,
    'the positive control must receive replay hints',
  );
  results.push({
    scenario: 'email-verification',
    timing,
    match: match.report(),
    verified: spectatorReport(verified),
    inactive: spectatorReport(inactive),
  });
}

async function concurrentTables(
  firstTiming: JoinTiming,
  secondTiming: JoinTiming,
  action: ConcurrentAction,
) {
  const first = await createMatch();
  const second = await createMatch('p3', 'p4');
  await enterAt(first, firstTiming);
  let firstSpectator = await spectate(first, 'multi');
  const firstControl = await spectate(first, 'control');
  await enterAt(second, secondTiming);
  const secondSpectator = await spectate(second, 'multi');
  const secondControl = await spectate(second, 'verified');
  if (action !== 'keep-both') {
    secondSpectator.close();
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  }
  if (action === 'rejoin-first') {
    firstSpectator.close();
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
    firstSpectator = await spectate(first, 'multi');
  }
  await Promise.all([first.finish(), second.finish()]);
  assert.ok(
    firstControl.replay.packets > 0 && secondControl.replay.packets > 0,
    'both tables need independent positive controls',
  );
  if (action === 'rejoin-first') {
    assert.ok(
      firstSpectator.replay.packets > 0,
      'actual reentry must restore a single-table spectator',
    );
  } else {
    assert.equal(
      firstSpectator.replay.packets,
      0,
      'first table must remain blocked',
    );
    assert.equal(
      firstSpectator.replayHints,
      0,
      'blocked first table must send no replay hint',
    );
  }
  assert.equal(
    secondSpectator.replay.packets,
    0,
    'second table must not send a replay',
  );
  assert.equal(
    secondSpectator.replayHints,
    0,
    'blocked second table must send no replay hint',
  );
  results.push({
    scenario: action,
    firstTiming,
    secondTiming,
    matches: [first.report(), second.report()],
    spectators: [firstSpectator, secondSpectator].map(spectatorReport),
    controls: [firstControl, secondControl].map(spectatorReport),
  });
}

async function playingAndSpectating() {
  const first = await createMatch();
  const second = await createMatch('p3', 'p4');
  await second.start();
  const spectator = await spectate(second, 'p1');
  const duplicate = await spectate(second, 'p1');
  const control = await spectate(second, 'control');
  await Promise.all([first.finish(), second.finish()]);
  for (const connection of [spectator, duplicate, control]) {
    assert.ok(
      connection.replay.packets > 0,
      'playing elsewhere and duplicate connections must not count as extra spectator tables',
    );
  }
  results.push({
    scenario: 'playing-and-duplicate-spectators',
    matches: [first.report(), second.report()],
    spectators: [spectator, duplicate, control].map(spectatorReport),
  });
}

async function closeConnections() {
  for (const spectator of openSpectators) {
    spectator.close();
  }
  openSpectators.clear();
  await Promise.all([...openMatches].map((match) => match.close()));
  await new Promise((resolveWait) => setTimeout(resolveWait, 300));
}

async function runCase(description: string, test: () => Promise<void>) {
  try {
    await test();
    console.log(`PASS ${description}`);
  } finally {
    await closeConnections();
  }
}

function cleanupRun(): Promise<void> {
  if (!cleanupPromise) {
    cleanupPromise = (async () => {
      // A signal during insertion must wait for the transaction before cleanup.
      await accountCreation?.catch(() => undefined);
      try {
        await closeConnections();
      } finally {
        const cleanup = await accountOperation('cleanup');
        assert.equal(cleanup.remaining, 0, 'temporary users must be removed');
        console.log(
          `Removed temporary account IDs: ${cleanup.deletedIds.join(', ')}`,
        );
        const report = {
          host: serverHost,
          port: serverPort,
          runId,
          results,
          cleanup,
        };
        if (process.env.MYCARD_TEST_REPORT) {
          writeFileSync(
            process.env.MYCARD_TEST_REPORT,
            JSON.stringify(report, null, 2) + '\n',
          );
        }
        accounts.clear();
        secretCache.clear();
      }
    })();
  }
  return cleanupPromise;
}

async function main() {
  console.log(`Testing ${serverHost}:${serverPort}, run ${runId}`);
  try {
    accountCreation = accountOperation('create');
    const created = await accountCreation;
    for (const account of created.accounts) {
      accounts.set(account.role, account);
    }
    console.log(`Created ${accounts.size} temporary accounts`);
    for (const timing of ['before-start', 'after-start'] as const) {
      await runCase(`email verification: ${timing}`, () => singleTable(timing));
      for (const action of [
        'keep-both',
        'leave-second',
        'rejoin-first',
      ] as const) {
        await runCase(`${action}: ${timing}`, () =>
          concurrentTables(timing, timing, action),
        );
      }
    }
    await runCase('mixed observer identities', () =>
      concurrentTables('before-start', 'after-start', 'keep-both'),
    );
    await runCase(
      'playing elsewhere and duplicate connections',
      playingAndSpectating,
    );
  } finally {
    await cleanupRun();
  }
}

if (require.main === module) {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      console.error(`${signal}: cleaning up test connections and accounts`);
      cleanupRun().then(
        () => process.exit(1),
        () => process.exit(1),
      );
    });
  }
  process.once('uncaughtException', (error) => {
    console.error(error.message);
    cleanupRun().then(
      () => process.exit(1),
      () => process.exit(1),
    );
  });
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
