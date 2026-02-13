import { createAppContext } from 'nfkit';
import { ContextState } from '../app';
import { YGOProResourceLoader } from './ygopro-resource-loader';
import { DefaultHostInfoProvider } from './default-hostinfo-provder';
import { RoomEventRegister } from './room-event-register';
import { RoomManager } from './room-manager';

export const RoomModule = createAppContext<ContextState>()
  .provide(DefaultHostInfoProvider)
  .provide(YGOProResourceLoader)
  .provide(RoomManager)
  .provide(RoomEventRegister);
