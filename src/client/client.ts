import { filter, merge, Observable, of, Subject } from 'rxjs';
import { map, share, take, takeUntil, tap } from 'rxjs/operators';
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
} from 'ygopro-msg-encode';
import { YGOProProtoPipe } from '../utility/ygopro-proto-pipe';
import { I18nService } from './i18n';
import { Chnroute } from './chnroute';
import YGOProDeck from 'ygopro-deck-encode';
import PQueue from 'p-queue';
import { ClientRoomField } from '../utility/decorators';

export class Client {
  protected async _send(data: Buffer): Promise<void> {
    return Promise.resolve();
  }
  protected _receive(): Observable<Buffer<ArrayBufferLike>> {
    return of();
  }
  protected async _disconnect(): Promise<void> {}
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
        this.disconnected = new Date();
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
    this.disconnectSubject.next();
    this.disconnectSubject.complete();
    this._disconnect().then();
    return undefined;
  }

  private sendQueue = new PQueue({ concurrency: 1 });

  async send(data: YGOProStocBase) {
    if (this.disconnected) {
      return;
    }
    return this.sendQueue.add(async () => {
      this.logger.debug(
        {
          msgName: data.constructor.name,
          client: this.name || this.loggingIp(),
          payload: JSON.stringify(data),
        },
        'Sending message to client',
      )
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

  async sendChat(msg: string, type: number = ChatColor.BABYBLUE) {
    if (type >= ChatColor.RED) {
      msg = `[Server]: ${msg}`;
    }
    return this.send(
      new YGOProStocChat().fromPartial({
        msg:
          type <= NetPlayerType.OBSERVER
            ? msg
            : await this.ctx
                .get(() => I18nService)
                .translate(
                  this.ctx.get(() => Chnroute).getLocale(this.ip),
                  msg,
                ),
        player_type: type,
      }),
    );
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
  isHost = false;
  @ClientRoomField()
  pos = -1;
  @ClientRoomField()
  deck?: YGOProDeck;
  @ClientRoomField()
  startDeck?: YGOProDeck;

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
}
