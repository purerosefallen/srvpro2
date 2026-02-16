import { ChildProcess, spawn } from 'node:child_process';
import { Context } from '../../app';
import { WindBotProvider } from './windbot-provider';

export class WindbotSpawner {
  private logger = this.ctx.createLogger(this.constructor.name);
  private windbotProvider = this.ctx.get(() => WindBotProvider);

  private loopLimit = 0;
  private windbotProcess: ChildProcess | null = null;
  private readonly maxLoopLimit = 1000;
  private stopping = false;

  constructor(private ctx: Context) {}

  init() {
    if (!this.windbotProvider.enabled || !this.windbotProvider.spawnEnabled) {
      return;
    }
    this.spawnWindbot();
    process.once('exit', () => {
      this.stop();
    });
    process.once('SIGINT', () => {
      this.stop();
    });
    process.once('SIGTERM', () => {
      this.stop();
    });
  }

  private resolveWindbotPort() {
    try {
      const endpointUrl = new URL(this.windbotProvider.endpoint);
      const fallbackPort = endpointUrl.protocol === 'https:' ? '443' : '80';
      return endpointUrl.port || fallbackPort;
    } catch (error) {
      this.logger.warn(
        {
          endpoint: this.windbotProvider.endpoint,
          error: (error as Error).toString(),
        },
        'Invalid WINDBOT_ENDPOINT',
      );
      return null;
    }
  }

  private spawnWindbot() {
    const port = this.resolveWindbotPort();
    if (!port) {
      return;
    }

    const isWindows = /^win/.test(process.platform);
    const windbotBin = isWindows ? 'WindBot.exe' : 'mono';
    const windbotParameters = isWindows ? [] : ['WindBot.exe'];
    windbotParameters.push('ServerMode=true');
    windbotParameters.push(`ServerPort=${port}`);

    const processHandle = spawn(windbotBin, windbotParameters, {
      cwd: 'windbot',
    });
    this.windbotProcess = processHandle;

    processHandle.on('error', (error) => {
      this.logger.warn({ error }, 'WindBot ERROR');
      this.respawnWindbot();
    });
    processHandle.on('exit', (code) => {
      this.logger.warn({ code }, 'WindBot EXIT');
      this.respawnWindbot();
    });
    processHandle.stdout?.setEncoding('utf8');
    processHandle.stdout?.on('data', (data) => {
      this.logger.info({ data }, 'WindBot');
    });
    processHandle.stderr?.setEncoding('utf8');
    processHandle.stderr?.on('data', (data) => {
      this.logger.warn({ data }, 'WindBot Error');
    });
  }

  private respawnWindbot() {
    if (this.stopping) {
      return;
    }
    if (this.loopLimit >= this.maxLoopLimit) {
      return;
    }
    this.loopLimit += 1;
    this.spawnWindbot();
  }

  private stop() {
    this.stopping = true;
    if (this.windbotProcess) {
      this.windbotProcess.kill();
      this.windbotProcess = null;
    }
  }
}
