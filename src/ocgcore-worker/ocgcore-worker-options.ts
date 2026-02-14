import YGOProDeck from 'ygopro-deck-encode';
import { HostInfo } from 'ygopro-msg-encode';
import { TransportType } from 'yuzuthread';

export class OcgcoreWorkerOptions {
  ygoproPaths: string[];
  extraScriptPaths: string[];
  ocgcoreWasmPath?: string;
  seed: number[];
  hostinfo: HostInfo;
  @TransportType(() => [YGOProDeck])
  decks: YGOProDeck[];
  registry: Record<string, string>;
}
