import assert from 'node:assert/strict';
import { ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createServer, Server, Socket, connect } from 'node:net';
import { dirname } from 'node:path';
import {
  YGOProCtosHsStart,
  YGOProCtosSurrender,
  YGOProMsgStart,
  YGOProStocGameMsg,
  YGOProStocReplay,
  YGOProStocTypeChange,
} from 'ygopro-msg-encode';
import {
  PacketReader,
  ReplayReceipt,
  waitUntil,
} from './mycard-protocol-client';

/** Runs an unchanged WindBot behind a packet-counting, controllable TCP proxy. */
export class MycardWindbotPlayer extends EventEmitter {
  readonly replay: ReplayReceipt = { packets: 0, bytes: 0 };
  readonly duelLog: string[] = [];
  gameStarts = 0;
  closed = false;
  private position: number | undefined;
  private proxy: Server | undefined;
  private bot: ChildProcess | undefined;
  private botSocket: Socket | undefined;
  private serverSocket: Socket | undefined;
  private queuedStart: Buffer | undefined;
  private queuedPackets: Buffer[] = [];
  private allowStart = false;
  private pauseAfterGameStart = true;
  private gamePacketsPaused = false;
  private connectionError: string | undefined;

  constructor(public readonly username: string) {
    super();
  }

  async join(options: {
    host: string;
    port: number;
    version: number;
    password: string;
    executable: string;
    deck: string;
  }) {
    this.proxy = createServer((socket) => {
      this.botSocket = socket;
      this.serverSocket = connect({ host: options.host, port: options.port });
      const clientReader = new PacketReader((packet) => {
        if (packet[2] === YGOProCtosHsStart.identifier && !this.allowStart) {
          this.queuedStart = packet;
          return;
        }
        this.serverSocket!.write(packet);
      });
      const serverReader = new PacketReader((packet) =>
        this.receivePacket(packet),
      );
      socket.on('data', (data: Buffer) => clientReader.receive(data));
      this.serverSocket.on('data', (data: Buffer) =>
        serverReader.receive(data),
      );
      this.serverSocket.on('close', () => {
        this.closed = true;
        socket.end();
      });
      this.serverSocket.on('error', (error) => {
        this.connectionError = error.message;
      });
      socket.on('error', (error) => {
        this.connectionError = error.message;
      });
      socket.on('close', () => this.serverSocket?.destroy());
    });
    await new Promise<void>((resolve) =>
      this.proxy!.listen(0, '127.0.0.1', resolve),
    );
    const address = this.proxy.address();
    assert.ok(address && typeof address === 'object');
    this.bot = spawn(
      'mono',
      [
        options.executable,
        `Name=${this.username}`,
        'Host=127.0.0.1',
        `Port=${address.port}`,
        `Version=${options.version}`,
        `HostInfo=${options.password}`,
        `Deck=${options.deck}`,
        'Chat=false',
      ],
      { cwd: dirname(options.executable), stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let pendingLog = '';
    this.bot.stdout!.on('data', (chunk: Buffer) => {
      pendingLog += chunk.toString();
      const lines = pendingLog.split('\n');
      pendingLog = lines.pop() || '';
      for (const line of lines) {
        if (
          line.includes('Duel started:') ||
          line.includes('Duel finished against')
        ) {
          this.duelLog.push(line.trim());
        }
      }
    });
    this.bot.stderr!.on('data', () => {});
    this.bot.on('error', (error) => {
      this.connectionError = error.message;
    });
    await waitUntil(`WindBot player entry for ${this.username}`, () => {
      if (this.connectionError) {
        throw new Error(this.connectionError);
      }
      if (this.closed) {
        throw new Error(
          `WindBot player ${this.username} disconnected during entry`,
        );
      }
      return this.position != null;
    });
    assert.ok(this.position! < 4, 'WindBot must join as a duelist');
  }

  async startDuel() {
    await waitUntil('host start request', () => !!this.queuedStart);
    this.allowStart = true;
    this.serverSocket!.write(this.queuedStart!);
    this.queuedStart = undefined;
    await waitUntil('first game start', () => this.gameStarts > 0);
  }

  resumeGame() {
    this.pauseAfterGameStart = false;
    this.gamePacketsPaused = false;
    for (const packet of this.queuedPackets) {
      this.botSocket!.write(packet);
    }
    this.queuedPackets = [];
  }

  surrender() {
    this.serverSocket!.write(
      Buffer.from(new YGOProCtosSurrender().toFullPayload()),
    );
  }

  async close() {
    this.botSocket?.destroy();
    this.serverSocket?.destroy();
    this.bot?.kill('SIGTERM');
    if (this.proxy) {
      await new Promise<void>((resolve) => this.proxy!.close(() => resolve()));
    }
  }

  private receivePacket(packet: Buffer) {
    if (packet[2] === YGOProStocTypeChange.identifier) {
      this.position = new YGOProStocTypeChange().fromFullPayload(
        packet,
      ).playerPosition;
    }
    if (packet[2] === YGOProStocReplay.identifier) {
      this.replay.packets++;
      this.replay.bytes += packet.length;
    }
    const startsGame =
      packet[2] === YGOProStocGameMsg.identifier &&
      packet[3] === YGOProMsgStart.identifier;
    if (startsGame) {
      this.gameStarts++;
      this.emit('gameStart');
    }
    if (this.gamePacketsPaused) {
      this.queuedPackets.push(packet);
      return;
    }
    this.botSocket!.write(packet);
    if (startsGame && this.pauseAfterGameStart) {
      this.gamePacketsPaused = true;
    }
  }
}
