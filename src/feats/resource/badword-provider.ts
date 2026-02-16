import { ChatColor, YGOProCtosChat } from 'ygopro-msg-encode';
import { Context } from '../../app';
import { Client } from '../../client';
import { Room, RoomManager } from '../../room';
import { escapeRegExp } from '../../utility/escape-regexp';
import { ValueContainer } from '../../utility/value-container';
import { BaseResourceProvider } from './base-resource-provider';
import { isObjectRecord } from './resource-util';
import { BadwordsData, EMPTY_BADWORDS_DATA } from './types';

declare module '../../room' {
  interface Room {
    checkChatBadword?: boolean;
  }
}

export interface BadwordCheckResult {
  level: number;
  message?: string;
}

export class BadwordTextCheck extends ValueContainer<BadwordCheckResult> {
  constructor(
    public text: string,
    public room?: Room,
    public client?: Client,
  ) {
    super({ level: -1 });
  }

  asLevel(level: number) {
    return this.use({
      ...this.value,
      level,
    });
  }

  asMessage(message?: string) {
    return this.use({
      ...this.value,
      message,
    });
  }
}

export class BadwordProvider extends BaseResourceProvider<BadwordsData> {
  enabled = this.ctx.config.getBoolean('ENABLE_BADWORDS');

  private roomManager = this.ctx.get(() => RoomManager);

  private level0Regex?: RegExp;
  private level1Regex?: RegExp;
  private level1GlobalRegex?: RegExp;
  private level2Regex?: RegExp;
  private level3Regex?: RegExp;

  constructor(ctx: Context) {
    super(ctx, {
      resourceName: 'badwords',
      emptyData: EMPTY_BADWORDS_DATA,
    });

    if (!this.enabled) {
      return;
    }

    this.ctx.middleware(YGOProCtosChat, async (msg, client, next) => {
      if (client.isInternal) {
        return next();
      }
      const room = client.roomName
        ? this.roomManager.findByName(client.roomName)
        : undefined;
      const filtered = await this.filterText(msg.msg, room, client);

      if (filtered.blocked) {
        await client.sendChat('#{chat_warn_level2}', ChatColor.RED);
        return;
      }

      if (filtered.message !== msg.msg) {
        msg.msg = filtered.message;
        await client.sendChat('#{chat_warn_level1}', ChatColor.BABYBLUE);
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

  async refreshFromRemote() {
    if (!this.enabled) {
      return false;
    }
    const url = this.ctx.config.getString('BADWORDS_GET').trim();
    if (!url) {
      return false;
    }
    try {
      const body = (
        await this.ctx.http.get(url, {
          responseType: 'json',
        })
      ).data;
      const remoteData = this.resolveRemoteBadwordsData(body);
      if (!remoteData) {
        this.logger.warn({ url }, 'Remote badwords response is invalid');
        return false;
      }
      await this.updateData(remoteData);
      this.logger.info({ url }, 'Loaded remote resource');
      return true;
    } catch (error) {
      this.logger.warn(
        {
          url,
          error: (error as Error).toString(),
        },
        'Failed loading remote resource',
      );
      return false;
    }
  }

  async getBadwordLevel(text: string, room?: Room, client?: Client) {
    const checkResult = await this.getBadwordCheck(text, room, client);
    return checkResult.level;
  }

  async getBadwordCheck(text: string, room?: Room, client?: Client) {
    if (!this.enabled) {
      return { level: -1 } as BadwordCheckResult;
    }
    const event = await this.ctx.dispatch(
      new BadwordTextCheck(text, room, client),
      client as any,
    );
    return event?.value ?? ({ level: -1 } as BadwordCheckResult);
  }

  async filterText(text: string, room?: Room, client?: Client) {
    const checkResult = await this.getBadwordCheck(text, room, client);
    const { level } = checkResult;

    if (level >= 2) {
      return {
        blocked: true,
        level,
        message: text,
      };
    }

    if (level === 1 && typeof checkResult.message === 'string') {
      return {
        blocked: false,
        level,
        message: checkResult.message,
      };
    }
    if (level === 1) {
      return {
        blocked: false,
        level,
        message: text,
      };
    }

    return {
      blocked: false,
      level,
      message: text,
    };
  }

  protected registerLookupMiddleware() {
    this.ctx.middleware(BadwordTextCheck, async (event, _client, next) => {
      if (event.room && !event.room.checkChatBadword) {
        event.use({ level: -1 });
        return next();
      }
      const level = this.resolveBadwordLevel(event.text);
      if (level === 1 && this.level1GlobalRegex) {
        event.use({
          level,
          message: event.text.replace(this.level1GlobalRegex, '**'),
        });
      } else {
        event.use({ level });
      }
      return next();
    });
  }

  protected onDataUpdated(nextData: BadwordsData): void {
    this.level0Regex = this.buildRegex(nextData.level0, 'i');
    this.level1Regex = this.buildRegex(nextData.level1, 'i');
    this.level1GlobalRegex = this.buildRegex(nextData.level1, 'ig');
    this.level2Regex = this.buildRegex(nextData.level2, 'i');
    this.level3Regex = this.buildRegex(nextData.level3, 'i');
  }

  private resolveBadwordLevel(text: string) {
    if (!text) {
      return -1;
    }
    if (this.level3Regex?.test(text)) {
      return 3;
    }
    if (this.level2Regex?.test(text)) {
      return 2;
    }
    if (this.level1Regex?.test(text)) {
      return 1;
    }
    if (this.level0Regex?.test(text)) {
      return 0;
    }
    return -1;
  }

  private buildRegex(words: string[], flags: string) {
    const escapedWords = words
      .map((word) => word.trim())
      .filter((word) => !!word)
      .map((word) => escapeRegExp(word));
    if (!escapedWords.length) {
      return undefined;
    }
    return new RegExp(`(?:${escapedWords.join(')|(?:')})`, flags);
  }

  private resolveRemoteBadwordsData(
    rawData: unknown,
  ): BadwordsData | undefined {
    if (!isObjectRecord(rawData)) {
      return undefined;
    }

    const level0 = this.ensureStringArray(rawData.level0);
    const level1 = this.ensureStringArray(rawData.level1);
    const level2 = this.ensureStringArray(rawData.level2);
    const level3 = this.ensureStringArray(rawData.level3);

    if (!level0 || !level1 || !level2 || !level3) {
      return undefined;
    }

    return {
      ...this.getResourceData(),
      level0,
      level1,
      level2,
      level3,
    };
  }

  private ensureStringArray(value: unknown) {
    if (!Array.isArray(value)) {
      return undefined;
    }
    return value.filter((item): item is string => typeof item === 'string');
  }

  protected isEnabled() {
    return this.enabled;
  }
}
