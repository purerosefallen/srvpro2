import { createAppContext } from 'nfkit';
import { ClientVersionCheck } from './client-version-check';
import { ContextState } from '../app';
import { Welcome } from './welcome';
import { PlayerStatusNotify } from './player-status-notify';
import { Reconnect } from './reconnect';
import { WindbotModule } from './windbot';
import { SideTimeout } from './side-timeout';
import { RandomDuelModule } from './random-duel';
import { WaitForPlayerProvider } from './wait-for-player-provider';
import { ResourceModule } from './resource';

export const FeatsModule = createAppContext<ContextState>()
  .use(ResourceModule)
  .provide(ClientVersionCheck)
  .provide(Welcome)
  .provide(PlayerStatusNotify)
  .provide(Reconnect)
  .provide(WaitForPlayerProvider)
  .provide(SideTimeout)
  .use(RandomDuelModule)
  .use(WindbotModule)
  .define();
