// Mounted in the isolated image test only. Make the human-versus-bot replay reproducible.
const { DefinePlugin } = require('../src/utility/base-plugin');
const { RoomUseSeed } = require('../src/room');
class UndoSeed {
  constructor(ctx) {
    this.ctx = ctx;
  }
  async init() {
    this.ctx.middleware(
      RoomUseSeed,
      (event, client, next) => {
        event.use([1, 2, 3, 4, 5, 6, 7, 8]);
        return next();
      },
      true,
    );
  }
}
DefinePlugin()(UndoSeed);
module.exports = UndoSeed;
