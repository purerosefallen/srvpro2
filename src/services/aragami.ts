import { Aragami } from 'aragami';
import { AppContext } from 'nfkit';
import { ConfigService } from './config';

export class AragamiService {
  constructor(private ctx: AppContext) {}

  private redisUrl = this.ctx.get(ConfigService).getConfig('REDIS_URL');

  aragami = new Aragami({
    redis: this.redisUrl ? { uri: this.redisUrl } : undefined,
  });
}
