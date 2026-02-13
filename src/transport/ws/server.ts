import { IncomingMessage, createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { Server as WebSocketServer } from 'ws';
import { Context } from '../../app';
import { ClientHandler } from '../../client/client-handler';
import { SSLFinder } from '../../services/ssl-finder';
import { WsClient } from './client';
import { WebSocket } from 'ws';
import { IpResolver } from '../../services/ip-resolver';

export class WsServer {
  private wss?: WebSocketServer;
  private httpServer?: ReturnType<
    typeof createHttpServer | typeof createHttpsServer
  >;
  private logger = this.ctx.createLogger('WsServer');

  constructor(private ctx: Context) {}

  async init(): Promise<void> {
    const wsPort = this.ctx.getConfig('WS_PORT', '0');
    if (!wsPort || wsPort === '0') {
      this.logger.info(
        'WS_PORT not configured, WebSocket server will not start',
      );
      return;
    }

    const host = this.ctx.getConfig('HOST', '::');
    const portNum = parseInt(wsPort, 10);

    // Try to get SSL configuration
    const sslFinder = this.ctx.get(() => SSLFinder);
    const sslOptions = sslFinder.findSSL();

    if (sslOptions) {
      this.logger.info(
        'SSL configuration found, starting HTTPS WebSocket server',
      );
      this.httpServer = createHttpsServer(sslOptions);
    } else {
      this.logger.info('No SSL configuration, starting HTTP WebSocket server');
      this.httpServer = createHttpServer();
    }

    this.wss = new WebSocketServer({ server: this.httpServer });

    this.wss.on('connection', (ws, req) => {
      this.handleConnection(ws, req);
    });

    await new Promise<void>((resolve, reject) => {
      this.httpServer!.listen(portNum, host, () => {
        this.logger.info(
          { host, port: portNum, secure: !!sslOptions },
          'WebSocket server listening',
        );
        resolve();
      });

      this.httpServer!.on('error', (err) => {
        this.logger.error({ err }, 'WebSocket server error');
        reject(err);
      });
    });
  }

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const client = new WsClient(this.ctx, ws, req);
    if (this.ctx.get(() => IpResolver).setClientIp(client, client.xffIp()))
      return;
    client.hostname = req.headers.host?.split(':')[0] || '';
    const handler = this.ctx.get(() => ClientHandler);
    handler.handleClient(client).catch((err) => {
      this.logger.error({ err }, 'Error handling client');
    });
  }

  async stop(): Promise<void> {
    if (this.wss) {
      this.wss.close();
    }

    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => {
          this.logger.info('WebSocket server closed');
          resolve();
        });
      });
    }
  }
}
