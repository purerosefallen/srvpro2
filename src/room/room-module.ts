import { createAppContext } from 'nfkit';
import { ContextState } from '../app';
import { YGOProResourceLoader } from './ygopro-resource-loader';
import { DefaultHostInfoProvider } from './default-hostinfo-provder';
import { RoomManager } from './room-manager';
import { DefaultDeckChecker } from './default-deck-checker';
import { ZombieRoomCleaner } from './zombie-room-cleaner';

export const RoomModule = createAppContext<ContextState>()
  .provide(DefaultHostInfoProvider)
  .provide(YGOProResourceLoader)
  .provide(RoomManager)
  .provide(DefaultDeckChecker)
  .provide(ZombieRoomCleaner)
  .define();
