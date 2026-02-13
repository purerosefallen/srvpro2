import { Socket } from 'node:net';
import { Observable, fromEvent, merge } from 'rxjs';
import { map, take } from 'rxjs/operators';
import { Context } from '../../app';
import { Client } from '../../client/client';

export class TcpClient extends Client {
  constructor(
    ctx: Context,
    private sock: Socket,
  ) {
    super(ctx);
  }

  protected _send(data: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sock.write(data, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  protected _receive(): Observable<Buffer> {
    return fromEvent<Buffer>(this.sock, 'data');
  }

  protected async _disconnect(): Promise<void> {
    if (this.sock.destroyed) {
      return;
    }
    return new Promise((resolve) => {
      this.sock.once('close', () => resolve());
      this.sock.end();
    });
  }

  protected _onDisconnect(): Observable<void> {
    return merge(
      fromEvent<void>(this.sock, 'close'),
      fromEvent<Error>(this.sock, 'error').pipe(map(() => undefined)),
    ).pipe(take(1));
  }

  physicalIp(): string {
    return this.sock.remoteAddress ?? '';
  }

  xffIp(): string | undefined {
    return undefined;
  }
}
