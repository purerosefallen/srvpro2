import { Context } from '../app';
import { checkDeck } from '../utility/check-deck';
import { RoomCheckDeck } from './room-event/room-check-deck';

export class DefaultDeckChecker {
  constructor(private ctx: Context) {
    ctx.middleware(RoomCheckDeck, (msg, client, next) => {
      const { room, deck, cardReader } = msg;
      if (room.hostinfo.no_check_deck) {
        return next();
      }
      const deckError = checkDeck(deck, cardReader, {
        ot: room.hostinfo.rule,
        lflist: room.lflist,
        minMain: this.ctx.config.getInt('DECK_MAIN_MIN'),
        maxMain: this.ctx.config.getInt('DECK_MAIN_MAX'),
        maxExtra: this.ctx.config.getInt('DECK_EXTRA_MAX'),
        maxSide: this.ctx.config.getInt('DECK_SIDE_MAX'),
        maxCopies: this.ctx.config.getInt('DECK_MAX_COPIES'),
      });

      if (deckError) {
        return msg.use(deckError);
      }

      return next();
    });
  }
}
