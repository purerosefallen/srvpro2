import crypto from 'node:crypto';
import YGOProDeck from 'ygopro-deck-encode';
import {
  ChatColor,
  YGOProCtosChat,
  YGOProCtosHsToObserver,
} from 'ygopro-msg-encode';
import { Context } from '../../app';
import { Client } from '../../client';
import { BadwordProvider } from '../resource';
import { WaitForPlayerProvider } from '../wait-for-player-provider';
import {
  DefaultHostInfoProvider,
  DuelStage,
  OnRoomFinalize,
  OnRoomGameStart,
  OnRoomJoin,
  OnRoomJoinPlayer,
  OnRoomLeavePlayer,
  OnRoomMatchStart,
  OnRoomWin,
  Room,
  RoomLeavePlayerReason,
  RoomManager,
} from '../../room';
import { OnClientWaitTimeout } from '../random-duel/random-duel-events';
import { ClientRoomField } from '../../utility';
import {
  MycardPasswordPayload,
  decodeMycardPassword,
  resolveHostInfoFromMycardPayload,
} from './password-codec';

type MycardUserResponse = {
  user?: {
    u16Secret?: number;
    u16SecretPrevious?: number;
  };
};

type MycardBanInfo = {
  banned?: boolean;
  until?: string;
  message?: string;
};

type MycardArenaPlayerSnapshot = {
  pos: number;
  key: string;
  name: string;
};

type ArenaScorePlayer = {
  name: string | null;
  key: string;
  score: number;
  deck: string;
  deckHistory: string[];
};

type ArenaScoreSnapshot = {
  roomName: string;
  arena: string;
  start: string;
  end: string;
  firstList: string[];
  replays: string[];
  players: [ArenaScorePlayer, ArenaScorePlayer];
};

declare module '../../client' {
  interface Client {
    mycardBan?: MycardBanInfo;
    mycardArenaJoinTime?: number;
    mycardArenaQuitFree?: boolean;
  }
}

ClientRoomField()(Client.prototype, 'mycardBan');
ClientRoomField()(Client.prototype, 'mycardArenaJoinTime');
ClientRoomField()(Client.prototype, 'mycardArenaQuitFree');

declare module '../../room' {
  interface Room {
    mycard?: boolean;
    mycardPrivate?: boolean;
    mycardTitle?: string;
    mycardArena?: string;
    mycardArenaPlayers?: Record<number, MycardArenaPlayerSnapshot>;
    mycardArenaScores?: Record<string, number>;
    mycardArenaDecks?: Record<string, string>;
    mycardArenaDeckHistory?: Record<string, string[]>;
    mycardArenaStartTime?: string;
    mycardArenaScoreHandled?: boolean;
    mycardArenaFreeQuitHintSent?: boolean;
  }
}

export class MycardService {
  private logger = this.ctx.createLogger(this.constructor.name);
  private arenaFreeQuitGraceTimer?: ReturnType<typeof setInterval>;

  constructor(private ctx: Context) {}

  private get roomManager() {
    return this.ctx.get(() => RoomManager);
  }

  private get hostInfoProvider() {
    return this.ctx.get(() => DefaultHostInfoProvider);
  }

  private get waitForPlayerProvider() {
    return this.ctx.get(() => WaitForPlayerProvider);
  }

  private get badwordProvider() {
    return this.ctx.get(() => BadwordProvider);
  }

  get enabled() {
    return this.ctx.config.getBoolean('MYCARD_ENABLED');
  }

