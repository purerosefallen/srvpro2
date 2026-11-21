import { serviceEndpoint } from '../utility/service-endpoint';
import { AppContext } from 'nfkit';
import { loadConfig } from '../config';

export class ConfigService {
  constructor(private app: AppContext) {
    try {
      serviceEndpoint(this.config.getString('ANGELUS_ENDPOINT'), 'http');
    } catch {
      throw new Error(
        '请安装并启动 ygoangelus，配置 ANGELUS_ENDPOINT，例如 http://localhost:3001',
      );
    }
  }
  config = loadConfig();
}
