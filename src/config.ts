import yaml from 'yaml';
import * as fs from 'node:fs';
import { DefaultHostinfo } from './room/default-hostinfo';
import { Prettify } from 'nfkit';

export type HostinfoOptions = {
  [K in keyof typeof DefaultHostinfo as `HOSTINFO_${Uppercase<K>}`]: string;
};

export const defaultConfig = {
  HOST: '::',
  PORT: '7911',
  REDIS_URL: '',
  LOG_LEVEL: 'info',
  WS_PORT: '0',
  SSL_PATH: '',
  SSL_CERT: '',
  SSL_KEY: '',
  TRUSTED_PROXIES: '127.0.0.0/8,::1/128',
  NO_CONNECT_COUNT_LIMIT: '',
  ALT_VERSIONS: '',
  USE_PROXY: '',
  YGOPRO_PATH: './ygopro',
  EXTRA_SCRIPT_PATH: '',
  ...(Object.fromEntries(
    Object.entries(DefaultHostinfo).map(([key, value]) => [
      `HOSTINFO_${key.toUpperCase()}`,
      value.toString(),
    ]),
  ) as HostinfoOptions),
};

export type Config = Prettify<typeof defaultConfig & HostinfoOptions>;

export function loadConfig(): Config {
  let readConfig: Partial<Config> = {};
  try {
    const configText = fs.readFileSync('./config.yaml', 'utf-8');
    readConfig = yaml.parse(configText);
  } catch (e) {
    console.error(`Failed to read config: ${e.toString()}`);
  }
  return {
    ...defaultConfig,
    ...readConfig,
    ...process.env,
  };
}
