import { EventEmitter } from 'node:events';
import { connect, Socket } from 'node:net';
import {
  NetPlayerType,
  YGOProCtosBase,
  YGOProCtosExternalAddress,
  YGOProCtosHsToObserver,
  YGOProCtosJoinGame,
  YGOProCtosPlayerInfo,
  YGOProStocErrorMsg,
  YGOProStocChat,
  YGOProStocReplay,
  YGOProStocTypeChange,
} from 'ygopro-msg-encode';

import { PacketReader } from './packet-reader.cjs';
export { PacketReader };

export async function waitUntil(
  description: string,
  condition: () => boolean,
  timeoutMs = 30_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export type ReplayReceipt = { packets: number; bytes: number };

/** A spectator is a protocol client, with no WindBot or game-playing behavior. */
export class MycardProtocolClient extends EventEmitter {
  readonly replay: ReplayReceipt = { packets: 0, bytes: 0 };
  replayHints = 0;
  position: number | undefined;
  closed = false;
  private socket: Socket | undefined;
  private protocolError: string | undefined;

  constructor(public readonly username: string) {
    super();
  }

  async join(host: string, port: number, version: number, password: string) {
    const reader = new PacketReader((packet) => this.receivePacket(packet));
    this.socket = connect({ host, port });
    this.socket.on('data', (data: Buffer) => reader.receive(data));
    this.socket.on('error', (error) => {
      this.protocolError = error.message;
    });
    this.socket.on('close', () => {
      this.closed = true;
    });
    await new Promise<void>((resolve, reject) => {
      this.socket!.once('connect', resolve);
      this.socket!.once('error', reject);
    });
    this.send(new YGOProCtosExternalAddress().fromPartial({ hostname: host }));
    this.send(new YGOProCtosPlayerInfo().fromPartial({ name: this.username }));
    this.send(
      new YGOProCtosJoinGame().fromPartial({ version, pass: password }),
    );
    await waitUntil(`room entry for ${this.username}`, () => {
      this.assertHealthy();
      return this.position != null;
    });
    if (this.position !== NetPlayerType.OBSERVER) {
      this.send(new YGOProCtosHsToObserver());
      await waitUntil(`observer position for ${this.username}`, () => {
        this.assertHealthy();
        return this.position === NetPlayerType.OBSERVER;
      });
    }
  }

  close() {
    this.socket?.destroy();
  }

  private send(message: YGOProCtosBase) {
    this.socket!.write(Buffer.from(message.toFullPayload()));
  }

  private assertHealthy() {
    if (this.protocolError) {
      throw new Error(`${this.username}: ${this.protocolError}`);
    }
    if (this.closed) {
      throw new Error(`${this.username}: disconnected before observer entry`);
    }
  }

  private receivePacket(packet: Buffer) {
    const identifier = packet[2];
    if (identifier === YGOProStocTypeChange.identifier) {
      const message = new YGOProStocTypeChange().fromFullPayload(packet);
      this.position = message.playerPosition;
    } else if (identifier === YGOProStocReplay.identifier) {
      this.replay.packets++;
      this.replay.bytes += packet.length;
    } else if (identifier === YGOProStocChat.identifier) {
      const message = new YGOProStocChat().fromFullPayload(packet);
      if (
        message.msg.includes('Sending the replay of the duel number ') ||
        message.msg.includes('正在发送第')
      ) {
        this.replayHints++;
      }
    } else if (identifier === YGOProStocErrorMsg.identifier) {
      const message = new YGOProStocErrorMsg().fromFullPayload(packet);
      this.protocolError = `server error ${message.msg}/${message.code}`;
    }
    this.emit('packet', packet);
  }
}
