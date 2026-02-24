import { createAppContext } from 'nfkit';
import { ContextState } from '../../app';
import { RewindService } from './rewind-service';
import { WindBotProvider } from './windbot-provider';
import { WindbotSpawner } from './windbot-spawner';

export const WindbotModule = createAppContext<ContextState>()
  .provide(WindBotProvider)
  .provide(RewindService)
  .provide(WindbotSpawner)
  .define();
