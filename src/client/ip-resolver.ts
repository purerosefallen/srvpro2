import { Context } from '../app';
import { Client } from './client';
import * as ipaddr from 'ipaddr.js';
import { convertStringArray } from '../utility/convert-string-array';

export class IpResolver {
  private logger = this.ctx.createLogger('IpResolver');
  private connectedIpCount = new Map<string, number>();
  private badIpCount = new Map<string, number>();
  private trustedProxies: Array<[ipaddr.IPv4 | ipaddr.IPv6, number]> = [];

  constructor(private ctx: Context) {
    const proxies = convertStringArray(
      this.ctx.getConfig('TRUSTED_PROXIES', '127.0.0.0/8,::1/128'),
    );

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
  setClientIp(client: Client, xffIp?: string): boolean {
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
      const prevCount = this.connectedIpCount.get(prevIp) || 0;
      if (prevCount > 0) {
        if (prevCount === 1) {
          this.connectedIpCount.delete(prevIp);
        } else {
          this.connectedIpCount.set(prevIp, prevCount - 1);
        }
      }
    }

    // Check if this is a local IP (127.0.0.1/::1) or in trusted proxies
    const isLocal =
      newIp.includes('127.0.0.1') ||
      newIp.includes('::1') ||
      this.isTrustedProxy(newIp);
    client.isLocal = isLocal;

    // Increment count for new IP
    const noConnectCountLimit = this.ctx.getConfig(
      'NO_CONNECT_COUNT_LIMIT',
      '',
    );
    let connectCount = this.connectedIpCount.get(newIp) || 0;

    if (!noConnectCountLimit && !isLocal && !this.isTrustedProxy(newIp)) {
      connectCount++;
      this.connectedIpCount.set(newIp, connectCount);
    } else {
      this.connectedIpCount.set(newIp, connectCount);
    }

    // Check if IP should be rejected
    const badCount = this.badIpCount.get(newIp) || 0;
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
  addBadIp(ip: string): void {
    const currentCount = this.badIpCount.get(ip) || 0;
    this.badIpCount.set(ip, currentCount + 1);
    this.logger.warn(
      { ip, count: currentCount + 1 },
      'Bad IP count incremented',
    );
  }

  /**
   * Get the current connection count for an IP
   */
  getConnectedIpCount(ip: string): number {
    return this.connectedIpCount.get(ip) || 0;
  }

  /**
   * Get the bad count for an IP
   */
  getBadIpCount(ip: string): number {
    return this.badIpCount.get(ip) || 0;
  }

  /**
   * Clear all connection counts (useful for testing or maintenance)
   */
  clearConnectionCounts(): void {
    this.connectedIpCount.clear();
    this.logger.info('Connection counts cleared');
  }

  /**
   * Clear all bad IP counts (useful for testing or maintenance)
   */
  clearBadIpCounts(): void {
    this.badIpCount.clear();
    this.logger.info('Bad IP counts cleared');
  }
}
