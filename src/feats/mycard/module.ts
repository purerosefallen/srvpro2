import { createAppContext } from 'nfkit';
import { ContextState } from '../../app';
import { AthleticChecker } from './athletic-checker';
import { MycardService } from './mycard-service';

export const MycardModule = createAppContext<ContextState>()
  .provide(AthleticChecker)
  .provide(MycardService)
  .define();

