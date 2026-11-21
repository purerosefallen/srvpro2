import { spawn, spawnSync } from 'node:child_process';
import { pbkdf2Sync } from 'node:crypto';
import { createServer, connect } from 'node:net';
import { join } from 'node:path';
import { Client } from 'pg';

export const COMPOSE_FILE = join(__dirname, 'docker-compose.yml');
export const OWNER_USERNAME = 'srvpro2_owner';
export const OWNER_PASSWORD = 'Srvpro2_Owner_123';
export const LEGACY_USERNAME = 'e2e';
export const LEGACY_PASSWORD = 'e2e-pass';
const E2E_LFLIST_NAME = '2025.10';

type Ports = {
  angelus: number;
  postgres: number;
  redis: number;
  accounts: number;
  tabulator: number;
  srvproApi: number;
  srvproTcp: number;
};

export function reserveFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() =>
        port ? resolve(port) : reject(new Error('No free port was reserved')),
      );
    });
  });
}

export class E2EStack {
  ports!: Ports;
  project = '';
  private challongeEnabled = false;
  private challongeApiKey = '';
  private challongeTournamentId = '';
  private windbotSequence = 0;
  private lflistIndex = 0;

  async up() {
    const ports = await Promise.all(
      Array.from({ length: 7 }, () => reserveFreePort()),
    );
    this.ports = {
      angelus: ports[6],
      postgres: ports[0],
      redis: ports[1],
      accounts: ports[2],
      tabulator: ports[3],
      srvproApi: ports[4],
      srvproTcp: ports[5],
    };
    this.project = `srvpro2-e2e-${process.pid}-${this.ports.srvproApi}`;
    this.compose([
      'up',
      '-d',
      '--build',
      '--wait',
      'angelus',
      'postgres',
      'redis',
      'accounts',
      'tabulator',
    ]);
    const response = await fetch(
      'http://127.0.0.1:' + this.ports.angelus + '/lflists',
    );
    const body = await response.json();
    this.lflistIndex = body.data.lists.findIndex(
      (list) => list.name === E2E_LFLIST_NAME,
    );
    if (this.lflistIndex < 0)
      throw new Error('Missing tournament banlist ' + E2E_LFLIST_NAME);
    await this.seedOwner();
  }

  configureChallonge(tournamentId: number, apiKey: string) {
    this.challongeTournamentId = String(tournamentId);
    this.challongeApiKey = apiKey;
  }

  async startSrvpro(challongeEnabled: boolean) {
    this.challongeEnabled = challongeEnabled;
    try {
      this.compose([
        'up',
        '-d',
        '--build',
        '--force-recreate',
        '--wait',
        'srvpro2',
      ]);
    } catch (error) {
      try {
        this.compose(['logs', '--no-color', 'srvpro2']);
      } catch {
        // Preserve the original startup error if log collection also fails.
      }
      throw error;
    }
    await this.waitForTcp();
  }

  buildWindbot() {
    this.compose(['--profile', 'windbot', 'build', 'windbot']);
  }

