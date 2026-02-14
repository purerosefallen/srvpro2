import { createAppContext } from 'nfkit';
import { ClientVersionCheck } from './client-version-check';
import { ContextState } from '../app';

export const FeatsModule = createAppContext<ContextState>()
  .provide(ClientVersionCheck)
  .define();
