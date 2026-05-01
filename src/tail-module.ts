import { AppContext, createAppContext } from 'nfkit';
import { ContextState } from './app';
import { JoinFallback } from './join-handlers/fallback';
import { RoomEventRegister } from './room/room-event-register';

export const TailModule = createAppContext<ContextState>()
  .provide(RoomEventRegister)
  .provide(JoinFallback)
  .define() as AppContext;
