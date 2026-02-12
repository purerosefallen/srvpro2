import { HttpsProxyAgent } from 'https-proxy-agent';
import { AxiosRequestConfig } from 'axios';
import { HttpProxyAgent } from 'http-proxy-agent';

export function useProxy(proxy: string): AxiosRequestConfig {
  if (!proxy) {
    return {};
  }
  return {
    httpAgent: new HttpProxyAgent(proxy),
    httpsAgent: new HttpsProxyAgent(proxy),
  };
}
