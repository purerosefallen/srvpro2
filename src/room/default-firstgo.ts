import { Context } from '../app';
import { RoomDecideFirstgo } from './room-event/room-decide-firstgo';

export class DefaultFirstgo {
  constructor(private ctx: Context) {}

  async init() {
    this.ctx.middleware(RoomDecideFirstgo, (event, _client, next) => {
      if (event.value == null) {
        const winPosition = event.room.lastDuelRecord?.winPosition;
        if (winPosition === 0 || winPosition === 1) {
          event.use(1 - winPosition);
        }
      }
      return next();
    });
  }
}
