import { createAppContext } from 'nfkit';
import { ClientVersionCheck } from './client-version-check';
import { ContextState } from '../app';
import { Welcome } from './welcome';
import { PlayerStatusNotify } from './player-status-notify';
import { Reconnect, RefreshFieldService } from './reconnect';
import { WindbotModule } from './windbot';
import { SideTimeout } from './side-timeout';
import { RandomDuelModule } from './random-duel';
import { WaitForPlayerProvider } from './wait-for-player-provider';
import { ResourceModule } from './resource';
import { MenuManager } from './menu-manager';
import { ClientKeyProvider } from './client-key-provider';
import { HidePlayerNameProvider } from './hide-player-name-provider';
import { CommandsService, KoishiContextService } from '../koishi';
import { ChatgptService } from './chatgpt-service';
import { CloudReplayService } from './cloud-replay';
import { LpLowHintService } from './lp-low-hint-service';
import { LockDeckService } from './lock-deck-service';
import { BlockReplay } from './block-replay';

export const FeatsModule = createAppContext<ContextState>()
  .provide(ClientKeyProvider)
  .provide(HidePlayerNameProvider)
  .provide(KoishiContextService)
  .provide(CommandsService) // some chat commands
  .provide(Welcome)
  .provide(MenuManager)
  .provide(ClientVersionCheck)
  .provide(PlayerStatusNotify)
  .provide(CloudReplayService) // persist duel records
  .provide(BlockReplay) // block replay packets for in-room players
  .provide(ChatgptService) // AI-room chat replies
  .provide(LpLowHintService) // low LP hint in duel
  .provide(LockDeckService) // srvpro-style tournament deck lock check
  .provide(RefreshFieldService)
  .provide(Reconnect)
  .provide(WaitForPlayerProvider) // chat refresh
  .provide(SideTimeout)
  .use(ResourceModule) // chat bad words
  .use(RandomDuelModule) // chat random duel block
  .use(WindbotModule)
  .define();
