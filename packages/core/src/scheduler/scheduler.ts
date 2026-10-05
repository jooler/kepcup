import { BACKGROUND_LOOP_CONCURRENCY } from '@kepcup/shared';
import type { CoreLogger } from '../infra/logger.js';

export interface SchedulerJob {
  /** 0 user-triggered responses, 1 scheduled/event responses, 2 background loops. */
  priority: 0 | 1 | 2;
  /** Provider id for the concurrency limit. */
  provider: string;
  /** Serialization key (e.g. mailbox `botId:conversationId`); callers must
   * not submit a second job with the same key while one is running. */
  key: string;
  run: (signal: AbortSignal) => Promise<void>;
}

interface QueuedJob extends SchedulerJob {
  signal: AbortController;
}

/**
 * Priority scheduler with per-provider model-call concurrency limits
 * (default 4) and a global limit of 2 concurrent background loops.
 * Same priority runs FIFO; a running job is never preempted.
 */
export class Scheduler {
  readonly #queue: QueuedJob[] = [];
  readonly #providerActive = new Map<string, number>();
  #backgroundActive = 0;
  readonly #logger: CoreLogger;
  #concurrency: { default: number } & Record<string, number> = { default: 4 };
  #stopped = false;

  constructor(logger: CoreLogger) {
    this.#logger = logger;
  }

  /** Applies the provider-concurrency settings ({ default, [providerId]: n }). */
  setConcurrency(config: { default: number } & Record<string, number>): void {
    this.#concurrency = config;
    this.#drain();
  }

  concurrencyFor(provider: string): number {
    const override = this.#concurrency[provider];
    return Math.max(1, Math.min(16, override ?? this.#concurrency.default));
  }

  submit(job: SchedulerJob): void {
    if (this.#stopped) return;
    this.#queue.push({ ...job, signal: new AbortController() });
    this.#drain();
  }

  /** Depth of the queue for a serialization key (0 = idle). */
  pendingForKey(key: string): number {
    return this.#queue.filter((j) => j.key === key).length;
  }

  stop(): void {
    this.#stopped = true;
    for (const job of this.#queue.splice(0)) {
      job.signal.abort();
    }
  }

  #drain(): void {
    while (!this.#stopped && this.#queue.length > 0) {
      const index = Scheduler.#startableIndex(this);
      // Highest priority first, FIFO within a priority. A candidate whose
      // provider is at its concurrency limit (or a background slot shortage)
      // is skipped, not head-of-line blocking: lower-priority work for other
      // providers may still start (BR-P01-003). -1 = nothing can start now.
      if (index === -1) return;
      const job = this.#queue[index]!;
      this.#queue.splice(index, 1);
      if (job.priority === 2) this.#backgroundActive += 1;
      this.#providerActive.set(job.provider, (this.#providerActive.get(job.provider) ?? 0) + 1);
      void job
        .run(job.signal.signal)
        .catch((error) => {
          // A late rejection can land after close() destroyed the logger
          // (pino's sync write would become an unhandled rejection).
          try {
            this.#logger.error(
              { key: job.key, provider: job.provider, error: error instanceof Error ? error.message : String(error) },
              'scheduled job failed',
            );
          } catch {
            // Logger already torn down; nothing to report to.
          }
        })
        .finally(() => {
          this.#providerActive.set(job.provider, (this.#providerActive.get(job.provider) ?? 1) - 1);
          if (job.priority === 2) this.#backgroundActive -= 1;
          this.#drain();
        });
    }
  }

  /** First queue index (priority order) whose job may start now, or -1. */
  static #startableIndex(scheduler: Scheduler): number {
    for (const priority of [0, 1, 2] as const) {
      const index = scheduler.#queue.findIndex(
        (job) => job.priority === priority && Scheduler.#runnable(job, scheduler),
      );
      if (index !== -1) return index;
    }
    return -1;
  }

  static #runnable(job: QueuedJob, scheduler: Scheduler): boolean {
    if (job.priority === 2 && scheduler.#backgroundActive >= BACKGROUND_LOOP_CONCURRENCY) return false;
    const active = scheduler.#providerActive.get(job.provider) ?? 0;
    return active < scheduler.concurrencyFor(job.provider);
  }
}
