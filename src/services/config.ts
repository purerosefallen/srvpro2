import { serviceEndpoint } from '../utility/service-endpoint';
import { AppContext } from 'nfkit';
import { loadConfig } from '../config';

export class ConfigService {
  constructor(private app: AppContext) {
    try {
      serviceEndpoint(this.config.getString('ANGELUS_ENDPOINT'), 'http');
    } catch {
      throw new Error(
        'Please install and start ygoangelus, then set ANGELUS_ENDPOINT (for example, http://localhost:3001).',
      );
    }
  }
  config = loadConfig();
}
