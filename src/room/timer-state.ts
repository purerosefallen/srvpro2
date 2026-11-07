export class TimerState {
  // Presentation/network readiness has its own finite deadline. It never spends
  // the response bank, even when the player has less time than the animation.
  public static readonly CONFIRM_TIMEOUT_MS = 60_000;
  leftMs: [number, number] = [0, 0];
  compensatorMs: [number, number] = [0, 0];
  backedMs: [number, number] = [0, 0];
  runningPos?: number;
  startedAtMs = 0;
  awaitingConfirm = false;
  private timer?: ReturnType<typeof setTimeout>;

  reset(initialMs: number) {
    this.leftMs = [initialMs, initialMs];
    this.compensatorMs = [initialMs, initialMs];
    this.backedMs = [initialMs, initialMs];
    this.clear();
  }

  clear(settleElapsed = false) {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (settleElapsed && this.runningPos != null && !this.awaitingConfirm) {
      const elapsedMs = this.elapsedMs();
      if (elapsedMs > 0) {
        this.leftMs[this.runningPos] = Math.max(
          0,
          this.leftMs[this.runningPos] - elapsedMs,
        );
      }
    }
    this.runningPos = undefined;
    this.startedAtMs = 0;
    this.awaitingConfirm = false;
  }

  elapsedMs() {
    if (!this.startedAtMs) {
      return 0;
    }
    return Math.max(0, Date.now() - this.startedAtMs);
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
    // Expire synchronously: a queued response must not rescue a zero bank
    // before a zero-delay timeout gets its turn on the event loop.
    if (!awaitingConfirm && delayMs <= 0) {
      onTimeout();
      return;
    }
    this.timer = setTimeout(
      onTimeout,
      awaitingConfirm ? TimerState.CONFIRM_TIMEOUT_MS : Math.max(0, delayMs),
    );
  }
}
