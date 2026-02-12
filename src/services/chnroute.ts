import { Context } from '../app';
import * as ipaddr from 'ipaddr.js';

export class Chnroute {
  private logger = this.ctx.createLogger('Chnroute');
  private misakaUrl =
    'https://raw.githubusercontent.com/misakaio/chnroutes2/master/chnroutes.txt';
  private chinaIpRanges: [ipaddr.IPv4, number][] = [];
  private isUpdating = false;
  private retryCount = 0;

  constructor(private ctx: Context) {}

  private async updateChnroute() {
    if (this.isUpdating) return;
    this.isUpdating = true;

    try {
      const { data } = await this.ctx.http.get<string>(this.misakaUrl, {
        responseType: 'text',
        timeout: 3000, // 3 seconds timeout
      });

      const ranges = data
        .trim()
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'));

      this.chinaIpRanges = ranges.map(
        (range) => ipaddr.parseCIDR(range) as [ipaddr.IPv4, number],
      );

      this.logger.info(
        { count: this.chinaIpRanges.length },
        'Update chnroute success',
      );
      this.retryCount = 0;
      this.isUpdating = false;
    } catch (e: any) {
      this.logger.warn({ err: e.message }, 'Update chnroute failed');
      this.isUpdating = false;

      // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 32s, 64s, max 64s
      const delay = Math.min(Math.pow(2, this.retryCount) * 1000, 64000);
      this.retryCount++;

      this.logger.info(
        { retryCount: this.retryCount, delayMs: delay },
        'Scheduling chnroute retry',
      );

      setTimeout(() => {
        this.updateChnroute();
      }, delay);
    }
  }

  /**
   * Check if an IP is in China mainland (excluding HK, MO, TW)
   */
  isChina(ip: string): boolean {
    if (!this.chinaIpRanges.length) {
      return false;
    }

    try {
      // Remove IPv6 prefix if present
      if (ip.startsWith('::ffff:')) {
        ip = ip.slice(7);
      }

      const addr = ipaddr.parse(ip);

      // Only check IPv4 addresses
      if (addr.kind() !== 'ipv4') {
        return false;
      }

      // Check if IP matches any China IP range
      return this.chinaIpRanges.some(([range, mask]) => {
        return (addr as ipaddr.IPv4).match(range, mask);
      });
    } catch {
      return false;
    }
  }

  /**
   * Check if an IP is private/local
   */
  isPrivate(ip: string): boolean {
    try {
      // Remove IPv6 prefix if present
      if (ip.startsWith('::ffff:')) {
        ip = ip.slice(7);
      }

      const addr = ipaddr.parse(ip);

      // Check for loopback
      if (addr.toString() === '::1' || addr.toString() === '127.0.0.1') {
        return true;
      }

      // Check if it's in private range
      const range = addr.range();
      return range === 'private' || range === 'loopback';
    } catch {
      return false;
    }
  }

  /**
   * Get locale based on IP address
   * Returns 'zh-CN' for China mainland IPs and private IPs
   * Returns 'en-US' for all other IPs
   */
  getLocale(ip: string): 'zh-CN' | 'en-US' {
    // Private/local IPs are considered zh-CN
    if (this.isPrivate(ip)) {
      return 'zh-CN';
    }

    // China mainland IPs are zh-CN
    if (this.isChina(ip)) {
      return 'zh-CN';
    }

    // All other IPs are en-US
    return 'en-US';
  }

  async init() {
    this.updateChnroute().then();
  }
}
