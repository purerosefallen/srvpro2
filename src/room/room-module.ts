import { AppContext, createAppContext } from 'nfkit';
import { ContextState } from '../app';
import { YGOProResourceLoader } from '../ygopro';
import { DefaultHostInfoProvider } from './default-hostinfo-provder';
import { RoomManager } from './room-manager';
import { DefaultDeckChecker } from './default-deck-checker';
import { DefaultFirstgo } from './default-firstgo';
import { DefaultSeeder } from './default-seeder';
import { ZombieRoomCleaner } from './zombie-room-cleaner';
import { NoWatchGuard } from './no-watch-guard';

export const RoomModule = createAppContext<ContextState>()
  .provide(DefaultHostInfoProvider)
  .provide(YGOProResourceLoader)
  .provide(RoomManager)
  .provide(DefaultDeckChecker)
  .provide(DefaultFirstgo)
  .provide(DefaultSeeder)
  .provide(ZombieRoomCleaner)
  .provide(NoWatchGuard)
  .define() as AppContext;
