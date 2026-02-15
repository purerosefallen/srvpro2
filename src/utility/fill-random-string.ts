import cryptoRandomString from 'crypto-random-string';

export function fillRandomString(prefix: string, length: number): string {
  if (prefix.length >= length) {
    return prefix;
  }
  return `${prefix}${cryptoRandomString({
    length: length - prefix.length,
    type: 'alphanumeric',
  })}`;
}
