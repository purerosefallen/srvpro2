import { AppContext, createAppContext } from 'nfkit';
import { ContextState } from '../../app';
import { BadwordProvider } from './badword-provider';
import { DialoguesProvider } from './dialogues-provider';
import { TipsProvider } from './tips-provider';
import { WordsProvider } from './words-provider';

export const ResourceModule = createAppContext<ContextState>()
  .provide(TipsProvider)
  .provide(WordsProvider)
  .provide(DialoguesProvider)
  .provide(BadwordProvider)
  .define() as AppContext;
