import { AppContext, createAppContext } from 'nfkit';
import { ContextState } from '../../app';
import { AthleticChecker } from './athletic-checker';
import { MycardRoomlistService } from './mycard-roomlist-service';
import { MycardService } from './mycard-service';

export const MycardModule = createAppContext<ContextState>()
  .provide(AthleticChecker)
  .provide(MycardService)
  .provide(MycardRoomlistService)
  .define() as AppContext;
