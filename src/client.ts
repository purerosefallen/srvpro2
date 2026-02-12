import { filter, merge, Observable, Subject } from 'rxjs';
import { map, share, take, takeUntil } from 'rxjs/operators';
import { Context } from './app';
import {
  YGOProCtos,
  YGOProStocBase,
  YGOProCtosBase,
  YGOProStocChat,
  ChatColor,
  YGOProStocErrorMsg,
} from 'ygopro-msg-encode';
import { YGOProProtoPipe } from './utility/ygopro-proto-pipe';
import { I18nService } from './services/i18n';
import { Chnroute } from './services/chnroute';

export abstract class Client {
  protected abstract _send(data: Buffer): Promise<void>;
  protected abstract _receive(): Observable<Buffer<ArrayBufferLike>>;
  protected abstract _disconnect(): Promise<void>;
  protected abstract _onDisconnect(): Observable<void>;
  abstract physicalIp(): string;

  ip = '';
  isLocal = false;

  private logger = this.ctx.createLogger(this.constructor.name);
  private disconnectSubject = new Subject<void>();

  constructor(protected ctx: Context) {}

  receive$!: Observable<YGOProCtosBase>;
  disconnect$!: Observable<void>;

  init() {
    this.disconnect$ = merge(
      this.disconnectSubject.asObservable(),
      this._onDisconnect(),
    ).pipe(take(1));
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

  disconnect() {
    this.disconnectSubject.next();
    this.disconnectSubject.complete();
    this._disconnect().then();
    return undefined;
  }

  async send(data: YGOProStocBase) {
    try {
      await this._send(Buffer.from(data.toFullPayload()));
    } catch (e) {
      this.logger.warn(
        { ip: this.loggingIp(), error: (e as Error).message },
        `Failed to send message: ${(e as Error).message}`,
      );
    }
  }

  async sendChat(msg: string, type = ChatColor.BABYBLUE) {
    return this.send(
      new YGOProStocChat().fromPartial({
        msg: await this.ctx
          .get(I18nService)
          .translate(this.ctx.get(Chnroute).getLocale(this.ip), msg),
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

  name = '';
  vpass = '';
  name_vpass = '';
}