  async init() {
    if (!this.enabled) {
      return;
    }

    await this.callMatchApi('POST', 'clear', {
      arena: this.arenaMode,
    });

    this.ctx.middleware(OnRoomJoin, async (event, client, next) => {
      if (event.room.mycardArena) {
        await this.sendArenaScore(client);
      }
      return next();
    });

    this.ctx.middleware(OnRoomJoinPlayer, async (event, client, next) => {
      if (event.room.mycardArena) {
        this.rememberArenaPlayer(event.room, client);
        client.mycardArenaJoinTime = Date.now();
        client.mycardArenaQuitFree = false;
      }
      return next();
    });

    this.ctx.middleware(OnRoomMatchStart, async (event, _client, next) => {
      if (event.room.mycardArena) {
        this.ensureArenaScoreState(event.room);
        event.room.mycardArenaStartTime ||= this.nowString();
        await this.postArenaRoomStart(event.room);
      }
      return next();
    });

    this.ctx.middleware(OnRoomGameStart, async (event, _client, next) => {
      if (event.room.mycardArena) {
        this.rememberArenaGameDecks(event.room);
      }
      return next();
    });

    this.ctx.middleware(OnRoomWin, async (event, _client, next) => {
      if (event.room.mycardArena) {
        this.updateArenaScoresFromRoomScore(event.room);
      }
      return next();
    });

    this.ctx.middleware(OnRoomLeavePlayer, async (event, client, next) => {
      this.handleArenaPlayerLeave(event, client);
      return next();
    });

    this.ctx.middleware(OnClientWaitTimeout, async (event, _client, next) => {
      if (event.room.mycardArena) {
        this.ensureArenaScoreState(event.room);
        const key = this.getClientKey(event.client);
        event.room.mycardArenaScores![key] = -9;
        event.room.mycardArenaScoreHandled = true;
      }
      return next();
    });

    this.ctx.middleware(OnRoomFinalize, async (event, _client, next) => {
      const snapshot = this.createArenaScoreSnapshot(event.room);
      if (snapshot) {
        this.postScoreSnapshotNonBlocking(snapshot);
      }
      return next();
    });

    this.ctx.middleware(YGOProCtosChat, async (_msg, client, next) => {
      if (!this.isClientBannedByMycard(client)) {
        return next();
      }
      const message = client.mycardBan?.message
        ? `#{banned_chat_tip}: ${client.mycardBan.message}`
        : '#{banned_chat_tip}';
      await client.sendChat(message, ChatColor.RED);
      return;
    });

    this.ctx.middleware(YGOProCtosHsToObserver, async (_msg, client, next) => {
      const room = client.roomName
        ? this.roomManager.findByName(client.roomName)
        : undefined;
      if (!room?.mycardArena) {
        return next();
      }
      await client.sendChat('#{cannot_to_observer}', ChatColor.BABYBLUE);
      return;
    });

    this.waitForPlayerProvider.registerTick({
      roomFilter: (room) => !!room.mycardArena,
      readyTimeoutMs: Math.max(0, this.arenaReadyTime) * 1000,
      hangTimeoutMs: Math.max(0, this.arenaHangTimeout) * 1000,
      longAgoBackoffMs: Math.max(0, this.arenaHangTimeout * 1000 - 19_000),
    });

    this.arenaFreeQuitGraceTimer = setInterval(() => {
      void this.tickArenaFreeQuitGrace().catch((error) => {
        this.logger.warn({ error }, 'Failed to tick arena free quit grace');
      });
    }, 1000);
    this.arenaFreeQuitGraceTimer.unref?.();
  }

  async handleJoinPass(pass: string, client: Client) {
    const normalizedPass = (pass || '').trim();
    if (!this.enabled || !normalizedPass || normalizedPass.startsWith('AI#')) {
      return false;
    }

    await client.sendChat('#{loading_user_info}', ChatColor.BABYBLUE);
    if (normalizedPass.length <= 8) {
      await client.die('#{invalid_password_length}', ChatColor.RED);
      return true;
    }

    const encrypted = Buffer.from(normalizedPass.slice(0, 8), 'base64');
    if (encrypted.length !== 6) {
      await client.die('#{invalid_password_payload}', ChatColor.RED);
      return true;
    }

    this.fetchMycardBan(client);

    const secrets = await this.loadUserSecrets(client);
    if (!secrets) {
      return true;
    }

    const decoded = decodeMycardPassword(normalizedPass, secrets);
    if (decoded.ok === false) {
      await client.die(`#{${decoded.reason}}`, ChatColor.RED);
      return true;
    }

    await this.handleDecodedJoin(normalizedPass, decoded.payload, client);
    return true;
  }

