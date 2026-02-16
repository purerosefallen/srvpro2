import { CacheKey } from 'aragami';
import { Context } from '../app';
import { Client } from './client';
import * as ipaddr from 'ipaddr.js';
import { YGOProCtosDisconnect } from '../utility/ygopro-ctos-disconnect';

const IP_RESOLVER_TTL = 24 * 60 * 60 * 1000;

class ConnectedIpCountCache {
  @CacheKey()
  ip!: string;

  count = 0;
}

class BadIpCountCache {
  @CacheKey()
  ip!: string;

  count = 0;
}

export class IpResolver {
  private logger = this.ctx.createLogger('IpResolver');
  private trustedProxies: Array<[ipaddr.IPv4 | ipaddr.IPv6, number]> = [];

  constructor(private ctx: Context) {
    const proxies = this.ctx.config.getStringArray('TRUSTED_PROXIES');

    for (const trusted of proxies) {
      try {
        this.trustedProxies.push(ipaddr.parseCIDR(trusted));
      } catch (e: any) {
        this.logger.warn(
          { trusted, err: e.message },
          'Failed to parse trusted proxy',
        );
      }
    }

    this.logger.info(
      { count: this.trustedProxies.length },
      'Trusted proxies initialized',
    );

    this.ctx.middleware(YGOProCtosDisconnect, async (_msg, client, next) => {
      await this.releaseClientIp(client);
      return next();
    });
  }

  toIpv4(ip: string): string {
    if (ip.startsWith('::ffff:')) {
      return ip.slice(7);
    }
    return ip;
  }

  toIpv6(ip: string): string {
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) {
      return '::ffff:' + ip;
    }
    return ip;
  }

  isTrustedProxy(ip: string): boolean {
    if (ip.startsWith('::ffff:')) {
      ip = this.toIpv4(ip);
    }
    try {
      const addr = ipaddr.parse(ip);
      return this.trustedProxies.some(([range, mask]) => {
        return addr.match(range, mask);
      });
    } catch {
      return false;
    }
  }

  getRealIp(physicalIp: string, xffIp?: string): string {
    if (!xffIp || xffIp === physicalIp) {
      return this.toIpv6(physicalIp);
    }
    if (this.isTrustedProxy(physicalIp)) {
      return this.toIpv6(xffIp.split(',')[0].trim());
    }
    this.logger.warn({ physicalIp, xffIp }, 'Untrusted proxy detected');
    return this.toIpv6(physicalIp);
  }

  /**
   * Set client IP and check if client should be rejected
   * @param client The client instance
   * @param xffIp Optional X-Forwarded-For IP
   * @returns true if client should be rejected (bad IP or too many connections)
   */
  async setClientIp(client: Client, xffIp?: string): Promise<boolean> {
    const prevIp = client.ip;

    // Priority: passed xffIp > client.xffIp() > client.physicalIp()
    const xff = xffIp;
    const newIp = this.getRealIp(client.physicalIp(), xff);

    client.ip = newIp;

    // If IP hasn't changed, no need to update counts
    if (prevIp === newIp) {
      return false;
    }

    // Decrement count for previous IP
    if (prevIp) {
      const prevCount = await this.getConnectedIpCount(prevIp);
      if (prevCount > 0) {
        await this.setConnectedIpCount(prevIp, prevCount - 1);
      }
    }

    // Check if this is a local IP (127.0.0.1/::1) or in trusted proxies
    const isLocal =
      newIp.includes('127.0.0.1') ||
      newIp.includes('::1') ||
      this.isTrustedProxy(newIp);
    client.isLocal = isLocal;

    // Increment count for new IP
    const noConnectCountLimit = this.ctx.config.getBoolean(
      'NO_CONNECT_COUNT_LIMIT',
    );
    let connectCount = await this.getConnectedIpCount(newIp);

    if (
      !noConnectCountLimit &&
      !isLocal &&
      !client.isInternal &&
      !this.isTrustedProxy(newIp)
    ) {
      connectCount++;
    }
    await this.setConnectedIpCount(newIp, connectCount);

    // Check if IP should be rejected
    const badCount = await this.getBadIpCount(newIp);
    if (badCount > 5 || connectCount > 10) {
      this.logger.info(
        { ip: newIp, badCount, connectCount },
        'Rejecting bad IP',
      );
      client.disconnect();
      return true;
    }

    return false;
  }

  /**
   * Mark an IP as bad (increment bad count)
   * @param ip The IP address to mark as bad
   */
  async addBadIp(ip: string): Promise<void> {
    const currentCount = await this.getBadIpCount(ip);
    await this.setBadIpCount(ip, currentCount + 1);
    this.logger.warn(
      { ip, count: currentCount + 1 },
      'Bad IP count incremented',
    );
  }

  /**
   * Get the current connection count for an IP
   */
  async getConnectedIpCount(ip: string): Promise<number> {
    const data = await this.ctx.aragami.get(ConnectedIpCountCache, ip);
    return data?.count || 0;
  }

  /**
   * Get the bad count for an IP
   */
  async getBadIpCount(ip: string): Promise<number> {
    const data = await this.ctx.aragami.get(BadIpCountCache, ip);
    return data?.count || 0;
  }

  /**
   * Clear all connection counts (useful for testing or maintenance)
   */
  async clearConnectionCounts(): Promise<void> {
    await this.ctx.aragami.clear(ConnectedIpCountCache);
    this.logger.debug('Connection counts cleared');
  }

  /**
   * Clear all bad IP counts (useful for testing or maintenance)
   */
  async clearBadIpCounts(): Promise<void> {
    await this.ctx.aragami.clear(BadIpCountCache);
    this.logger.debug('Bad IP counts cleared');
  }

  private async setConnectedIpCount(ip: string, count: number) {
    if (count <= 0) {
      await this.ctx.aragami.del(ConnectedIpCountCache, ip);
      return;
    }
    await this.ctx.aragami.set(
      ConnectedIpCountCache,
      {
        ip,
        count,
      },
      {
        key: ip,
        ttl: IP_RESOLVER_TTL,
      },
    );
  }

  private async setBadIpCount(ip: string, count: number) {
    if (count <= 0) {
      await this.ctx.aragami.del(BadIpCountCache, ip);
      return;
    }
    await this.ctx.aragami.set(
      BadIpCountCache,
      {
        ip,
        count,
      },
      {
        key: ip,
        ttl: IP_RESOLVER_TTL,
      },
    );
  }

  private async releaseClientIp(client: Client) {
    const ip = client.ip;
    if (!ip) {
      return;
    }
    const currentCount = await this.getConnectedIpCount(ip);
    if (currentCount <= 0) {
      return;
    }
    await this.setConnectedIpCount(ip, currentCount - 1);
  }
}
