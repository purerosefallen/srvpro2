import * as ipaddr from 'ipaddr.js';

export type IpRange = [ipaddr.IPv4 | ipaddr.IPv6, number];

export function isIpInRanges(ip: string, ranges: readonly IpRange[]): boolean {
  try {
    const address = ipaddr.parse(ip);
    return ranges.some(
      ([range, mask]) =>
        address.kind() === range.kind() && address.match(range, mask),
    );
  } catch {
    return false;
  }
}