  async callMatchApi(
    method: 'GET' | 'POST',
    path: string,
    params: Record<string, string | number | null | undefined>,
  ) {
    if (!this.matchApiEnabled || !this.matchApiUrl) {
      return null;
    }
    const url = new URL(
      `${this.matchApiUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`,
    );
    url.searchParams.append('ak', this.matchApiAccessKey);
    for (const [key, value] of Object.entries(params)) {
      if (value != null) {
        url.searchParams.append(key, String(value));
      }
    }
    try {
      const { data } = await this.ctx.http.request({
        method,
        url: url.toString(),
        timeout: 30000,
      });
      return data;
    } catch (error) {
      this.logger.warn({ method, path, params, error }, 'MATCH API CALL ERROR');
      return null;
    }
  }

  private get arenaMode() {
    return this.ctx.config.getString('MYCARD_ARENA_MODE') || 'entertain';
  }

  private get arenaAccessKey() {
    return this.ctx.config.getString('MYCARD_ARENA_ACCESS_KEY');
  }

  private get arenaReadyTime() {
    return this.ctx.config.getInt('MYCARD_ARENA_READY_TIME');
  }

  private get arenaHangTimeout() {
    return this.ctx.config.getInt('MYCARD_ARENA_HANG_TIMEOUT');
  }

  private get arenaCheckPermitUrl() {
    return this.ctx.config.getString('MYCARD_ARENA_CHECK_PERMIT');
  }

  private get arenaPostScoreUrl() {
    return this.ctx.config.getString('MYCARD_ARENA_POST_SCORE');
  }

  private get arenaGetScoreUrl() {
    return this.ctx.config.getString('MYCARD_ARENA_GET_SCORE');
  }

  private get arenaGetScoreParam() {
    return (
      this.ctx.config.getString('MYCARD_ARENA_GET_SCORE_PARAM') || 'username'
    );
  }

  private get matchApiEnabled() {
    return (
      this.ctx.config.getBoolean('MYCARD_ARENA_MATCH_API_ENABLED') &&
      !!this.matchApiAccessKey
    );
  }

  private get matchApiUrl() {
    return this.ctx.config.getString('MYCARD_ARENA_MATCH_API_URL');
  }

  private get matchApiAccessKey() {
    return this.ctx.config.getString('MYCARD_ARENA_MATCH_API_ACCESS_KEY');
  }

  private get punishQuitBeforeMatch() {
    return this.ctx.config.getBoolean('MYCARD_ARENA_PUNISH_QUIT_BEFORE_MATCH');
  }

  private getClientKey(client: Pick<Client, 'name' | 'name_vpass'>) {
    return client.name_vpass || client.name || 'undefined';
  }

  private getDisplayNameFromKey(key: string) {
    return key.split('$')[0] || key;
  }

  private nowString() {
    return new Date().toISOString();
  }

  private fetchMycardBan(client: Client) {
    const banGet = this.ctx.config.getString('MYCARD_BAN_GET');
    if (!banGet || client.isLocal || client.isInternal) {
      return;
    }
    void this.ctx.http
      .get<MycardBanInfo>(banGet, {
        params: {
          user: client.name,
        },
      })
      .then(({ data }) => {
        if (data && typeof data === 'object') {
          client.mycardBan = data;
        }
      })
      .catch((error) => {
        this.logger.warn({ error }, 'ban get error');
      });
  }

  private isClientBannedByMycard(client: Client) {
    const ban = client.mycardBan;
    if (!ban?.banned || !ban.until) {
      return false;
    }
    const until = new Date(ban.until).getTime();
    return Number.isFinite(until) && Date.now() < until;
  }

