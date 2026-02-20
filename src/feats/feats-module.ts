import { createAppContext } from 'nfkit';
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
import { ChatLengthCheck } from './chat-length-check';
import { CloudReplayService } from './cloud-replay';
import { LpLowHintService } from './lp-low-hint-service';
import { LockDeckService } from './lock-deck';
import { BlockReplay } from './block-replay';
import { RoomDeathService } from './room-death-service';
import { RoomAutoDeathService } from './room-auto-death-service';
import { ChallongeService } from './challonge-service';
import { TagSurrenderConfirmMiddleware } from './tag-surrender-confirm-middleware';

export const FeatsModule = createAppContext()
  .provide(ClientKeyProvider)
  .provide(HidePlayerNameProvider)
  .provide(KoishiContextService)
  .provide(CommandsService) // some chat commands
  .provide(Welcome)
  .provide(MenuManager)
  .provide(PlayerStatusNotify) // hint meessages when player status changes
  .provide(CloudReplayService) // persist duel records
  .provide(BlockReplay) // block replay packets for in-room players
  .provide(ChatgptService) // AI-room chat replies
  .provide(ChatLengthCheck) // block blank/overlong chat messages
  .provide(LpLowHintService) // low LP hint in duel
  .provide(RoomDeathService) // srvpro-style death mode (model 2)
  .provide(RoomAutoDeathService) // auto trigger death mode after duel start
  .provide(ChallongeService) // challonge deck lock + score sync
  .provide(LockDeckService) // srvpro-style tournament deck lock check
  .provide(RefreshFieldService) // utility for
  .provide(Reconnect) // allow players to reconnect to ongoing duels without leaving the room
  .provide(WaitForPlayerProvider) // chat refresh
  .provide(SideTimeout) // side timeout in duel
  .provide(TagSurrenderConfirmMiddleware) // teammate-confirm surrender in tag duel
  .use(ResourceModule) // chat bad words
  .use(RandomDuelModule) // chat random duel block
  .use(WindbotModule)
  .define();
