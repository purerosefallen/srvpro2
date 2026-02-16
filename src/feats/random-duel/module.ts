import { createAppContext } from 'nfkit';
import { ContextState } from '../../app';
import { RandomDuelProvider } from './provider';

export const RandomDuelModule = createAppContext<ContextState>()
  .provide(RandomDuelProvider)
  .define();