  private async loadUserSecrets(client: Client) {
    const authBaseUrl = this.ctx.config
      .getString('MYCARD_AUTH_BASE_URL')
      .replace(/\/+$/, '');
    const userUrl = `${authBaseUrl}/users/${encodeURIComponent(client.name)}.json`;
    try {
      const { data } = await this.ctx.http.get<MycardUserResponse>(userUrl, {
        responseType: 'json',
        timeout: 4000,
        params: {
          api_key: this.ctx.config.getString('MYCARD_AUTH_KEY'),
        },
      });
      const secrets = [
        data?.user?.u16Secret,
        data?.user?.u16SecretPrevious,
      ].filter((id) => id != null);
      if (!secrets.length) {
        await client.die('#{invalid_password_unauthorized}', ChatColor.RED);
        return undefined;
      }
      return secrets;
    } catch (error) {
      this.logger.warn({ player: client.name, error }, 'READ USER FAIL');
      if (!client.disconnected) {
        await client.die('#{load_user_info_fail}', ChatColor.RED);
      }
      return undefined;
    }
  }

  private async handleDecodedJoin(
    pass: string,
    payload: MycardPasswordPayload,
    client: Client,
  ) {
    switch (payload.action) {
      case 1:
      case 2:
        return this.createMycardRoom(pass, payload, client);
      case 3:
        return this.joinRoomByName(pass.slice(8), client);
      case 4:
        return this.joinArenaRoom(pass, client);
      case 5:
        return this.joinRoomByTitle(this.normalizeTitle(pass.slice(8)), client);
      default:
        return client.die('#{invalid_password_action}', ChatColor.RED);
    }
  }

  private normalizeTitle(title: string) {
    return title.replace(String.fromCharCode(0xfeff), ' ');
  }

  private async createMycardRoom(
    pass: string,
    payload: MycardPasswordPayload,
    client: Client,
  ) {
    const roomName = crypto
      .createHash('md5')
      .update(pass + client.name)
      .digest('base64')
      .slice(0, 10)
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
    if (this.roomManager.findByName(roomName)) {
      return client.die('#{invalid_password_existed}', ChatColor.RED);
    }

    const title = this.normalizeTitle(pass.slice(8));
    if (!(await this.checkRoomTitle(title, client))) {
      return;
    }

    const hostinfo = resolveHostInfoFromMycardPayload(
      payload,
      this.hostInfoProvider.getHostinfo(),
    );
    const room = await this.roomManager.findOrCreateByName(roomName, hostinfo);
    room.mycard = true;
    room.mycardPrivate = payload.action === 2;
    room.mycardTitle = title;
    return room.join(client);
  }

  private async joinRoomByName(roomName: string, client: Client) {
    const room = this.roomManager.findByName(roomName);
    if (!room) {
      return client.die('#{invalid_password_not_found}', ChatColor.RED);
    }
    return room.join(client);
  }

  private async joinRoomByTitle(title: string, client: Client) {
    const room = this.roomManager
      .allRooms()
      .find((item) => item.mycardTitle === title);
    if (!room) {
      return client.die('#{invalid_password_not_found}', ChatColor.RED);
    }
    return room.join(client);
  }

  private async joinArenaRoom(pass: string, client: Client) {
    if (!(await this.checkArenaPermit(pass, client))) {
      return client.die('#{invalid_password_unauthorized}', ChatColor.RED);
    }

    const roomName = `M#${pass.slice(8)}`;
    const room = await this.roomManager.findOrCreateByName(roomName);
    if (room.playingPlayers.some((player) => player.name === client.name)) {
      return client.die('#{invalid_password_unauthorized}', ChatColor.RED);
    }

    room.mycard = true;
    room.mycardPrivate = true;
    room.mycardArena = this.arenaMode;
    room.noHost = true;
    room.welcome =
      room.mycardArena === 'athletic'
        ? '#{athletic_arena_tip}'
        : '#{entertain_arena_tip}';
    this.ensureArenaScoreState(room);

    await this.callMatchApi('POST', 'player-joined', {
      username: client.name,
      arena: room.mycardArena,
      roomname: room.name,
    });
    return room.join(client);
  }

