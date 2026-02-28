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
  // Legacy HTTP API bind address. Empty means fallback to HOST.
  API_HOST: '',
  // Legacy HTTP API port. Format: integer string. '0' means disabled.
  API_PORT: '7922',
  // PostgreSQL host. Empty means database disabled.
  DB_HOST: '',
  // PostgreSQL port. Format: integer string.
  DB_PORT: '5432',
  // PostgreSQL username.
  DB_USER: 'postgres',
  // PostgreSQL password.
  DB_PASS: '',
  // PostgreSQL database name.
  DB_NAME: 'srvpro2',
  // Skip schema initialization/synchronize when set to '1'.
  // Boolean parse rule (default false): ''/'0'/'false'/'null' => false, otherwise true.
  DB_NO_INIT: '0',
  // Redis connection URL. Format: URL string. Empty means disabled.
  REDIS_URL: '',
  // Log level. Format: lowercase string (e.g. info/debug/warn/error).
  LOG_LEVEL: 'info',
  // WebSocket server bind host. Empty means fallback to HOST.
  WS_HOST: '',
  // WebSocket port. Format: integer string. '0' means do not open a separate WS port.
  WS_PORT: '7912',
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
  NO_CONNECT_COUNT_LIMIT: '1',
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
  // Enable tips feature.
  // Boolean parse rule (default true): only '0'/'false'/'null' => false, otherwise true.
  ENABLE_TIPS: '1',
  // Remote URL for tips list. Empty means disabled.
  TIPS_GET: '',
  // Remote URL for zh tips list. Empty means disabled.
  TIPS_GET_ZH: '',
  // Use tips_zh for zh users when available.
  // Boolean parse rule (default false): ''/'0'/'false'/'null' => false, otherwise true.
  TIPS_SPLIT_ZH: '0',
  // Prefix for tips messages.
  TIPS_PREFIX: 'Tip: ',
  // Interval for auto tips in non-dueling rooms. Format: integer string in milliseconds (ms). '0' disables.
  TIPS_INTERVAL: '30000',
  // Interval for auto tips in dueling rooms. Format: integer string in milliseconds (ms). '0' disables.
  TIPS_INTERVAL_INGAME: '120000',
  // Enable words feature.
  // Boolean parse rule (default true): only '0'/'false'/'null' => false, otherwise true.
  ENABLE_WORDS: '1',
  // Remote URL for words data. Empty means disabled.
  WORDS_GET: '',
  // Enable dialogues feature.
  // Boolean parse rule (default true): only '0'/'false'/'null' => false, otherwise true.
  ENABLE_DIALOGUES: '1',
  // Remote URL for dialogues.
  DIALOGUES_GET: 'http://mercury233.me/ygosrv233/dialogues.json',
  // Remote URL for custom dialogues. Empty means disabled.
  DIALOGUES_GET_CUSTOM: '',
  // Enable badwords feature.
  // Boolean parse rule (default true): only '0'/'false'/'null' => false, otherwise true.
  ENABLE_BADWORDS: '1',
  // Remote URL for badwords data. Empty means disabled.
  BADWORDS_GET: '',
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
  // Enable chatgpt feature for AI-room chat replies.
  // Boolean parse rule (default false): ''/'0'/'false'/'null' => false, otherwise true.
  ENABLE_CHATGPT: '0',
  // Chat completions API endpoint. Format: URL string.
  CHATGPT_ENDPOINT: 'https://api.openai.com',
  // Chat completions API token.
  CHATGPT_TOKEN: 'sk-xxxx',
  // Chat model.
  CHATGPT_MODEL: 'gpt-4o-mini',
  // Optional system prompt template. Supports {{player}} and {{windbot}} placeholders.
  CHATGPT_SYSTEM_PROMPT:
    '你是{{windbot}}，一名与{{player}}实时互动的游戏对手。玩家当前 locale 是 {{locale}}，你必须始终使用 {{language}} 回复（不要混用其他语言）。你的回复应简短、有趣、贴合当前情境，增强玩家沉浸感。避免冗长解释或重复内容，并且每次回复不能超过100个字。',
  // Token limit used to trim stored conversation context.
  CHATGPT_TOKEN_LIMIT: '12000',
  // Extra request options for chat completions. Format: JSON object string.
  CHATGPT_EXTRA_OPTS: '{}',
  // Enable reconnect feature.
  // Boolean parse rule (default true): only '0'/'false'/'null' => false, otherwise true.
  // Note: with default-true parsing, empty string is treated as true.
  ENABLE_RECONNECT: '1',
  // Enable cloud replay menu entry (R/W pass handling).
  // Boolean parse rule (default true): only '0'/'false'/'null' => false, otherwise true.
  ENABLE_CLOUD_REPLAY: '1',
  // Enable tournament mode compatibility behavior.
  // Boolean parse rule (default false): ''/'0'/'false'/'null' => false, otherwise true.
  TOURNAMENT_MODE: '0',
  // Enable tournament mode deck lock check hook.
  // Boolean parse rule (default true): only '0'/'false'/'null' => false, otherwise true.
  TOURNAMENT_MODE_CHECK_DECK: '1',
  // Enable Challonge integration.
  // Boolean parse rule (default false): ''/'0'/'false'/'null' => false, otherwise true.
  CHALLONGE_ENABLED: '0',
  // Disable challonge room name "M#" prefix and use pure match id as room name.
  // Boolean parse rule (default false): ''/'0'/'false'/'null' => false, otherwise true.
  CHALLONGE_NO_MATCH_MODE: '0',
  // Post detailed match score to Challonge (for example 2-1).
  // Boolean parse rule (default true): only '0'/'false'/'null' => false, otherwise true.
  CHALLONGE_POST_DETAILED_SCORE: '1',
  // Post score at siding stage without winner_id (midduel sync).
  // Boolean parse rule (default true): only '0'/'false'/'null' => false, otherwise true.
  CHALLONGE_POST_SCORE_MIDDUEL: '1',
  // Challonge tournament cache TTL in milliseconds.
  // Format: integer string in milliseconds (ms).
  CHALLONGE_CACHE_TTL: '60000',
  // Challonge API key.
  CHALLONGE_API_KEY: '',
  // Challonge tournament id/slug.
  CHALLONGE_TOURNAMENT_ID: '',
  // Challonge API base URL.
  CHALLONGE_URL: 'https://api.challonge.com',
  // Block replay packets to players who are currently in a room.
  // Boolean parse rule (default false): ''/'0'/'false'/'null' => false, otherwise true.
  BLOCK_REPLAY_TO_PLAYER: '0',
  // Enable room list menu entry (L pass handling).
  // Boolean parse rule (default true): only '0'/'false'/'null' => false, otherwise true.
  ENABLE_ROOMLIST: '1',
  // Reconnect timeout after disconnect. Format: integer string in milliseconds (ms).
  RECONNECT_TIMEOUT: '180000',
  // Hide player name mode in random duel rooms.
  // Format: integer string.
  // 0 = disabled, 1 = hide only at Begin stage, 2 = always hide.
  HIDE_PLAYER_NAME: '0',
  // Enable random duel feature.
  // Boolean parse rule (default false): ''/'0'/'false'/'null' => false, otherwise true.
  ENABLE_RANDOM_DUEL: '1',
  // Random duel modes that can be matched by blank pass.
  // Format: comma-separated mode names. The first item is used as default type.
  RANDOM_DUEL_BLANK_PASS_MODES: 'S,M',
  // Disable rematch checking for random duel.
  // Boolean parse rule (default false): ''/'0'/'false'/'null' => false, otherwise true.
  RANDOM_DUEL_NO_REMATCH_CHECK: '0',
  // Record random match scores (effective only when database is enabled).
  // Boolean parse rule (default false): ''/'0'/'false'/'null' => false, otherwise true.
  RANDOM_DUEL_RECORD_MATCH_SCORES: '1',
  // Disable chat in random duel rooms.
  // Boolean parse rule (default false): ''/'0'/'false'/'null' => false, otherwise true.
  RANDOM_DUEL_DISABLE_CHAT: '0',
  // Random duel ready countdown before kicking the only unready player in Begin stage.
  // Format: integer string in seconds (s). '0' or negative disables the feature.
  RANDOM_DUEL_READY_TIME: '20',
  // Random duel AFK timeout while waiting for player action.
  // Format: integer string in seconds (s). '0' or negative disables the feature.
  RANDOM_DUEL_HANG_TIMEOUT: '90',
  // Side deck timeout in minutes during siding stage.
  // Format: integer string. '0' or negative disables the feature.
  SIDE_TIMEOUT_MINUTES: '3',
  // Room hostinfo defaults expanded into HOSTINFO_* keys.
  // Format: each HOSTINFO_* value is a string; numeric fields use integer strings.
  // Unit note: HOSTINFO_TIME_LIMIT is in seconds (s).
  // Enable blank-pass panel menu.
  // Boolean parse rule (default false): ''/'0'/'false'/'null' => false, otherwise true.
  ENABLE_MENU: '0',
  // Blank-pass panel definition in JSON object format.
  // Format: {"Display Text": "ROOM_PASS"}.
  // - key: text shown to client; supports i18n placeholder like "#{menu_random_duel}".
  // - value(string): equivalent room password, then redispatches CTOS_JOIN_GAME with this pass.
  // - value(object): submenu; empty object {} means "return to previous level".
  MENU: '{"#{menu_random_duel}":"","#{menu_random_duel_match}":"M","#{menu_ai_duel}":"AI","#{menu_more}":{"#{menu_random_duel_single}":"S","#{menu_random_duel_tag}":"T","#{menu_ai_duel_match}":"AI,M","#{menu_ai_duel_tag}":"AI,T","#{menu_return}":{}}}',
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
