import { ChatColor, YGOProCtosJoinGame } from 'ygopro-msg-encode';
import { Context } from '../app';
import { ChallongeService, ReplayRecoverService } from '../feats';
import { DuelStage, Room, RoomCreateError, RoomManager } from '../room';

export class ChallongeJoinHandler {
  private logger = this.ctx.createLogger(this.constructor.name);
  private challongeService = this.ctx.get(() => ChallongeService);
  private replayRecoverService = this.ctx.get(() => ReplayRecoverService);
  private roomManager = this.ctx.get(() => RoomManager);

  constructor(private ctx: Context) {}

  async init() {
    this.ctx.middleware(YGOProCtosJoinGame, async (msg, client, next) => {
      if (!this.challongeService.enabled) {
        return next();
      }

      const preRoom = this.resolvePreRoom(msg.pass);
      if (preRoom && preRoom.duelStage !== DuelStage.Begin) {
        return preRoom.join(client, true);
      }

      const resolved = await this.challongeService.resolveJoinInfo(client.name);
      if (resolved.ok === false) {
        return client.die(
          this.resolveJoinErrorMessage(resolved.reason),
          ChatColor.RED,
        );
      }

      const recoverPrefix = this.replayRecoverService.resolveRecoverRoomPrefix(
        msg.pass,
      );
      const roomName = this.resolveRoomName(resolved.match.id, recoverPrefix);
      const room = await this.roomManager.findOrCreateByName(roomName, client);
      if (room instanceof RoomCreateError) {
        return client.die(room.message, ChatColor.RED);
      }
      room.noHost = true;
      room.challongeInfo = resolved.match;
      room.welcome = '#{challonge_match_created}';

      if (this.hasSameParticipantInRoom(room, resolved.participant.id)) {
        this.logger.debug(
          {
            roomName: room.name,
            participantId: resolved.participant.id,
            clientName: client.name,
          },
          'Rejected duplicated challonge participant in room',
        );
        return client.die('#{challonge_player_already_in}', ChatColor.RED);
      }

      client.challongeInfo = resolved.participant;
      return room.join(client);
    });
  }

  private resolveRoomName(matchId: number, recoverPrefix?: string) {
    if (this.ctx.config.getBoolean('CHALLONGE_NO_MATCH_MODE')) {
      return recoverPrefix ? `${recoverPrefix}#${matchId}` : `${matchId}`;
    }
    return recoverPrefix ? `${recoverPrefix},M#${matchId}` : `M#${matchId}`;
  }

  private resolvePreRoom(pass: string | undefined) {
    const roomName = (pass || '').trim();
    if (!roomName) {
      return undefined;
    }
    return this.roomManager.findByName(roomName);
  }

  private hasSameParticipantInRoom(room: Room, participantId: number) {
    return room.playingPlayers.some(
      (player) => player && player.challongeInfo?.id === participantId,
    );
  }

  private resolveJoinErrorMessage(
    reason: 'match_load_failed' | 'user_not_found' | 'match_not_found',
  ) {
    if (reason === 'match_load_failed') {
      return '#{challonge_match_load_failed}';
    }
    if (reason === 'user_not_found') {
      return '#{challonge_user_not_found}';
    }
    return '#{challonge_match_not_found}';
  }
}