  private async checkArenaPermit(pass: string, client: Client) {
    if (!this.arenaCheckPermitUrl) {
      return true;
    }
    try {
      const { data } = await this.ctx.http.get(this.arenaCheckPermitUrl, {
        responseType: 'json',
        timeout: 3000,
        params: {
          username: client.name,
          password: pass,
          arena: this.arenaMode,
        },
      });
      if (data?.permit === false) {
        return false;
      }
    } catch (error) {
      this.logger.warn({ error }, 'match permit fail');
    }
    return true;
  }

  private async checkRoomTitle(title: string, client: Client) {
    if (!this.badwordProvider.enabled) {
      return true;
    }
    const level = await this.badwordProvider.getBadwordLevel(
      title,
      undefined,
      client,
    );
    if (level <= 0) {
      return true;
    }
    this.logger.warn(
      { level, title, player: client.name, ip: client.ip },
      'Blocked mycard room due to bad room title',
    );
    await client.die(`#{bad_roomname_level${level}}`, ChatColor.RED);
    return false;
  }

  private ensureArenaScoreState(room: Room) {
    room.mycardArenaPlayers ||= {};
    room.mycardArenaScores ||= {};
    room.mycardArenaDecks ||= {};
    room.mycardArenaDeckHistory ||= {};
    for (const player of room.playingPlayers) {
      this.rememberArenaPlayer(room, player);
      const key = this.getClientKey(player);
      room.mycardArenaScores[key] ??= 0;
    }
  }

  private rememberArenaPlayer(room: Room, client: Client) {
    room.mycardArenaPlayers ||= {};
    const key = this.getClientKey(client);
    room.mycardArenaPlayers[client.pos] = {
      pos: client.pos,
      key,
      name: this.getDisplayNameFromKey(key),
    };
  }

  private rememberArenaGameDecks(room: Room) {
    this.ensureArenaScoreState(room);
    for (const player of room.playingPlayers) {
      const deck = player.deck || player.startDeck;
      if (!deck) {
        continue;
      }
      this.rememberArenaGameDeck(room, player, deck);
    }
  }

  private rememberArenaGameDeck(room: Room, client: Client, deck: YGOProDeck) {
    const key = this.getClientKey(client);
    const deckText = deck.toYdkString();
    room.mycardArenaDecks![key] ||= deckText;
    room.mycardArenaDeckHistory![key] ||= [];
    room.mycardArenaDeckHistory![key].push(deckText);
  }

  private updateArenaScoresFromRoomScore(room: Room) {
    this.ensureArenaScoreState(room);
    for (const player of room.playingPlayers) {
      const duelPos = room.getDuelPos(player);
      if (duelPos !== 0 && duelPos !== 1) {
        continue;
      }
      room.mycardArenaScores![this.getClientKey(player)] =
        room.score[duelPos as 0 | 1];
    }
  }

  private async postArenaRoomStart(room: Room) {
    if (!room.mycardArena) {
      return;
    }
    const players = room.playingPlayers.slice(0, 2);
    if (players.length < 2) {
      return;
    }
    await this.callMatchApi('POST', 'room-start', {
      usernameA: players[0].name,
      usernameB: players[1].name,
      roomname: room.name,
      starttime: room.mycardArenaStartTime || this.nowString(),
      arena: room.mycardArena,
    });
  }

