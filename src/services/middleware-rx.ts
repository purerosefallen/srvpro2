import { AppContext, ClassType, Middleware, ProtoMiddlewareFunc } from 'nfkit';
import { Emitter } from './emitter';
import { Observable } from 'rxjs';
import { Client } from '../client';

export class MiddlewareRx {
  constructor(private ctx: AppContext) {}
  private emitter = this.ctx.get(() => Emitter);

  event$<T>(cls: ClassType<T>, prior = false) {
    return new Observable<{
      msg: T;
      client: Client;
    }>((sub) => {
      const handler: Middleware<ProtoMiddlewareFunc<[client: Client], T>> = (
        msg,
        client,
        next,
      ) => {
        sub.next({ msg, client });
        return next();
      };
      this.emitter.middleware(cls, handler, prior);
      return () => {
        this.emitter.removeMiddleware(cls, handler);
      }
    });
  }
}
