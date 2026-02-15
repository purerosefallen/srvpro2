import yaml from 'yaml';
import * as fs from 'node:fs';
import { DefaultHostinfo } from './room/default-hostinfo';
import { Configurer } from 'nfkit';

export type HostinfoOptions = {
  [K in keyof typeof DefaultHostinfo as `HOSTINFO_${Uppercase<K>}`]: string;
};

export const defaultConfig = {
  // Bind address. Use '::' to listen on all IPv4/IPv6 interfaces.
  HOST: '::',
  // Main server port for YGOPro clients. Format: integer string.
  PORT: '7911',
  // Redis connection URL. Format: URL string. Empty means disabled.
  REDIS_URL: '',
  // Log level. Format: lowercase string (e.g. info/debug/warn/error).
  LOG_LEVEL: 'info',
  // WebSocket port. Format: integer string. '0' means do not open a separate WS port.
  WS_PORT: '0',
  // Enable SSL for WebSocket server.
  // Boolean parse rule (default false): ''/'0'/'false'/'null' => false, otherwise true.
  ENABLE_SSL: '0',
  // SSL certificate directory path. Format: filesystem path string.
  SSL_PATH: './ssl',
  // SSL certificate file name. Format: file name string.
  SSL_CERT: '',
  // SSL private key file name. Format: file name string.
  SSL_KEY: '',
  // Trusted proxies for real IP parsing. Format: comma-separated CIDR list.
  TRUSTED_PROXIES: '127.0.0.0/8,::1/128',
  // Disable per-IP connection count limit.
  // Boolean parse rule (default false): ''/'0'/'false'/'null' => false, otherwise true.
  NO_CONNECT_COUNT_LIMIT: '',
  // Restrict accepted YGOPro version. Format: version string; empty means no restriction.
  YGOPRO_VERSION: '0x1362',
  // Additional accepted versions. Format: comma-separated version strings.
  ALT_VERSIONS: '2330,2331',
  // Proxy URL for outbound HTTP(S) requests.
  // Format: proxy URL string (e.g. http://127.0.0.1:7890). Empty means no proxy.
  USE_PROXY: '',
  // YGOPro resource directory (scripts, DB, etc.). Format: filesystem path string.
  YGOPRO_PATH: './ygopro',
  // Extra script directory. Format: filesystem path string. Empty means disabled.
  EXTRA_SCRIPT_PATH: '',
  // Main deck minimum size. Format: integer string.
  DECK_MAIN_MIN: '40',
  // Main deck maximum size. Format: integer string.
  DECK_MAIN_MAX: '60',
  // Extra deck maximum size. Format: integer string.
  DECK_EXTRA_MAX: '15',
  // Side deck maximum size. Format: integer string.
  DECK_SIDE_MAX: '15',
  // Max copies per card name. Format: integer string.
  DECK_MAX_COPIES: '3',
  // Enable ocgcore debug logs.
  // Boolean parse rule (default false): ''/'0'/'false'/'null' => false, otherwise true.
  OCGCORE_DEBUG_LOG: '0',
  // OCGCore wasm file path. Format: filesystem path string. Empty means use default wasm loading.
  OCGCORE_WASM_PATH: '',
  // Welcome message sent when players join. Format: plain string.
  WELCOME: '',
  // Enable windbot feature.
  // Boolean parse rule (default true): only '0'/'false'/'null' => false, otherwise true.
  ENABLE_WINDBOT: '0',
  // Windbot bot list path. Format: filesystem path string.
  WINDBOT_BOTLIST: './windbot/bots.json',
  // Spawn built-in windbot server mode process.
  // Effective only when ENABLE_WINDBOT is true.
  // Boolean parse rule (default false): ''/'0'/'false'/'null' => false, otherwise true.
  WINDBOT_SPAWN: '0',
  // Windbot HTTP endpoint. Format: URL string.
  WINDBOT_ENDPOINT: 'http://127.0.0.1:2399',
  // Public IP/host that windbot uses to connect back to this server.
  WINDBOT_MY_IP: '127.0.0.1',
  // Enable reconnect feature.
  // Boolean parse rule (default true): only '0'/'false'/'null' => false, otherwise true.
  // Note: with default-true parsing, empty string is treated as true.
  ENABLE_RECONNECT: '1',
  // Reconnect timeout after disconnect. Format: integer string in milliseconds (ms).
  RECONNECT_TIMEOUT: '180000',
  // Room hostinfo defaults expanded into HOSTINFO_* keys.
  // Format: each HOSTINFO_* value is a string; numeric fields use integer strings.
  // Unit note: HOSTINFO_TIME_LIMIT is in seconds (s).
  ...(Object.fromEntries(
    Object.entries(DefaultHostinfo).map(([key, value]) => [
      `HOSTINFO_${key.toUpperCase()}`,
      value.toString(),
    ]),
  ) as HostinfoOptions),
};

export const configurer = new Configurer(defaultConfig);

export function loadConfig() {
  let readConfig: Record<string, unknown> = {};
  try {
    const configText = fs.readFileSync('./config.yaml', 'utf-8');
    const parsed = yaml.parse(configText);
    if (parsed && typeof parsed === 'object') {
      readConfig = parsed;
    }
  } catch (e) {
    console.error(`Failed to read config: ${e.toString()}`);
  }

  return configurer.loadConfig({
    obj: readConfig,
    env: process.env,
  });
}
