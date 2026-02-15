import { createAppContext } from 'nfkit';
import { ClientVersionCheck } from './client-version-check';
import { ContextState } from '../app';
import { Welcome } from './welcome';
import { PlayerStatusNotify } from './player-status-notify';
import { Reconnect } from './reconnect';
import { WindbotModule } from '../windbot';

export const FeatsModule = createAppContext<ContextState>()
  .provide(ClientVersionCheck)
  .use(WindbotModule)
  .provide(Welcome)
  .provide(PlayerStatusNotify)
  .provide(Reconnect)
  .define();
