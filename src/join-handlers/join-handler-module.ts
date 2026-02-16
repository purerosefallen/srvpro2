import { createAppContext } from 'nfkit';
import { ContextState } from '../app';
import { ClientVersionCheck } from '../feats';
import { JoinWindbotAi, JoinWindbotToken } from '../feats/windbot';
import { JoinRoom } from './join-room';
import { JoinRoomIp } from './join-room-ip';
import { JoinFallback } from './fallback';
import { JoinPrechecks } from './join-prechecks';
import { RandomDuelJoinHandler } from './random-duel-join-handler';
import { BadwordPlayerInfoChecker } from './badword-player-info-checker';
import { JoinBlankPassRandomDuel } from './join-blank-pass-random-duel';
import { JoinBlankPassWindbotAi } from './join-blank-pass-windbot-ai';
import { JoinBlankPassMenu } from './join-blank-pass-menu';

export const JoinHandlerModule = createAppContext<ContextState>()
  .provide(ClientVersionCheck)
  .provide(JoinPrechecks)
  .provide(JoinWindbotToken)
  .provide(BadwordPlayerInfoChecker)
  .provide(RandomDuelJoinHandler)
  .provide(JoinWindbotAi)
  .provide(JoinRoomIp)
  .provide(JoinRoom)
  .provide(JoinBlankPassMenu)
  .provide(JoinBlankPassRandomDuel)
  .provide(JoinBlankPassWindbotAi)
  .provide(JoinFallback)
  .define();
