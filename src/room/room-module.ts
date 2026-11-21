import { AppContext, createAppContext } from 'nfkit';
import { ContextState } from '../app';
import { AngelusService } from '../angelus';
import { DefaultHostInfoProvider } from './default-hostinfo-provder';
import { RoomManager } from './room-manager';
import { DefaultDeckChecker } from './default-deck-checker';
import { DefaultDeckShuffler } from './default-deck-shuffler';
import { DefaultFirstgo } from './default-firstgo';
import { DefaultSeeder } from './default-seeder';
import { ZombieRoomCleaner } from './zombie-room-cleaner';
import { NoWatchGuard } from './no-watch-guard';
import { ReplayEncodeService } from '../replay';

export const RoomModule = createAppContext<ContextState>()
  .provide(DefaultHostInfoProvider)
  .provide(AngelusService)
  .provide(RoomManager)
  .provide(DefaultDeckChecker)
  .provide(DefaultDeckShuffler)
  .provide(DefaultFirstgo)
  .provide(DefaultSeeder)
  .provide(ZombieRoomCleaner)
  .provide(NoWatchGuard)
  .provide(ReplayEncodeService)
  .define() as AppContext;
