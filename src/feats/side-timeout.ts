import { ChatColor } from 'ygopro-msg-encode';
import { Context } from '../app';
import {
  DuelStage,
  OnRoomFinalize,
  OnRoomGameStart,
  OnRoomLeavePlayer,
  OnRoomSidingReady,
  OnRoomSidingStart,
  Room,
} from '../room';
import { merge, Subscription, timer } from 'rxjs';
import { filter, finalize, share, take, takeUntil } from 'rxjs/operators';

declare module '../room' {
  interface Room {
    sideTimeoutSubscriptions?: Map<number, Subscription>;
    sideTimeoutRemainMinutes?: Map<number, number>;
  }
}

export class SideTimeout {
  private logger = this.ctx.createLogger('SideTimeout');
  private sideTimeoutMinutes = this.ctx.config.getInt('SIDE_TIMEOUT_MINUTES');
  private onSidingReady$ = this.ctx.event$(OnRoomSidingReady).pipe(share());
  private onLeavePlayer$ = this.ctx.event$(OnRoomLeavePlayer).pipe(share());
  private onGameStart$ = this.ctx.event$(OnRoomGameStart).pipe(share());
  private onFinalize$ = this.ctx.event$(OnRoomFinalize).pipe(share());

  constructor(private ctx: Context) {
    if (this.sideTimeoutMinutes <= 0) {
      return;
    }

    this.ctx.event$(OnRoomSidingStart).subscribe(({ msg }) => {
      void this.handleSidingStart(msg.room).catch((error) => {
        this.logger.warn({ error }, 'Failed to start side timeout');
      });
    });
  }

  private async handleSidingStart(room: Room) {
    if (room.duelStage !== DuelStage.Siding) {
      return;
    }
    await Promise.all(
      room.playingPlayers.map(async (player) => {
        await this.startSideTimeout(room, player.pos);
      }),
    );
  }

  private getSubscriptions(room: Room): Map<number, Subscription> {
    if (!room.sideTimeoutSubscriptions) {
      room.sideTimeoutSubscriptions = new Map();
    }
    return room.sideTimeoutSubscriptions;
  }

  private getRemainMinutes(room: Room): Map<number, number> {
    if (!room.sideTimeoutRemainMinutes) {
      room.sideTimeoutRemainMinutes = new Map();
    }
    return room.sideTimeoutRemainMinutes;
  }

  private clearSideTimeout(room: Room, pos: number) {
    const subscriptions = this.getSubscriptions(room);
    const subscription = subscriptions.get(pos);
    if (subscription) {
      subscription.unsubscribe();
    }
    subscriptions.delete(pos);
    this.getRemainMinutes(room).delete(pos);
  }

  private createStopSignal(room: Room, pos: number) {
    return merge(
      this.onSidingReady$.pipe(
        filter((event) => event.msg.room === room && event.client.pos === pos),
      ),
      this.onLeavePlayer$.pipe(
        filter((event) => event.msg.room === room && event.msg.oldPos === pos),
      ),
      this.onGameStart$.pipe(filter((event) => event.msg.room === room)),
      this.onFinalize$.pipe(filter((event) => event.msg.room === room)),
    ).pipe(take(1));
  }

  private async startSideTimeout(room: Room, pos: number) {
    const client = room.players[pos];
    if (!client) {
      return;
    }
    this.clearSideTimeout(room, pos);
    this.getRemainMinutes(room).set(pos, this.sideTimeoutMinutes);

    await client.sendChat(
      `#{side_timeout_part1}${this.sideTimeoutMinutes}#{side_timeout_part2}`,
      ChatColor.BABYBLUE,
    );

    const stopSignal = this.createStopSignal(room, pos);
    const subscription = timer(60_000, 60_000)
      .pipe(
        takeUntil(stopSignal),
        finalize(() => {
          const subscriptions = this.getSubscriptions(room);
          if (subscriptions.get(pos) === subscription) {
            subscriptions.delete(pos);
          }
          this.getRemainMinutes(room).delete(pos);
        }),
      )
      .subscribe(() => {
        void this.tickSideTimeout(room, pos).catch((error) => {
          this.logger.warn({ error }, 'Failed to process side timeout tick');
        });
      });

    this.getSubscriptions(room).set(pos, subscription);
  }

  private async tickSideTimeout(room: Room, pos: number) {
    if (room.finalizing || room.duelStage !== DuelStage.Siding) {
      this.clearSideTimeout(room, pos);
      return;
    }

    const remainMap = this.getRemainMinutes(room);
    const remainMinutes = remainMap.get(pos);
    if (!remainMinutes) {
      this.clearSideTimeout(room, pos);
      return;
    }

    const client = room.players[pos];
    if (
      !client ||
      client.roomName !== room.name ||
      client.disconnected ||
      client.pos !== pos
    ) {
      this.clearSideTimeout(room, pos);
      return;
    }

    if (remainMinutes <= 1) {
      this.clearSideTimeout(room, pos);
      await room.sendChat(
        `${client.name} #{side_overtime_room}`,
        ChatColor.BABYBLUE,
      );
      await client.sendChat('#{side_overtime}', ChatColor.RED);
      client.disconnect();
      return;
    }

    const nextRemainMinutes = remainMinutes - 1;
    remainMap.set(pos, nextRemainMinutes);
    await client.sendChat(
      `#{side_remain_part1}${nextRemainMinutes}#{side_remain_part2}`,
      ChatColor.BABYBLUE,
    );
  }
}
