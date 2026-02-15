import { createAppContext } from 'nfkit';
import { ContextState } from '../app';
import { ClientVersionCheck } from '../feats/client-version-check';
import { JoinWindbotAi, JoinWindbotToken } from '../windbot';
import { JoinRoom } from './join-room';
import { JoinFallback } from './fallback';
import { JoinPrechecks } from './join-prechecks';

export const JoinHandlerModule = createAppContext<ContextState>()
  .provide(ClientVersionCheck)
  .provide(JoinPrechecks)
  .provide(JoinWindbotToken)
  .provide(JoinWindbotAi)
  .provide(JoinRoom)
  .provide(JoinFallback)
  .define();
