import { Context } from '../app';
import { generateSeed } from '../utility/generate-seed';
import { RoomUseSeed } from './room-event/room-use-seed';

export class DefaultSeeder {
  constructor(private ctx: Context) {}

  async init() {
    this.ctx.middleware(RoomUseSeed, (event, _client, next) => {
      if (!event.value.length) {
        event.use(generateSeed());
      }
      return next();
    });
  }
}
