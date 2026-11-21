import { AppContextState, createAppContext } from 'nfkit';
import { ConfigService } from './services/config';
import { Logger } from './services/logger';
import { Emitter } from './services/emitter';
import { HttpClient } from './services/http-client';
import { AragamiService } from './services/aragami';
import { TransportModule } from './client/transport-module';
import { JoinHandlerModule } from './join-handlers/join-handler-module';
import { RoomModule } from './room/room-module';
import { FeatsModule } from './feats/feats-module';
import { MiddlewareRx } from './services/middleware-rx';
import { TypeormFactory, TypeormLoader } from './services/typeorm';
import { SSLFinder } from './services/ssl-finder';
import { KoaService } from './services/koa-service';
import { FileResourceService } from './file-resource';
import { LegacyApiAuthService } from './services/legacy-api-auth-service';
import { LegacyApiModule } from './legacy-api/legacy-api-module';
import { TailModule } from './tail-module';
import { PreJoinModule } from './pre-join';
import { PluginLoader } from './plugin-loader';

const core = createAppContext()
  .provide(ConfigService, {
    merge: ['config'],
  })
  .provide(Logger, { merge: ['createLogger'] })
  .provide(Emitter, { merge: ['dispatch', 'middleware', 'removeMiddleware'] })
  .provide(MiddlewareRx, { merge: ['event$'] })
  .provide(HttpClient, { merge: ['http'] })
  .provide(AragamiService, { merge: ['aragami'] })
  .provide(SSLFinder)
  .provide(FileResourceService, {
    provide: 'fileResource',
  })
  .provide(LegacyApiAuthService, {
    provide: 'legacyApiAuth',
  })
  .provide(KoaService, {
    merge: ['router', 'koa'],
  })
  .provide(TypeormLoader, {
    useFactory: TypeormFactory,
    merge: ['database'],
  })
  .define();

export type Context = typeof core;
export type ContextState = AppContextState<Context>;

export const app = core
  .use(TransportModule)
  .use(RoomModule)
  .use(FeatsModule)
  .use(LegacyApiModule)
  .use(PreJoinModule)
  .use(PluginLoader())
  .use(JoinHandlerModule)
  .use(TailModule)
  .define();
