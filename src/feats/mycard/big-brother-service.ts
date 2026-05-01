import { Context } from '../../app';
import { OnClientBadwordViolation } from '../random-duel';

type BigBrotherReport = {
  roomname: string;
  sender: string;
  ip: string;
  level: number;
  content: string;
  match: string;
};

export class BigBrotherService {
  private logger = this.ctx.createLogger(this.constructor.name);

  constructor(private ctx: Context) {}

  async init() {
    if (!this.enabled) {
      return;
    }
    if (!this.postUrl) {
      this.logger.warn(
        'BIG_BROTHER_ENABLED is set but BIG_BROTHER_POST is empty',
      );
      return;
    }

    this.ctx.middleware(
      OnClientBadwordViolation,
      async (event, _client, next) => {
        const report = this.createReport(event);
        if (report) {
          this.reportNonBlocking(report);
        }
        return next();
      },
    );
  }

  private get enabled() {
    return this.ctx.config.getBoolean('BIG_BROTHER_ENABLED');
  }

  private get accessKey() {
    return this.ctx.config.getString('BIG_BROTHER_ACCESS_KEY');
  }

  private get postUrl() {
    return this.ctx.config.getString('BIG_BROTHER_POST').trim();
  }

  private createReport(
    event: OnClientBadwordViolation,
  ): BigBrotherReport | undefined {
    const client = event.client;
    if (client.isInternal) {
      return undefined;
    }
    return {
      roomname: event.room?.name || '',
      sender: client.name || '',
      ip: client.ip || '',
      level: event.level,
      content: event.message,
      match:
        event.match ||
        this.resolveReplacedMatch(event.message, event.replacedMessage) ||
        '',
    };
  }

  private resolveReplacedMatch(message: string, replacedMessage?: string) {
    if (!replacedMessage || message === replacedMessage) {
      return undefined;
    }

    let prefixLength = 0;
    while (
      prefixLength < message.length &&
      prefixLength < replacedMessage.length &&
      message[prefixLength] === replacedMessage[prefixLength]
    ) {
      prefixLength += 1;
    }

    let suffixLength = 0;
    while (
      suffixLength + prefixLength < message.length &&
      suffixLength + prefixLength < replacedMessage.length &&
      message[message.length - suffixLength - 1] ===
        replacedMessage[replacedMessage.length - suffixLength - 1]
    ) {
      suffixLength += 1;
    }

    return message.slice(prefixLength, message.length - suffixLength);
  }

  private reportNonBlocking(report: BigBrotherReport) {
    void this.report(report).catch((error) => {
      this.logger.warn(
        { error, roomname: report.roomname },
        'BIG BROTHER ERROR',
      );
    });
  }

  private async report(report: BigBrotherReport) {
    const form = new URLSearchParams();
    form.append('accesskey', this.accessKey);
    form.append('roomname', report.roomname);
    form.append('sender', report.sender);
    form.append('ip', report.ip);
    form.append('level', String(report.level));
    form.append('content', report.content);
    form.append('match', report.match);

    const response = await this.ctx.http.post(this.postUrl, form, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      validateStatus: () => true,
    });

    if (response.status >= 300) {
      this.logger.warn(
        {
          status: response.status,
          roomname: report.roomname,
          data: response.data,
        },
        'BIG BROTHER FAIL',
      );
    }
  }
}