  private handleArenaPlayerLeave(event: OnRoomLeavePlayer, client: Client) {
    const room = event.room;
    if (
      !room.mycardArena ||
      event.reason !== RoomLeavePlayerReason.Disconnect ||
      event.bySystem ||
      room.duelStage !== DuelStage.Begin ||
      room.mycardArenaScoreHandled
    ) {
      return;
    }
    this.ensureArenaScoreState(room);
    const snapshots = Object.values(room.mycardArenaPlayers || {});
    const leavingKey = this.getClientKey(client);
    const hadTwoPlayers = snapshots.length >= 2;

    if (
      this.punishQuitBeforeMatch &&
      hadTwoPlayers &&
      !client.mycardArenaQuitFree
    ) {
      for (const snapshot of snapshots) {
        room.mycardArenaScores![snapshot.key] = 0;
      }
      room.mycardArenaScores![leavingKey] = -9;
    } else {
      for (const snapshot of snapshots) {
        room.mycardArenaScores![snapshot.key] = -5;
      }
      if (
        hadTwoPlayers &&
        room.mycardArena === 'athletic' &&
        !client.mycardArenaQuitFree
      ) {
        room.mycardArenaScores![leavingKey] = -9;
      }
    }
    room.mycardArenaScoreHandled = true;
    room.finalize();
  }

  private async tickArenaFreeQuitGrace() {
    const now = Date.now();
    for (const room of this.roomManager.allRooms()) {
      if (!room.mycardArena || room.duelStage !== DuelStage.Begin) {
        continue;
      }
      const activePlayers = room.playingPlayers.filter(
        (player) => !player.disconnected,
      );
      if (activePlayers.length !== 1) {
        room.mycardArenaFreeQuitHintSent = false;
        continue;
      }
      const player = activePlayers[0];
      if (player.mycardArenaQuitFree) {
        continue;
      }
      const joinTime = player.mycardArenaJoinTime || now;
      const waitedMs = now - joinTime;
      if (waitedMs >= 30_000) {
        await player.sendChat('#{arena_wait_timeout}', ChatColor.BABYBLUE);
        player.mycardArenaQuitFree = true;
      } else if (waitedMs >= 5_000 && !room.mycardArenaFreeQuitHintSent) {
        await player.sendChat('#{arena_wait_hint}', ChatColor.BABYBLUE);
        room.mycardArenaFreeQuitHintSent = true;
      }
    }
  }

  private async sendArenaScore(client: Client) {
    if (!this.arenaGetScoreUrl || client.isLocal) {
      return;
    }
    try {
      const scoreUrl = new URL(this.arenaGetScoreUrl);
      scoreUrl.searchParams.set(this.arenaGetScoreParam, client.name);
      const { data } = await this.ctx.http.get(scoreUrl.toString(), {
        responseType: 'json',
      });
      if (!data || typeof data === 'string') {
        this.logger.warn({ player: client.name, data }, 'LOAD SCORE FAIL');
        return;
      }
      const rankText =
        Number(data.arena_rank) > 0
          ? `#{rank_arena}${data.arena_rank}`
          : '#{rank_blank}';
      await client.sendChat(
        `${client.name}#{exp_value_part1}${data.exp}#{exp_value_part2}#{exp_value_part3}${Math.round(Number(data.pt || 0))}${rankText}#{exp_value_part4}`,
        ChatColor.BABYBLUE,
      );
    } catch (error) {
      this.logger.warn({ player: client.name, error }, 'LOAD SCORE ERROR');
    }
  }

