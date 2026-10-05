export interface Clock {
  /** UTC milliseconds. Always inject via constructors so tests can control time. */
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

/**
 * Single-timer scheduler abstraction (P10). Production arms one real
 * `setTimeout` pointing at the nearest due schedule; tests inject a virtual
 * implementation driven by a controllable clock so nothing waits in real time.
 */
export interface TimerScheduler {
  /** Arms one timer; returns a cancel function. */
  setTimer(delayMs: number, fn: () => void): () => void;
}

export const realTimerScheduler: TimerScheduler = {
  setTimer: (delayMs, fn) => {
    const timer = setTimeout(fn, delayMs);
    timer.unref?.();
    return () => clearTimeout(timer);
  },
};