  async runWindbot(
    name: string,
    room: string,
    expectedMessage: string,
    timeoutMs = 45_000,
  ): Promise<string> {
    this.windbotSequence += 1;
    const containerName = `${this.project}-windbot-${this.windbotSequence}`;
    const args = this.composeArgs([
      '--profile',
      'windbot',
      'run',
      '--rm',
      '--no-deps',
      '--name',
      containerName,
      'windbot',
      `Name=${name}`,
      'Deck=BE2025',
      'DeckFile=AI_BE2025_2025_10',
      'Host=srvpro2',
      'Port=7911',
      `HostInfo=${room}`,
      'Debug=true',
      'Chat=false',
    ]);

    return new Promise<string>((resolve, reject) => {
      const child = spawn('docker', args, {
        env: this.composeEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        spawnSync('docker', ['rm', '-f', containerName], {
          stdio: 'ignore',
        });
        if (error) reject(error);
        else resolve(output);
      };
      const collect = (chunk: Buffer) => {
        output += chunk.toString('utf-8');
        if (output.includes(expectedMessage)) {
          finish();
        }
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      child.once('error', (error) => finish(error));
      child.once('close', (code) => {
        if (!settled) {
          finish(
            new Error(
              `WindBot exited with ${code} before ${JSON.stringify(expectedMessage)}:\n${output}`,
            ),
          );
        }
      });
      const timeout = setTimeout(
        () =>
          finish(
            new Error(
              `WindBot timed out waiting for ${JSON.stringify(expectedMessage)}:\n${output}`,
            ),
          ),
        timeoutMs,
      );
    });
  }

  async down() {
    if (!this.project) return;
    try {
      this.compose(['--profile', 'windbot', 'down', '-v', '--remove-orphans']);
    } catch {
      // Best-effort cleanup preserves the original test failure.
    }
  }

  get accountsBaseUrl() {
    return `http://127.0.0.1:${this.ports.accounts}`;
  }

  get tabulatorBaseUrl() {
    return `http://127.0.0.1:${this.ports.tabulator}`;
  }

  get srvproBaseUrl() {
    return `http://127.0.0.1:${this.ports.srvproApi}`;
  }

  async querySrvpro<T extends Record<string, unknown>>(sql: string) {
    const client = new Client({
      host: '127.0.0.1',
      port: this.ports.postgres,
      user: 'postgres',
      password: 'postgres',
      database: 'srvpro2',
    });
    await client.connect();
    try {
      return (await client.query<T>(sql)).rows;
    } finally {
      await client.end();
    }
  }

  private composeEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      ANGELUS_HOST_PORT: String(this.ports.angelus),
      PG_HOST_PORT: String(this.ports.postgres),
      REDIS_HOST_PORT: String(this.ports.redis),
      ACCOUNT_HOST_PORT: String(this.ports.accounts),
      TABULATOR_HOST_PORT: String(this.ports.tabulator),
      SRVPRO_API_HOST_PORT: String(this.ports.srvproApi),
      SRVPRO_TCP_HOST_PORT: String(this.ports.srvproTcp),
      CHALLONGE_ENABLED: this.challongeEnabled ? '1' : '0',
      CHALLONGE_API_KEY: this.challongeApiKey,
      CHALLONGE_TOURNAMENT_ID: this.challongeTournamentId,
      HOSTINFO_LFLIST: String(this.lflistIndex),
    };
  }

  private composeArgs(args: string[]) {
    return ['compose', '-p', this.project, '-f', COMPOSE_FILE, ...args];
  }

  private compose(args: string[]) {
    const result = spawnSync('docker', this.composeArgs(args), {
      env: this.composeEnv(),
      stdio: 'inherit',
    });
    if (result.status !== 0) {
      throw new Error(`docker compose failed with status ${result.status}`);
    }
  }

  private async seedOwner() {
    const client = new Client({
      host: '127.0.0.1',
      port: this.ports.postgres,
      user: 'postgres',
      password: 'postgres',
      database: 'accounts',
    });
    const salt = 'srvpro2-e2e-owner-salt';
    const passwordHash = pbkdf2Sync(
      OWNER_PASSWORD,
      salt,
      64_000,
      32,
      'sha256',
    ).toString('hex');
    await client.connect();
    try {
      await client.query(
        `
          INSERT INTO users (
            id, username, name, email, password_hash, salt, active, admin,
            locale, registration_ip_address, ip_address, created_at, updated_at
          )
          VALUES (2001, $1, $1, 'owner@srvpro2.e2e', $2, $3, true, false,
            'zh-CN', '127.0.0.1', '127.0.0.1', NOW(), NOW())
          ON CONFLICT (username) DO UPDATE SET
            password_hash = EXCLUDED.password_hash,
            salt = EXCLUDED.salt,
            active = true,
            updated_at = NOW()
        `,
        [OWNER_USERNAME, passwordHash, salt],
      );
      await client.query(
        `SELECT setval(pg_get_serial_sequence('users', 'id'), (SELECT MAX(id) FROM users))`,
      );
    } finally {
      await client.end();
    }
  }

  private async waitForTcp(timeoutMs = 60_000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const ready = await new Promise<boolean>((resolve) => {
        const socket = connect(this.ports.srvproTcp, '127.0.0.1');
        socket.once('connect', () => {
          socket.destroy();
          resolve(true);
        });
        socket.once('error', () => resolve(false));
      });
      if (ready) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error('srvpro2 TCP port did not become ready');
  }
}

export async function fetchJson<T>(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`${response.status} ${url}: ${text}`);
  }
  return body as T;
}
