import { AsyncLocalStorage } from 'node:async_hooks';
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
  /**
   * The run this job executes (response runs, D75 tasks). While that run waits
   * for a write lease inside the job (`yieldSlotWhile`), the job gives its
   * provider slot back — lease waits never hold a slot (D75 审查 H2).
   */
  runId?: string;
  run: (signal: AbortSignal) => Promise<void>;
}

export interface SchedulerOptions {
  /**
   * Concurrency limit of external agent `agentId` (`agent:{id}` jobs, D72)
   * given the provider-concurrency settings — `agentConcurrency()` over the
   * agent catalog (default per `features.parallelSessions`, overrides clamped
   * to 1 for agents without parallel sessions). Without it every agent runs
   * one job at a time (fail-safe).
   */
  agentConcurrency?: (
    agentId: string,
    config: Readonly<Record<string, number | undefined>>,
  ) => number;
}

interface QueuedJob extends SchedulerJob {
  signal: AbortController;
}

/** A started job: whether it currently occupies a provider slot. */
interface RunningJob {
  job: QueuedJob;
  holdsSlot: boolean;
}

/** A yielded job waiting to take a slot again (its lease was granted). */
interface ResumingJob {
  running: RunningJob;
  resolve: () => void;
}

const isTaskJob = (job: SchedulerJob): boolean => job.key.startsWith('task:');

/**
 * Priority scheduler with per-provider model-call concurrency limits
 * (default 4) and a global limit of 2 concurrent background loops.
 * Same priority runs FIFO; a running job is never preempted. Background
 * loops on an external agent (`agent:*`) keep one of its slots free for
 * responses (D72 P6 审查 C1).
 *
 * Write leases and slots never form a hold-and-wait cycle (D75 审查 H2): a job
 * whose run waits for a write lease gives its slot back for the wait and takes
 * one again — ahead of queued jobs — once the lease is granted
 * (`yieldSlotWhile`, wired into lease acquisition by SlotYieldingLeaseService).
 * So a slot holder never waits for a lease, and a lease holder waiting for a
 * slot (a write task, a resuming job) waits only for jobs that progress.
 */
export class Scheduler {
  readonly #queue: QueuedJob[] = [];
  readonly #resuming: ResumingJob[] = [];
  readonly #providerActive = new Map<string, number>();
  /** Slots held by D75 task jobs (`task:*`), per provider. */
  readonly #providerTaskActive = new Map<string, number>();
  readonly #current = new AsyncLocalStorage<RunningJob>();
  #backgroundActive = 0;
  readonly #logger: CoreLogger;
  #concurrency: { default: number } & Record<string, number> = { default: 4 };
  #stopped = false;
  readonly #agentConcurrency: SchedulerOptions['agentConcurrency'];

  constructor(logger: CoreLogger, options: SchedulerOptions = {}) {
    this.#logger = logger;
    this.#agentConcurrency = options.agentConcurrency;
  }

  /** Applies the provider-concurrency settings ({ default, [providerId]: n }). */
  setConcurrency(config: { default: number } & Record<string, number>): void {
    this.#concurrency = config;
    this.#drain();
  }

