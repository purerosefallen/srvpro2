import { createAppContext } from 'nfkit';
import { ClientVersionCheck } from './client-version-check';
import { ContextState } from '../app';
import { Welcome } from './welcome';

export const FeatsModule = createAppContext<ContextState>()
  .provide(ClientVersionCheck)
  .provide(Welcome)
  .define();
