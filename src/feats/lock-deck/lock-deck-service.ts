import {
  YGOProLFListError,
  YGOProLFListErrorReason,
} from 'ygopro-lflist-encode';
import { ChatColor } from 'ygopro-msg-encode';
import { Context } from '../../app';
import { RoomCheckDeck } from '../../room';
import { isUpdateDeckPayloadEqual } from '../../utility/deck-compare';
import { PlayerName } from '../../utility';
import { LockDeckExpectedDeckCheck } from './lock-deck-check';

class SrvproDeckBadError extends YGOProLFListError {
  constructor() {
    super(YGOProLFListErrorReason.LFLIST, 0);
  }

  toPayload() {
    // srvpro 的 deck_bad 发的是 ERROR_MSG code=0
    return 0;
  }
}

export class LockDeckService {
  constructor(private ctx: Context) {}

  async init() {
    if (
      !this.ctx.config.getBoolean('TOURNAMENT_MODE') ||
      !this.ctx.config.getBoolean('TOURNAMENT_MODE_CHECK_DECK')
    ) {
      return;
    }

    this.ctx.middleware(RoomCheckDeck, async (msg, client, next) => {
      const current = await next();
      if (msg.value) {
        return current;
      }

      const expectedDeckCheck = await this.ctx.dispatch(
        new LockDeckExpectedDeckCheck(msg.room, msg.client, msg.deck),
        client,
      );
      const expectedDeck = expectedDeckCheck?.expectedDeck;

      if (expectedDeck === undefined) {
        return current;
      }

      if (expectedDeck === null) {
        await client.sendChat(
          [PlayerName(client), '#{deck_not_found}'],
          ChatColor.RED,
        );
        return msg.use(new SrvproDeckBadError());
      }

      const deckName = expectedDeck.name || '';
      if (isUpdateDeckPayloadEqual(msg.deck, expectedDeck)) {
        await client.sendChat(
          `#{deck_correct_part1}${deckName}#{deck_correct_part2}`,
          ChatColor.BABYBLUE,
        );
        return current;
      }

      await client.sendChat(
        `#{deck_incorrect_part1}${deckName}#{deck_incorrect_part2}`,
        ChatColor.RED,
      );
      return msg.use(new SrvproDeckBadError());
    });
  }
}
