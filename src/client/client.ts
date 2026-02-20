import { filter, merge, Observable, of, Subject } from 'rxjs';
import { map, share, take, takeUntil, tap } from 'rxjs/operators';
import { h } from 'koishi';
import { Context } from '../app';
import {
  YGOProCtos,
  YGOProStocBase,
  YGOProCtosBase,
  YGOProStocChat,
  ChatColor,
  YGOProStocErrorMsg,
  YGOProStocTypeChange,
  YGOProStocHsPlayerEnter,
  YGOProStocHsPlayerChange,
  PlayerChangeState,
  NetPlayerType,
  YGOProStocGameMsg,
} from 'ygopro-msg-encode';
import { YGOProProtoPipe } from '../utility/ygopro-proto-pipe';
import { I18nService } from './i18n';
import { Chnroute } from './chnroute';
import YGOProDeck from 'ygopro-deck-encode';
import PQueue from 'p-queue';
import { ClientRoomField } from '../utility/decorators';
import {
  collectKoishiTextTokens,
  KoishiElement,
  KoishiFragment,
  OnSendChatElement,
  resolveColoredMessages,
  splitColoredMessagesByLine,
} from '../utility';
import { RoomManager } from '../room';

export class Client {
  protected async _send(data: Buffer): Promise<void> {
    return Promise.resolve();
  }
  protected _receive(): Observable<Buffer<ArrayBufferLike>> {
    return of();
  }
  async _disconnect(): Promise<void> {}
  protected _onDisconnect(): Observable<void> {
    return of();
  }
  physicalIp(): string {
    return '';
  }

  // in handshake
  ip = '';
  isLocal = false;
  isInternal = false;

  private logger = this.ctx.createLogger(this.constructor.name);
  private disconnectSubject = new Subject<void>();

  constructor(protected ctx: Context) {}

  receive$!: Observable<YGOProCtosBase>;
  disconnect$!: Observable<{ bySystem: boolean }>;

  init() {
    this.disconnect$ = merge(
      this.disconnectSubject
        .asObservable()
        .pipe(map(() => ({ bySystem: true }))),
      this._onDisconnect().pipe(map(() => ({ bySystem: false }))),
    ).pipe(
      take(1),
      tap(() => {
        this.disconnected ??= new Date();
      }),
      share(),
    );
    this.receive$ = this._receive().pipe(
      YGOProProtoPipe(YGOProCtos, {
        onError: (error) => {
          this.logger.warn(
            { ip: this.loggingIp() },
            `Protocol decode error: ${error.message}`,
          );
        },
      }),
      filter((msg) => {
        if (!msg) {
          this.logger.warn(
            { ip: this.loggingIp() },
            `Received invalid message, skipping`,
          );
          return false;
        }
        return true;
      }),
      map((s) => s!),
      takeUntil(this.disconnect$),
      share(),
    );
    return this;
  }

  disconnected?: Date;

  disconnect(): undefined {
    this.disconnected ??= new Date();
    if (this.roomName) {
      const room = this.ctx.get(() => RoomManager).findByName(this.roomName);
      if (room) {
        room.removePlayer(this, true);
      }
    }
    this.disconnectSubject.next();
    this.disconnectSubject.complete();
    this._disconnect().then();
    return undefined;
  }

  private sendQueue = new PQueue({ concurrency: 1 });

  async send(data: YGOProStocBase, noDispatch = false) {
    if (!noDispatch) {
      const dispatched = await this.ctx.dispatch(data.copy(), this);
      if (!data) {
        return;
      }
      data = dispatched!;
    }
    const logMsg = data instanceof YGOProStocGameMsg ? data.msg : data;
    this.logger.debug(
      {
        msgName: logMsg?.constructor.name,
        client: this.name || this.loggingIp(),
        payload: JSON.stringify(logMsg),
      },
      'Sending message to client',
    );
    return this.sendQueue.add(async () => {
      if (this.disconnected) {
        return;
      }
      try {
        await this._send(Buffer.from(data.toFullPayload()));
      } catch (e) {
        this.logger.warn(
          { ip: this.loggingIp(), error: (e as Error).stack },
          `Failed to send message: ${(e as Error).message}`,
        );
      }
    });
  }

  async sendChat(msg: KoishiFragment, type: number = ChatColor.BABYBLUE) {
    if (this.isInternal) {
      return;
    }
    const elements = h.normalize(msg) as KoishiElement[];
    const tokens = await collectKoishiTextTokens(
      elements,
      (element) => this.resolveSendChatElement(element, type),
      type,
    );
    if (type <= NetPlayerType.OBSERVER) {
      return this.send(
        new YGOProStocChat().fromPartial({
          msg:
            typeof msg === 'string'
              ? msg
              : tokens.map((token) => token.text).join(''),
          player_type: type,
        }),
      );
    }
    const messages = splitColoredMessagesByLine(
      resolveColoredMessages(tokens, type),
    );
    if (!messages.length) {
      return;
    }

    const locale = this.getLocale();
    for (const message of messages) {
      const line = await this.resolveChatLine(
        message.text,
        message.color,
        locale,
      );
      await this.send(
        new YGOProStocChat().fromPartial({
          msg: line,
          player_type: message.color,
        }),
      );
    }
  }

  private async resolveSendChatElement(element: KoishiElement, type: number) {
    const event = await this.ctx.dispatch(
      new OnSendChatElement(this, type, element),
      this,
    );
    if (!event || event.value === undefined) {
      return undefined;
    }
    return event.value;
  }

  private async resolveChatLine(rawLine: string, type: number, locale: string) {
    let line = rawLine;
    if (type >= ChatColor.RED) {
      line = `[Server]: ${line}`;
    }
    if (type > NetPlayerType.OBSERVER) {
      line = String(
        await this.ctx.get(() => I18nService).translate(locale, line),
      );
    }
    return line;
  }

  async die(msg?: string, type = ChatColor.BABYBLUE) {
    if (msg) {
      await this.sendChat(msg, type || ChatColor.BABYBLUE);
    }
    await this.send(
      new YGOProStocErrorMsg().fromPartial({
        msg: 1,
        code: 9,
      }),
    );
    return this.disconnect();
  }

  loggingIp() {
    return this.ip || this.physicalIp() || 'unknown';
  }

  getLocale() {
    return this.ctx.get(() => Chnroute).getLocale(this.ip);
  }

  // in handshake
  hostname = '';
  name = '';
  vpass = '';
  name_vpass = '';
  established = false;

  // in room
  @ClientRoomField()
  roomName?: string;
  @ClientRoomField()
  roompass = '';
  @ClientRoomField()
  isHost = false;
  @ClientRoomField()
  pos = -1;
  @ClientRoomField()
  deck?: YGOProDeck;
  @ClientRoomField()
  startDeck?: YGOProDeck;
  fleeFree = false;

  async sendTypeChange() {
    return this.send(
      new YGOProStocTypeChange().fromPartial({
        isHost: this.isHost,
        playerPosition: this.pos,
      }),
    );
  }

  prepareEnterPacket() {
    return new YGOProStocHsPlayerEnter().fromPartial({
      name: this.name,
      pos: this.pos,
    });
  }

  prepareChangePacket(state?: PlayerChangeState) {
    return new YGOProStocHsPlayerChange().fromPartial({
      playerPosition: this.pos,
      playerState:
        state ??
        (this.deck ? PlayerChangeState.READY : PlayerChangeState.NOTREADY),
    });
  }

  expectHandshakeTimeout() {
    return 5000;
  }
}
