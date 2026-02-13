import { createAppContext } from 'nfkit';
import { ContextState } from '../app';
import { ClientVersionCheck } from './client-version-check';
import { JoinRoom } from './join-room';
import { JoinFallback } from './fallback';

export const JoinHandlerModule = createAppContext<ContextState>()
  .provide(ClientVersionCheck)
  .provide(JoinRoom)
  .provide(JoinFallback)
  .define();
