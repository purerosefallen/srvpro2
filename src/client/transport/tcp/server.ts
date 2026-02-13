import { Server as NetServer, Socket, createServer } from 'node:net';
import { Context } from '../../../app';
import { ClientHandler } from '../../client-handler';
import { TcpClient } from './client';

export class TcpServer {
  private server?: NetServer;
  private logger = this.ctx.createLogger('TcpServer');

  constructor(private ctx: Context) {}

  async init(): Promise<void> {
    const port = this.ctx.getConfig('PORT', '0');
    if (!port || port === '0') {
      this.logger.info('PORT not configured, TCP server will not start');
      return;
    }

    const host = this.ctx.getConfig('HOST', '::');
    const portNum = parseInt(port, 10);

    this.server = createServer((socket) => {
      this.handleConnection(socket);
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(portNum, host, () => {
        this.logger.info({ host, port: portNum }, 'TCP server listening');
        resolve();
      });

      this.server!.on('error', (err) => {
        this.logger.error({ err }, 'TCP server error');
        reject(err);
      });
    });
  }

  private handleConnection(socket: Socket): void {
    const client = new TcpClient(this.ctx, socket);
    const handler = this.ctx.get(() => ClientHandler);
    handler.handleClient(client).catch((err) => {
      this.logger.error({ err }, 'Error handling client');
    });
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    await new Promise<void>((resolve) => {
      this.server!.close(() => {
        this.logger.info('TCP server closed');
        resolve();
      });
    });
  }
}
