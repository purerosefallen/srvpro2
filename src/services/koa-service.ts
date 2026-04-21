import Koa from 'koa';
import Router from '@koa/router';
import * as ipaddr from 'ipaddr.js';
import { IncomingMessage, Server as HttpServer, createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { SSLFinder } from './ssl-finder';
import { AppContext } from 'nfkit';
import { ConfigService } from './config';
import { Logger } from './logger';

type ProxyRange = [ipaddr.IPv4 | ipaddr.IPv6, number];

export class KoaService {
  koa = new Koa();
  router = new Router();

  private config = this.ctx.get(() => ConfigService).config;
  private logger = this.ctx.get(() => Logger).createLogger('KoaService');
  private server?: HttpServer;
  private trustedProxies: ProxyRange[] = [];

  constructor(private ctx: AppContext) {
    this.initTrustedProxies();

    this.koa.use(async (ctx, next) => {
      ctx.set('Access-Control-Allow-Origin', '*');
      ctx.set('Access-Control-Allow-Private-Network', 'true');
      ctx.set(
        'Vary',
        'Origin, Access-Control-Request-Headers, Access-Control-Request-Method',
      );
      if ((ctx.method || '').toUpperCase() === 'OPTIONS') {
        const requestHeaders =
          ctx.request.headers['access-control-request-headers'];
        const allowHeaders = Array.isArray(requestHeaders)
          ? requestHeaders.join(', ')
          : requestHeaders || '*';
        ctx.status = 204;
        ctx.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
        ctx.set('Access-Control-Allow-Headers', allowHeaders);
        ctx.set('Access-Control-Max-Age', '86400');
        return;
      }
      return next();
    });

    this.koa.use(async (ctx, next) => {
      const req = ctx.req as IncomingMessage;
      const physicalIp = req.socket.remoteAddress || '';
      const xffRaw = ctx.request.headers['x-forwarded-for'];
      const xff = Array.isArray(xffRaw) ? xffRaw[0] : xffRaw;
      ctx.state.realIp = this.getRealIp(physicalIp, xff);
      return next();
    });

    this.koa.use(async (ctx, next) => {
      await next();

      if (ctx.state.disableJsonp) {
        return;
      }
      const callback = String(ctx.query.callback || '').trim();
      if (!callback || ctx.body == null) {
        return;
      }

      if (
        Buffer.isBuffer(ctx.body) ||
        ctx.body instanceof Uint8Array ||
        typeof (ctx.body as any).pipe === 'function'
      ) {
        return;
      }

      const payload = JSON.stringify(ctx.body);
      ctx.type = 'application/javascript; charset=utf-8';
      // Keep srvpro-dash compatibility: some old callbacks read global `data`.
      ctx.body = `window.data=${payload};${callback}(window.data);`;
    });

    this.koa.use(this.router.routes());
    this.koa.use(this.router.allowedMethods());
  }

  async init() {
    const port = this.config.getInt('API_PORT');
    if (!port) {
      this.logger.info(
        'API_PORT not configured, Legacy API server not started',
      );
      return;
    }

    const host =
      this.config.getString('API_HOST') || this.config.getString('HOST');

    const sslOptions = this.ctx.get(() => SSLFinder).findSSL();
    if (sslOptions) {
      this.server = createHttpsServer(sslOptions, this.koa.callback());
      this.logger.info('SSL configuration found, starting HTTPS Legacy API');
    } else {
      this.server = createServer(this.koa.callback());
      this.logger.info('No SSL configuration, starting HTTP Legacy API');
    }

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(port, host, () => {
        this.logger.info(
          {
            host,
            port,
            secure: !!sslOptions,
            trustedProxyCount: this.trustedProxies.length,
          },
          'Legacy API server listening',
        );
        resolve();
      });
      this.server!.on('error', reject);
    });
  }

  async stop() {
    if (!this.server) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.server!.close(() => {
        this.logger.info('Legacy API server closed');
        resolve();
      });
    });
  }

  getHttpServer() {
    return this.server;
  }

  private initTrustedProxies() {
    const proxies = this.config.getStringArray('TRUSTED_PROXIES');
    for (const trusted of proxies) {
      try {
        this.trustedProxies.push(ipaddr.parseCIDR(trusted));
      } catch (e: any) {
        this.logger.warn(
          { trusted, err: e.message },
          'Failed to parse trusted proxy for KoaService',
        );
      }
    }
  }

  private isTrustedProxy(ip: string): boolean {
    try {
      const normalized = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
      const addr = ipaddr.parse(normalized);
      return this.trustedProxies.some(([range, mask]) =>
        addr.match(range, mask),
      );
    } catch {
      return false;
    }
  }

  private toIpv6(ip: string): string {
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) {
      return `::ffff:${ip}`;
    }
    return ip;
  }

  private getRealIp(physicalIp: string, xffIp?: string): string {
    if (!xffIp || xffIp === physicalIp) {
      return this.toIpv6(physicalIp);
    }
    if (this.isTrustedProxy(physicalIp)) {
      return this.toIpv6(xffIp.split(',')[0].trim());
    }
    return this.toIpv6(physicalIp);
  }
}
