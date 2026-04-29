import { Client } from '../../client';
import { Room } from '../../room';

export type RandomDuelWaitTimeoutType = 'ready' | 'hang';

export class OnClientWaitTimeout {
  constructor(
    public room: Room,
    public client: Client,
    public type: RandomDuelWaitTimeoutType,
  ) {}
}

export class OnClientBadwordViolation {
  constructor(
    public client: Client,
    public room: Room | undefined,
    public message: string,
    public level: number,
    public replacedMessage?: string,
    public match?: string,
  ) {}
}
