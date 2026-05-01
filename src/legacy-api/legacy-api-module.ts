import { AppContext, createAppContext } from 'nfkit';
import { LegacyApiService } from './legacy-api-service';
import { LegacyApiReplayService } from './legacy-api-replay-service';
import { LegacyApiDeckService } from './legacy-api-deck-service';
import { LegacyStopService } from './legacy-stop-service';
import { LegacyBanService } from './legacy-ban-service';
import { LegacyWelcomeService } from './legacy-welcome-service';
import { LegacyRoomIdService } from './legacy-room-id-service';

export const LegacyApiModule = createAppContext()
  .provide(LegacyRoomIdService)
  .provide(LegacyStopService)
  .provide(LegacyBanService)
  .provide(LegacyWelcomeService)
  .provide(LegacyApiService)
  .provide(LegacyApiReplayService)
  .provide(LegacyApiDeckService)
  .define() as AppContext;
