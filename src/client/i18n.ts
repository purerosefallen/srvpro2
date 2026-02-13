import { I18n, I18nLookupMiddleware } from 'nfkit';
import { Context } from '../app';
import { TRANSLATIONS } from '../constants/trans';

export class I18nService extends I18n {
  constructor(private ctx: Context) {
    super({
      locales: Object.keys(TRANSLATIONS),
      defaultLocale: 'en-US',
    });
    this.middleware(I18nLookupMiddleware(TRANSLATIONS));
  }
}
