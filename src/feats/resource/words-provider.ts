import { ChatColor } from 'ygopro-msg-encode';
import { Context } from '../../app';
import { Client } from '../../client';
import { OnRoomJoin, Room } from '../../room';
import { ValueContainer } from '../../utility/value-container';
import { pickRandom } from '../../utility/pick-random';
import { BaseResourceProvider } from './base-resource-provider';
import { EMPTY_WORDS_DATA, WordsData } from './types';

export class WordsLookup extends ValueContainer<string[]> {
  constructor(
    public room: Room,
    public client: Client,
  ) {
    super([]);
  }
}

export class WordsProvider extends BaseResourceProvider<WordsData> {
  enabled = this.ctx.config.getBoolean('ENABLE_WORDS');

  constructor(ctx: Context) {
    super(ctx, {
      resourceName: 'words',
      emptyData: EMPTY_WORDS_DATA,
    });

    if (!this.enabled) {
      return;
    }

    this.ctx.middleware(OnRoomJoin, async (event, client, next) => {
      const line = await this.getRandomWords(event.room, client);
      if (line) {
        await event.room.sendChat(line, ChatColor.PINK);
      }
      return next();
    });
  }

  async refreshResources() {
    if (!this.enabled) {
      return false;
    }
    return this.refreshFromRemote();
  }

  async getRandomWords(room: Room, client: Client) {
    if (!this.enabled) {
      return undefined;
    }
    const event = await this.ctx.dispatch(
      new WordsLookup(room, client),
      client,
    );
    const words = (event?.value || []).filter((line) => !!line);
    return pickRandom(words);
  }

  protected registerLookupMiddleware() {
    this.ctx.middleware(WordsLookup, async (event, _client, next) => {
      const data = this.getResourceData();
      event.use(data.words[event.client.name] || []);
      return next();
    });
  }

  protected getRemoteLoadEntries() {
    return [
      {
        field: 'words' as const,
        url: this.ctx.config.getString('WORDS_GET').trim(),
      },
    ];
  }

  protected isEnabled() {
    return this.enabled;
  }
}
