import * as ipaddr from 'ipaddr.js';
import { IpRange, isIpInRanges } from '../src/utility';

describe('isIpInRanges', () => {
  const ranges: IpRange[] = [
    ipaddr.parseCIDR('127.0.0.0/8'),
    ipaddr.parseCIDR('::1/128'),
    ipaddr.parseCIDR('172.16.0.0/12'),
    ipaddr.parseCIDR('10.198.0.0/16'),
  ];

  test('continues past a range from another address family', () => {
    expect(isIpInRanges('172.18.0.21', ranges)).toBe(true);
    expect(isIpInRanges('10.198.12.34', ranges)).toBe(true);
  });

  test('matches IPv6 ranges in a mixed list', () => {
    expect(isIpInRanges('::1', ranges)).toBe(true);
  });

  test('rejects addresses outside the ranges and invalid input', () => {
    expect(isIpInRanges('192.168.1.1', ranges)).toBe(false);
    expect(isIpInRanges('not-an-ip', ranges)).toBe(false);
  });
});
