import { AppContext, ProtoMiddlewareDispatcher } from 'nfkit';
import { Client } from '../client';

export class Emitter extends ProtoMiddlewareDispatcher<[client: Client]> {
  constructor(private ctx: AppContext) {
    super({
      acceptResult: () => true,
      errorHandler: (e) => {
        throw e;
      },
    });
  }
}
