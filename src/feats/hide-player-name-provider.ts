import { NetPlayerType, YGOProStocHsPlayerEnter } from 'ygopro-msg-encode';
import { Context } from '../app';
import { DuelStage, OnRoomGameStart, Room, RoomManager } from '../room';
import { Client } from '../client';

declare module '../room' {
  interface Room {
    hidePlayerNames?: boolean;
  }
}

export class HidePlayerNameProvider {
  private roomManager = this.ctx.get(() => RoomManager);
  private hidePlayerNameMode = this.resolveMode();

  constructor(private ctx: Context) {}

  getHidPlayerName(
    client: Pick<Client, 'pos' | 'name' | 'roomName'>,
    sightPlayer?: Client,
  ) {
    if (!sightPlayer?.roomName) {
      return client.name;
    }
    const room = this.roomManager.findByName(
      client.roomName || sightPlayer?.roomName,
    );
    if (!room?.hidePlayerNames || !this.shouldHide(room.duelStage)) {
      return client.name;
    }

    if (
      client.pos < 0 ||
      client.pos >= NetPlayerType.OBSERVER ||
      (sightPlayer && sightPlayer.pos === client.pos) ||
      !client.name
    ) {
      return client.name;
    }

    return `Player ${client.pos + 1}`;
  }

  async init() {
    if (!this.enabled) {
      return;
    }

    this.ctx.middleware(YGOProStocHsPlayerEnter, async (msg, client, next) => {
      const hidPlayerName = this.getHidPlayerName(msg, client);
      if (hidPlayerName !== msg.name) {
        msg.name = hidPlayerName;
      }
      return next();
    });

    this.ctx.middleware(OnRoomGameStart, async (event, _client, next) => {
      if (
        this.hidePlayerNameMode !== 1 ||
        !event.room.hidePlayerNames ||
        event.room.duelRecords.length !== 0
      ) {
        return next();
      }

      for (const sightPlayer of event.room.allPlayers) {
        for (const player of event.room.playingPlayers) {
          if (player === sightPlayer) {
            continue;
          }
          await sightPlayer.send(
            new YGOProStocHsPlayerEnter().fromPartial({
              name: player.name,
              pos: player.pos,
            }),
            true,
          );
        }
      }
      return next();
    });
  }

  get enabled() {
    return this.hidePlayerNameMode > 0;
  }

  private shouldHide(stage: DuelStage) {
    if (this.hidePlayerNameMode === 2) {
      return true;
    }
    return this.hidePlayerNameMode === 1 && stage === DuelStage.Begin;
  }

  private resolveMode() {
    const mode = this.ctx.config.getInt('HIDE_PLAYER_NAME');
    if (mode === 1 || mode === 2) {
      return mode;
    }
    return 0;
  }
}
