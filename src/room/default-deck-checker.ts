import { AngelusService } from '../angelus';
import { Context } from '../app';
import { checkChangeSide } from '../utility/check-deck';
import { RoomCheckDeck } from './room-event/room-check-deck';
import { RoomSideCheck } from './room-event/room-side-check';

export class DefaultDeckChecker {
  constructor(private ctx: Context) {}

  async init() {
    this.ctx.middleware(RoomCheckDeck, async (msg, client, next) => {
      const { room, deck } = msg;
      if (room.hostinfo.no_check_deck) {
        return next();
      }
      const deckError = await this.ctx
        .get(() => AngelusService)
        .checkDeck({
          deck: deck.toYdkeURL(),
          rule: room.hostinfo.rule,
          lflist: room.lflist?.name,
          limits: {
            minMain: this.ctx.config.getInt('DECK_MAIN_MIN'),
            maxMain: this.ctx.config.getInt('DECK_MAIN_MAX'),
            maxExtra: this.ctx.config.getInt('DECK_EXTRA_MAX'),
            maxSide: this.ctx.config.getInt('DECK_SIDE_MAX'),
            maxCopies: this.ctx.config.getInt('DECK_MAX_COPIES'),
          },
        });

      if (deckError) {
        return msg.use(deckError);
      }

      return next();
    });

    this.ctx.middleware(RoomSideCheck, (msg, client, next) => {
      const { deck, startDeck } = msg;
      if (!checkChangeSide(startDeck, deck)) {
        return msg.no();
      }

      return next();
    });
  }
}
