import axios from 'axios';
import { useProxy } from '../utility/use-proxy';
import { AppContext } from 'nfkit';
import { ConfigService } from './config';

export class HttpClient {
  constructor(private ctx: AppContext) {}
  http = axios.create({
    ...useProxy(
      this.ctx.get(() => ConfigService).config.getString('USE_PROXY'),
    ),
  });
}
