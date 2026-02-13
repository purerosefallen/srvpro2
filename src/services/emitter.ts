import { AppContext, ProtoMiddlewareDispatcher } from 'nfkit';
import { Client } from '../client/client';

export class Emitter extends ProtoMiddlewareDispatcher<[Client]> {
  constructor(private ctx: AppContext) {
    super({
      acceptResult: () => true,
      errorHandler: (e) => {
        throw e;
      },
    });
  }
}
