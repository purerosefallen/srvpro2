import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { Observable, fromEvent, merge } from 'rxjs';
import { map, take } from 'rxjs/operators';
import WebSocket, { RawData } from 'ws';
import { Context } from '../../../app';
import { Client } from '../../client';

export class WsClient extends Client {
  constructor(
    ctx: Context,
    private sock: WebSocket,
    private req?: IncomingMessage,
  ) {
    super(ctx);
  }

  protected _send(data: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sock.send(data, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  protected _receive(): Observable<Buffer> {
    return new Observable<Buffer>((subscriber) => {
      const handler = (data: RawData, isBinary: boolean) => {
        if (!isBinary) {
          return;
        }
        if (Buffer.isBuffer(data)) {
          subscriber.next(data);
        } else if (Array.isArray(data)) {
          subscriber.next(Buffer.concat(data));
        } else {
          subscriber.next(Buffer.from(data));
        }
      };

      this.sock.on('message', handler);

      return () => {
        this.sock.off('message', handler);
      };
    });
  }

  protected async _disconnect(): Promise<void> {
    if (this.sock.readyState === WebSocket.CLOSED) {
      return;
    }
    return new Promise((resolve) => {
      this.sock.once('close', () => resolve());
      this.sock.close();
    });
  }

  protected _onDisconnect(): Observable<void> {
    return merge(
      fromEvent<void>(this.sock, 'close'),
      fromEvent<Error>(this.sock, 'error').pipe(map(() => undefined)),
    ).pipe(take(1));
  }

  physicalIp(): string {
    return (
      this.req?.socket.remoteAddress ??
      (this.sock as WebSocket & { _socket?: Socket })._socket?.remoteAddress ??
      ''
    );
  }

  xffIp(): string | undefined {
    const xff = this.req?.headers['x-forwarded-for'];
    if (!xff) {
      return undefined;
    }
    if (Array.isArray(xff)) {
      return xff[0];
    }
    return xff;
  }
}
