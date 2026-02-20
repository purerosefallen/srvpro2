import { ChatColor, YGOProMsgNewTurn } from 'ygopro-msg-encode';
import { Context } from '../app';
import { RoomManager, DuelStage, OnRoomDuelStart, Room } from '../room';
import { PlayerName } from '../utility';

const DEATH_WIN_REASON = 0x11;

declare module '../room' {
  interface Room {
    death?: number;
  }
}

export class RoomDeathService {
  private roomManager = this.ctx.get(() => RoomManager);

  constructor(private ctx: Context) {}

  async init() {
    this.ctx.middleware(OnRoomDuelStart, async (event, _client, next) => {
      const room = event.room;
      if (!room.death) {
        return next();
      }
      if (room.duelRecords.length > 1) {
        if (room.death === -1) {
          await room.sendChat('#{death_start_final}', ChatColor.BABYBLUE);
        } else {
          await room.sendChat('#{death_start_extra}', ChatColor.BABYBLUE);
        }
        room.death = 5;
      }
      return next();
    });

    this.ctx.middleware(YGOProMsgNewTurn, async (msg, client, next) => {
      if (msg.player & 0x2) {
        return next();
      }
      const room = this.resolveRoom(client?.roomName);
      if (!room || !room.death || room.duelStage !== DuelStage.Dueling) {
        return next();
      }

      const fieldInfo = await room.getCurrentFieldInfo();
      if (!fieldInfo || fieldInfo.length < 2) {
        return next();
      }
      const lp0 = fieldInfo[0]?.lp;
      const lp1 = fieldInfo[1]?.lp;
      if (typeof lp0 !== 'number' || typeof lp1 !== 'number') {
        return next();
      }

      if (room.turnCount >= room.death) {
        if (lp0 !== lp1 && room.turnCount > 1) {
          const winner = lp0 > lp1 ? 0 : 1;
          const winnerPlayer = room.getDuelPosPlayers(winner)[0];
          const finishMessage = winnerPlayer
            ? [
                '#{death_finish_part1}',
                PlayerName(winnerPlayer),
                '#{death_finish_part2}',
              ]
            : '#{death_finish_part1}#{death_finish_part2}';
          await room.sendChat(finishMessage, ChatColor.BABYBLUE);
          await room.win({
            player: room.getIngameDuelPosByDuelPos(winner),
            type: DEATH_WIN_REASON,
          });
          return;
        }
        room.death = -1;
        await room.sendChat('#{death_remain_final}', ChatColor.BABYBLUE);
        return next();
      }

      await room.sendChat(
        `#{death_remain_part1}${room.death - room.turnCount}#{death_remain_part2}`,
        ChatColor.BABYBLUE,
      );
      return next();
    });
  }

  async startDeath(room: Room) {
    if (room.duelStage === DuelStage.Begin || room.death) {
      return false;
    }

    const score = room.score;
    const score0 = score[0] || 0;
    const score1 = score[1] || 0;
    const maxScore = Math.max(score0, score1);
    room.setOverrideWinMatchCount(maxScore + 1);

    if (
      [DuelStage.Finger, DuelStage.FirstGo, DuelStage.Siding].includes(
        room.duelStage,
      ) &&
      score0 !== score1
    ) {
      const winner = score0 > score1 ? 0 : 1;
      const winnerPlayer = room.getDuelPosPlayers(winner)[0];
      const finishMessage = winnerPlayer
        ? [
            '#{death2_finish_part1}',
            PlayerName(winnerPlayer),
            '#{death2_finish_part2}',
          ]
        : '#{death2_finish_part1}#{death2_finish_part2}';
      await room.sendChat(finishMessage, ChatColor.BABYBLUE);
      await room.win(
        {
          player: room.getIngameDuelPosByDuelPos(winner),
          type: DEATH_WIN_REASON,
        },
        -1,
      );
      return true;
    }

    if (room.duelStage === DuelStage.Dueling) {
      room.death = room.turnCount ? room.turnCount + 4 : 5;
      await room.sendChat('#{death_start}', ChatColor.BABYBLUE);
    } else {
      room.death = 5;
      await room.sendChat('#{death_start_siding}', ChatColor.BABYBLUE);
    }
    return true;
  }

  async cancelDeath(room: Room) {
    if (room.duelStage === DuelStage.Begin || !room.death) {
      return false;
    }
    room.death = 0;
    room.setOverrideWinMatchCount(undefined);
    await room.sendChat('#{death_cancel}', ChatColor.BABYBLUE);
    return true;
  }

  private resolveRoom(roomName?: string) {
    if (!roomName) {
      return undefined;
    }
    const room = this.roomManager.findByName(roomName);
    if (!room || room.finalizing) {
      return undefined;
    }
    return room;
  }
}