  private createArenaScoreSnapshot(room: Room): ArenaScoreSnapshot | undefined {
    if (!room.mycardArena || !this.arenaPostScoreUrl) {
      return undefined;
    }
    this.ensureArenaScoreState(room);
    if (!room.mycardArenaScoreHandled) {
      this.updateArenaScoresFromRoomScore(room);
    }

    const players = Object.values(room.mycardArenaPlayers || {})
      .sort((a, b) => a.pos - b.pos)
      .slice(0, 2)
      .map((snapshot) => this.createScorePlayer(room, snapshot));

    if (players.length !== 2) {
      return {
        roomName: room.name,
        arena: room.mycardArena,
        start: room.mycardArenaStartTime || this.nowString(),
        end: this.nowString(),
        firstList: this.resolveFirstList(room),
        replays: this.resolveReplays(room),
        players: [
          this.createFallbackScorePlayer(players[0]),
          this.createFallbackScorePlayer(players[1]),
        ],
      };
    }

    return {
      roomName: room.name,
      arena: room.mycardArena,
      start: room.mycardArenaStartTime || this.nowString(),
      end: this.nowString(),
      firstList: this.resolveFirstList(room),
      replays: this.resolveReplays(room),
      players: [players[0], players[1]],
    };
  }

  private createScorePlayer(
    room: Room,
    snapshot: MycardArenaPlayerSnapshot,
  ): ArenaScorePlayer {
    return {
      name: snapshot.name,
      key: snapshot.key,
      score: room.mycardArenaScores?.[snapshot.key] ?? -5,
      deck: room.mycardArenaDecks?.[snapshot.key] || '',
      deckHistory: room.mycardArenaDeckHistory?.[snapshot.key] || [],
    };
  }

  private createFallbackScorePlayer(
    player: ArenaScorePlayer | undefined,
  ): ArenaScorePlayer {
    if (player) {
      return {
        ...player,
        score: -5,
      };
    }
    return {
      name: null,
      key: '',
      score: -5,
      deck: '',
      deckHistory: [],
    };
  }

  private resolveFirstList(room: Room) {
    return room.duelRecords
      .map((duelRecord) => {
        const firstPos = duelRecord.isSwapped ? 1 : 0;
        return duelRecord.players[firstPos]?.name;
      })
      .filter((name): name is string => !!name);
  }

  private resolveReplays(room: Room) {
    const replays: string[] = [];
    for (const duelRecord of room.duelRecords) {
      try {
        replays.push(
          Buffer.from(duelRecord.toYrp(room).toYrp()).toString('base64'),
        );
      } catch (error) {
        this.logger.warn(
          { error, roomName: room.name },
          'Failed to encode replay',
        );
      }
    }
    return replays;
  }

  private postScoreSnapshotNonBlocking(snapshot: ArenaScoreSnapshot) {
    void this.postScoreSnapshot(snapshot).catch((error) => {
      this.logger.warn(
        { error, roomName: snapshot.roomName },
        'SCORE POST ERROR',
      );
    });
  }

  private async postScoreSnapshot(snapshot: ArenaScoreSnapshot) {
    if (!this.arenaPostScoreUrl) {
      return;
    }
    const form = new URLSearchParams();
    const [playerA, playerB] = snapshot.players;
    form.append('accesskey', this.arenaAccessKey);
    form.append('usernameA', playerA.name || '');
    form.append('usernameB', playerB.name || '');
    form.append('userscoreA', String(playerA.score));
    form.append('userscoreB', String(playerB.score));
    form.append('userdeckA', playerA.deck);
    form.append('userdeckB', playerB.deck);
    form.append('userdeckAHistory', playerA.deckHistory.join(','));
    form.append('userdeckBHistory', playerB.deckHistory.join(','));
    form.append('first', JSON.stringify(snapshot.firstList));
    form.append('replays', JSON.stringify(snapshot.replays));
    form.append('start', snapshot.start);
    form.append('end', snapshot.end);
    form.append('arena', snapshot.arena);
    form.append('nonce', Math.random().toString());

    let lastError: unknown;
    for (let i = 0; i < 10; i += 1) {
      try {
        const response = await this.ctx.http.post(
          this.arenaPostScoreUrl,
          form,
          {
            validateStatus: (status) => status < 400,
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
            },
          },
        );
        this.logger.info(
          {
            status: response.status,
            statusText: response.statusText,
            roomName: snapshot.roomName,
            data: response.data,
          },
          'SCORE POST OK',
        );
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }
}
