export class TimerState {
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
    if (settleElapsed && this.runningPos != null) {
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
    this.timer = setTimeout(onTimeout, delayMs);
  }
}