  concurrencyFor(provider: string): number {
    // External agents (`agent:{id}`, D72 P5): each run is a whole agent
    // session, and all sessions of an agent share one process — the limit
    // follows the agent's `features.parallelSessions` (resolver above).
    if (provider.startsWith('agent:')) {
      const limit = this.#agentConcurrency?.(provider.slice('agent:'.length), this.#concurrency);
      return Math.max(1, Math.min(16, limit ?? 1));
    }
    return Math.max(1, Math.min(16, this.#concurrency[provider] ?? this.#concurrency.default));
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

  /**
   * Removes a job that has not started yet (its signal aborts). Returns false
   * when no queued job has that key (already started, finished or unknown).
   */
  cancelQueued(key: string): boolean {
    const index = this.#queue.findIndex((job) => job.key === key);
    if (index === -1) return false;
    const [job] = this.#queue.splice(index, 1);
    job?.signal.abort();
    return true;
  }

  /**
   * Awaits `wait` (a write-lease acquisition of `runId`) without occupying a
   * provider slot: when called inside the job executing `runId`, the job gives
   * its slot back for the wait, then takes one again before this resolves
   * (yielded jobs go ahead of queued ones). Anywhere else it just awaits.
   */
  async yieldSlotWhile<T>(runId: string, wait: Promise<T>): Promise<T> {
    const running = this.#current.getStore();
    if (running === undefined || running.job.runId !== runId || !running.holdsSlot) return wait;
    this.#giveSlot(running);
    this.#drain();
    try {
      return await wait;
    } finally {
      if (!this.#stopped) {
        await new Promise<void>((resolve) => {
          this.#resuming.push({ running, resolve });
          this.#drain();
        });
      }
    }
  }

  stop(): void {
    this.#stopped = true;
    for (const job of this.#queue.splice(0)) {
      job.signal.abort();
    }
    // Yielded jobs continue (the app is closing; slots no longer matter).
    for (const resuming of this.#resuming.splice(0)) resuming.resolve();
  }

  #takeSlot(running: RunningJob): void {
    const { job } = running;
    running.holdsSlot = true;
    if (job.priority === 2) this.#backgroundActive += 1;
    this.#providerActive.set(job.provider, (this.#providerActive.get(job.provider) ?? 0) + 1);
    if (isTaskJob(job)) {
      this.#providerTaskActive.set(
        job.provider,
        (this.#providerTaskActive.get(job.provider) ?? 0) + 1,
      );
    }
  }

  #giveSlot(running: RunningJob): void {
    const { job } = running;
    if (!running.holdsSlot) return;
    running.holdsSlot = false;
    if (job.priority === 2) this.#backgroundActive -= 1;
    this.#providerActive.set(job.provider, (this.#providerActive.get(job.provider) ?? 1) - 1);
    if (isTaskJob(job)) {
      this.#providerTaskActive.set(
        job.provider,
        (this.#providerTaskActive.get(job.provider) ?? 1) - 1,
      );
    }
  }

  #drain(): void {
    // Yielded jobs whose lease was granted resume first: they already started
    // and hold a write lease that others may be waiting for.
    for (let i = 0; !this.#stopped && i < this.#resuming.length; ) {
      const resuming = this.#resuming[i]!;
      if (!Scheduler.#runnable(resuming.running.job, this)) {
        i += 1;
        continue;
      }
      this.#resuming.splice(i, 1);
      this.#takeSlot(resuming.running);
      resuming.resolve();
    }
    while (!this.#stopped && this.#queue.length > 0) {
      const index = Scheduler.#startableIndex(this);
      // Highest priority first, FIFO within a priority. A candidate whose
      // provider is at its concurrency limit (or a background slot shortage)
      // is skipped, not head-of-line blocking: lower-priority work for other
      // providers may still start (BR-P01-003). -1 = nothing can start now.
      if (index === -1) return;
      const job = this.#queue[index]!;
      this.#queue.splice(index, 1);
      const running: RunningJob = { job, holdsSlot: false };
      this.#takeSlot(running);
      void this.#current
        .run(running, () => job.run(job.signal.signal))
        .catch((error) => {
          // A late rejection can land after close() destroyed the logger
          // (pino's sync write would become an unhandled rejection).
          try {
            this.#logger.error(
              {
                key: job.key,
                provider: job.provider,
                error: error instanceof Error ? error.message : String(error),
              },
              'scheduled job failed',
            );
          } catch {
            // Logger already torn down; nothing to report to.
          }
        })
        .finally(() => {
          // A job that ended while waiting to resume (it did not await the
          // wait) leaves the resume queue.
          const index = this.#resuming.findIndex((r) => r.running === running);
          if (index !== -1) this.#resuming.splice(index, 1)[0]?.resolve();
          this.#giveSlot(running);
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
    if (job.priority === 2 && scheduler.#backgroundActive >= BACKGROUND_LOOP_CONCURRENCY)
      return false;
    const active = scheduler.#providerActive.get(job.provider) ?? 0;
    const limit = scheduler.concurrencyFor(job.provider);
    // External agents (审查 C1): background loops may only start while at
    // least one of the agent's slots stays free for responses (priority 0/1)
    // — a whole agent session can hold a slot for minutes. With a limit of 1
    // (the router never routes background work there) no slot is reserved,
    // so a job queued before the limit changed still runs.
    if (job.priority === 2 && job.provider.startsWith('agent:') && limit > 1) {
      return active < limit - 1;
    }
    // D75 tasks (key `task:{id}`) run for minutes to hours and are never
    // preempted: like background loops on an agent, they may only start while
    // a slot of their provider stays free for conversation replies.
    if (isTaskJob(job) && limit > 1) {
      return active < limit - 1;
    }
    if (active < limit) return true;
    // D75 审查 M3: tasks run for hours and are never preempted. When every
    // occupied slot of the provider is held by a task (a limit of 1 reserves
    // nothing above), a conversation reply (priority 0) may borrow one slot
    // beyond the limit rather than starve behind them.
    return (
      job.priority === 0 &&
      active === limit &&
      (scheduler.#providerTaskActive.get(job.provider) ?? 0) === active
    );
  }
}
