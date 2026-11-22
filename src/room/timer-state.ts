export class TimerState {
  // Readiness grace is server-bounded per prompt and drawn from a finite pool
  // per side for the whole duel. Waiting for ACK cannot extend that deadline.
  public static readonly MAX_READINESS_GRACE_MS = 30_000;
  leftMs: [number, number] = [0, 0];
  readinessMs: [number, number] = [0, 0];
  backedMs: [number, number] = [0, 0];
  runningPos?: number;
  startedAtMs = 0;
  awaitingConfirm = false;
  private readinessGraceMs = 0;
  private timer?: ReturnType<typeof setTimeout>;

  reset(initialMs: number) {
    this.clear();
    this.leftMs = [initialMs, initialMs];
    this.readinessMs = [initialMs, initialMs];
    this.backedMs = [initialMs, initialMs];
  }

  clear(settleElapsed = false) {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (settleElapsed && this.runningPos != null) {
      const player = this.runningPos;
      const elapsedMs = this.elapsedMs();
      this.leftMs[player] = this.remainingMs(player);
      if (this.awaitingConfirm) {
        this.readinessMs[player] = Math.max(
          0,
          this.readinessMs[player] - Math.min(elapsedMs, this.readinessGraceMs),
        );
      }
    }
    this.runningPos = undefined;
    this.startedAtMs = 0;
    this.awaitingConfirm = false;
    this.readinessGraceMs = 0;
  }

  elapsedMs() {
    return this.runningPos == null
      ? 0
      : Math.max(0, Date.now() - this.startedAtMs);
  }

  remainingMs(player: number) {
    const chargedMs =
      this.runningPos === player
        ? Math.max(0, this.elapsedMs() - this.readinessGraceMs)
        : 0;
    return Math.max(0, (this.leftMs[player] || 0) - chargedMs);
  }

  schedule(
    player: number,
    delayMs: number,
    awaitingConfirm: boolean,
    onTimeout: () => void,
  ) {
    this.runningPos = player;
    this.startedAtMs = Date.now();
    this.awaitingConfirm = awaitingConfirm;
    this.readinessGraceMs = awaitingConfirm
      ? Math.min(TimerState.MAX_READINESS_GRACE_MS, this.readinessMs[player])
      : 0;
    const deadlineMs = Math.max(0, delayMs) + this.readinessGraceMs;
    // Expire synchronously: a queued response must not rescue a zero bank
    // before a zero-delay timeout gets its turn on the event loop.
    if (deadlineMs <= 0) {
      onTimeout();
      return;
    }
    this.timer = setTimeout(onTimeout, deadlineMs);
  }
}
