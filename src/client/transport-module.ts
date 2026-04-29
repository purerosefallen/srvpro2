import { AppContext, createAppContext } from 'nfkit';
import { ContextState } from '../app';
import { TcpServer } from './transport/tcp/server';
import { WsServer } from './transport/ws/server';
import { ClientHandler } from './client-handler';
import { Chnroute } from './chnroute';
import { I18nService } from './i18n';
import { IpResolver } from './ip-resolver';

export const TransportModule = createAppContext<ContextState>()
  .provide(IpResolver)
  .provide(Chnroute)
  .provide(I18nService)
  .provide(ClientHandler)
  .provide(TcpServer)
  .provide(WsServer)
  .define() as AppContext;
