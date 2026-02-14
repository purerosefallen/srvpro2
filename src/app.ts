import { AppContextState, createAppContext } from 'nfkit';
import { ConfigService } from './services/config';
import { Logger } from './services/logger';
import { Emitter } from './services/emitter';
import { HttpClient } from './services/http-client';
import { AragamiService } from './services/aragami';
import { TransportModule } from './client/transport-module';
import { JoinHandlerModule } from './join-handlers/join-handler-module';
import { RoomModule } from './room/room-module';
import { SqljsFactory, SqljsLoader } from './services/sqljs';
import { FeatsModule } from './feats/feats-module';

const core = createAppContext()
  .provide(ConfigService, {
    merge: ['getConfig'],
  })
  .provide(Logger, { merge: ['createLogger'] })
  .provide(Emitter, { merge: ['dispatch', 'middleware', 'removeMiddleware'] })
  .provide(HttpClient, { merge: ['http'] })
  .provide(AragamiService, { merge: ['aragami'] })
  .provide(SqljsLoader, {
    useFactory: SqljsFactory,
    merge: ['SQL'],
  })
  .define();

export type Context = typeof core;
export type ContextState = AppContextState<Context>;

export const app = core
  .use(TransportModule)
  .use(FeatsModule)
  .use(RoomModule)
  .use(JoinHandlerModule)
  .define();
