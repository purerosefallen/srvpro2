import { AppContext, createAppContext } from 'nfkit';
import { ContextState } from '../app';
import { ClientVersionCheck } from './client-version-check';
import { JoinPrechecks } from './join-prechecks';
import { JoinWindbotToken } from '../feats/windbot';
import { BadwordPlayerInfoChecker } from './badword-player-info-checker';

export const PreJoinModule = createAppContext<ContextState>()
  .provide(ClientVersionCheck)
  .provide(JoinPrechecks)
  .provide(JoinWindbotToken) // AIJOIN#
  .provide(BadwordPlayerInfoChecker)
  .define() as AppContext;
