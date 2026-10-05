import type { Clock, TimerScheduler } from '@kepcup/core';

/**
 * Controllable clock + virtual timer registry (P10). `advance` moves time
 * forward and fires the timers whose deadlines passed (in arm order, timers
 * may arm further timers), so schedule tests never wait in real time.
 */
export class TestClock implements Clock, TimerScheduler {
  #now: number;
  #seq = 0;
  readonly #timers = new Map<number, { at: number; fn: () => void }>();

  constructor(now = Date.parse('2026-10-01T04:00:00.000Z')) {
    this.#now = now;
  }

  now(): number {
    return this.#now;
  }

  /** Moves the clock and fires due virtual timers before returning. */
  advance(ms: number): void {
    this.setNow(this.#now + ms);
  }

  setNow(next: number): void {
    if (next < this.#now) {
      // Moving backwards would break timer deadlines; only allowed without
      // pending timers (some tests reset the day).
      if (this.#timers.size > 0) {
        throw new Error('TestClock cannot move backwards with timers armed');
      }
      this.#now = next;
      return;
    }
    this.#now = next;
    // Loop: a fired timer may arm another one already due.
    for (;;) {
      const due = [...this.#timers.entries()]
        .filter(([, timer]) => timer.at <= this.#now)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
      const first = due[0];
      if (first === undefined) return;
      const [id, timer] = first;
      this.#timers.delete(id);
      timer.fn();
    }
  }

  setTimer(delayMs: number, fn: () => void): () => void {
    const id = ++this.#seq;
    this.#timers.set(id, { at: this.#now + Math.max(0, delayMs), fn });
    return () => {
      this.#timers.delete(id);
    };
  }

  /** Number of currently armed virtual timers (test assertions). */
  get armedTimers(): number {
    return this.#timers.size;
  }
}
