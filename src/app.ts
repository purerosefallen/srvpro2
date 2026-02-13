import { createAppContext } from 'nfkit';
import { ConfigService } from './services/config';
import { Logger } from './services/logger';
import { Emitter } from './services/emitter';
import { SSLFinder } from './services/ssl-finder';
import { ClientHandler } from './client/client-handler';
import { IpResolver } from './services/ip-resolver';
import { HttpClient } from './services/http-client';
import { Chnroute } from './services/chnroute';
import { I18nService } from './services/i18n';
import { YGOProCtosJoinGame } from 'ygopro-msg-encode';
import { TcpServer } from './transport/tcp/server';
import { WsServer } from './transport/ws/server';
import { ClientVersionCheck } from './services/client-version-check';
import { AragamiService } from './services/aragami';
import { RoomManager } from './room/room-manager';
import { RoomEventRegister } from './room/room-event-register';
import { DefaultHostInfoProvider } from './room/default-hostinfo-provder';
import { YGOProResourceLoader } from './services/ygopro-resource-loader';

const core = createAppContext()
  .provide(ConfigService, {
    merge: ['getConfig'],
  })
  .provide(Logger, { merge: ['createLogger'] })
  .provide(Emitter, { merge: ['dispatch', 'middleware', 'removeMiddleware'] })
  .provide(HttpClient, { merge: ['http'] })
  .provide(AragamiService, { merge: ['aragami'] })
  .define();

export type Context = typeof core;

export const app = core
  .provide(SSLFinder)
  .provide(IpResolver)
  .provide(Chnroute)
  .provide(I18nService)
  .provide(ClientHandler)
  .provide(TcpServer)
  .provide(WsServer)
  .provide(ClientVersionCheck)
  .provide(DefaultHostInfoProvider)
  .provide(YGOProResourceLoader)
  .provide(RoomManager)
  .provide(RoomEventRegister)
  .define();

app.middleware(YGOProCtosJoinGame, async (msg, client, _next) => {
  await client.sendChat(`Welcome ${client.name_vpass || client.name}!`);
  await client.sendChat(`Your IP: ${client.ip}`);
  await client.sendChat(`Your physical IP: ${client.physicalIp()}`);
  await client.sendChat(`Your pass: ${msg.pass}`);
  return client.die(
    'This server is for testing purposes only. Please use an official server to play the game.',
  );
});
