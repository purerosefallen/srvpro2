import { createAppContext } from 'nfkit';
import { ContextState } from '../app';
import { ClientVersionCheck } from '../feats';
import { JoinWindbotAi, JoinWindbotToken } from '../feats/windbot';
import { JoinRoom } from './join-room';
import { JoinFallback } from './fallback';
import { JoinPrechecks } from './join-prechecks';
import { RandomDuelJoinHandler } from './random-duel-join-handler';

export const JoinHandlerModule = createAppContext<ContextState>()
  .provide(ClientVersionCheck)
  .provide(JoinPrechecks)
  .provide(JoinWindbotToken)
  .provide(RandomDuelJoinHandler)
  .provide(JoinWindbotAi)
  .provide(JoinRoom)
  .provide(JoinFallback)
  .define();
