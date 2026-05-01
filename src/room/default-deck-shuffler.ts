import { Context } from '../app';
import { shuffleDecksBySeed } from '../utility/shuffle-decks-by-seed';
import { RoomShuffleDeck } from './room-event/room-shuffle-deck';

export class DefaultDeckShuffler {
  constructor(private ctx: Context) {}

  async init() {
    this.ctx.middleware(RoomShuffleDeck, (event, _client, next) => {
      if (!event.room.hostinfo.no_shuffle_deck) {
        event.use(
          shuffleDecksBySeed(
            event.players.map((player) => player.deck),
            event.seed,
          ),
        );
      }
      return next();
    });
  }
}
