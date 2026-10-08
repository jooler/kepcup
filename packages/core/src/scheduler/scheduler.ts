import { AsyncLocalStorage } from 'node:async_hooks';
import { BACKGROUND_LOOP_CONCURRENCY } from '@kepcup/shared';
import type { CoreLogger } from '../infra/logger.js';

export interface SchedulerJob {
  /**
   * 0 user-facing turns and lease-holding write tasks, 1 scheduled / event /
   * chain turns and read-only tasks, 2 background loops.
   */
  priority: 0 | 1 | 2;
  /** Provider id for the concurrency limit. */
  provider: string;
  /** Serialization key (e.g. mailbox `botId:conversationId`); callers must
   * not submit a second job with the same key while one is running. */
  key: string;
  /**
   * The run this job executes (D75 conversation turns and tasks). While that run waits
   * for a write lease inside the job (`yieldSlotWhile`), the job gives its
   * provider slot back — lease waits never hold a slot (D75 审查 H2).
   */
  runId?: string;
  /**
   * The job's run already holds a write lease (a D75 write task takes it
   * before submitting): it starts under the plain provider limit, like a
   * resuming job — runs queued for that lease wait on it — instead of keeping
   * a slot free for replies (D75 审查 round 2 #4).
   */
  leaseHeld?: boolean;
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
  /**
   * Lease waits of the job's run in progress (parallel tool calls): the slot
   * is given back on 0 → 1 and taken again on 1 → 0, so no wait ever runs
   * while the job holds a slot.
   */
  yieldDepth: number;
  /** The job ended: a late-finishing wait must not take a slot for it. */
  finished: boolean;
}

/** A yielded job waiting to take a slot again (its lease was granted). */
interface ResumingJob {
  running: RunningJob;
  resolve: () => void;
}

const isTaskJob = (job: SchedulerJob): boolean => job.key.startsWith('task:');
const isAgentProvider = (provider: string): boolean => provider.startsWith('agent:');

/**
 * Priority scheduler with per-provider model-call concurrency limits
 * (default 4) and a global limit of 2 concurrent background loops.
 * Same priority runs FIFO; a running job is never preempted. Background
 * loops on an external agent (`agent:*`) keep one of its slots free for
 * conversation turns (D72 P6 审查 C1).
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
   * Awaits `wait` (a write-lease acquisition or an ask_user wait of `runId`)
   * without occupying a provider slot: when called inside the job executing
   * `runId`, the job gives its slot back for the wait, then takes one again
   * before this resolves (yielded jobs go ahead of queued ones). Anywhere else
   * it just awaits.
   *
   * A run that stopped meanwhile does not take a slot back (D75 审查 M-1):
   * when `wait` rejects (callers' waits reject only when the run stops) or
   * `signal` — the run's own abort signal — is aborted, the job unwinds
   * without a slot (an aborted engine makes no further model call), so a
   * cancelled task frees its write lease and its place at once instead of
   * queueing behind the jobs that took its slot. An abort while queued to
   * take the slot back lets the job go on slotless too.
   */
  async yieldSlotWhile<T>(runId: string, wait: Promise<T>, signal?: AbortSignal): Promise<T> {
    const running = this.#current.getStore();
    if (running === undefined || running.job.runId !== runId || running.finished) return wait;
    running.yieldDepth += 1;
    if (running.yieldDepth === 1) {
      // An earlier wait of this job still queued to take the slot back goes
      // on without it: this wait now owns the re-take.
      const resuming = this.#resuming.findIndex((r) => r.running === running);
      if (resuming !== -1) this.#resuming.splice(resuming, 1)[0]?.resolve();
      this.#giveSlot(running);
      this.#drain();
    }
    let rejected = false;
    try {
      return await wait;
    } catch (error) {
      rejected = true;
      throw error;
    } finally {
      running.yieldDepth -= 1;
      // The last wait of the job to end takes the slot back; earlier ones
      // continue without it (their tool work needs no model slot, and the
      // engine's next model call awaits every parallel tool call).
      if (
        running.yieldDepth === 0 &&
        !running.finished &&
        !this.#stopped &&
        !rejected &&
        signal?.aborted !== true
      ) {
        await this.#resume(running, signal);
      }
    }
  }

  /** Queues a yielded job to take a slot again; an abort of `signal` lets it go on without one. */
  #resume(running: RunningJob, signal: AbortSignal | undefined): Promise<void> {
    return new Promise<void>((resolve) => {
      const entry: ResumingJob = {
        running,
        resolve: () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        },
      };
      const onAbort = (): void => {
        const index = this.#resuming.indexOf(entry);
        if (index !== -1) this.#resuming.splice(index, 1);
        entry.resolve();
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#resuming.push(entry);
      this.#drain();
    });
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
      const running: RunningJob = { job, holdsSlot: false, yieldDepth: 0, finished: false };
      this.#takeSlot(running);
      let started: Promise<void>;
      try {
        started = this.#current.run(running, () => job.run(job.signal.signal));
      } catch (error) {
        // A synchronous throw must still reach the finally below (slot release).
        started = Promise.reject(error);
      }
      void started
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
          running.finished = true;
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
    // least one of the agent's slots stays free for turns / tasks (priority 0/1)
    // — a whole agent session can hold a slot for minutes. With a limit of 1
    // (the router never routes background work there) no slot is reserved,
    // so a job queued before the limit changed still runs.
    if (job.priority === 2 && job.provider.startsWith('agent:') && limit > 1) {
      return active < limit - 1;
    }
    // D75 tasks (key `task:{id}`) run for minutes to hours and are never
    // preempted: like background loops on an agent, they may only start while
    // a slot of their provider stays free for conversation replies.
    // A write task already holding its lease (`leaseHeld`) instead starts
    // whenever a slot is free and tasks leave one free for replies: writers
    // queued behind that lease wait on it, so replies must not starve it, yet
    // tasks together still never take the provider's last slot (审查复核).
    // Not on an external agent (`agent:*`, design 30 §8.1 / §8.5): replies
    // (conversation turns) run on the built-in engine, so the agent's slots
    // are its tasks' — task concurrency = the agent's limit, which follows
    // `features.parallelSessions` (1 without parallel sessions).
    // This holds because conversation turns never run on `agent:*` (D75 W2
    // pins them to the built-in engine; the §8.4 downgrade routes without a
    // model call). The only priority-0 job left there is an agent-backed
    // group triage: it is bounded by its own timeout, counted from
    // submission, and fails open to mention-only (dispatcher.ts, 审查 M6) —
    // it never waits for these tasks indefinitely. If a turn ever runs on an
    // agent again (design 30 §8.4 level 1 through the agent's complete()),
    // restore the reply reserve for agent providers.
    if (isTaskJob(job) && limit > 1 && !isAgentProvider(job.provider)) {
      if (job.leaseHeld !== true) return active < limit - 1;
      const taskActive = scheduler.#providerTaskActive.get(job.provider) ?? 0;
      return active < limit && taskActive < limit - 1;
    }
    if (active < limit) return true;
    // D75 审查 M3: tasks run for hours and are never preempted. When every
    // occupied slot of the provider is held by a task (a limit of 1 reserves
    // nothing above), a conversation reply (priority 0) may borrow one slot
    // beyond the limit rather than starve behind them. Never on an external
    // agent: its limit is what its process can run at once (a limit of 1 =
    // no parallel sessions, design 30 §8.2), not a budget to borrow against.
    return (
      job.priority === 0 &&
      !isTaskJob(job) &&
      !isAgentProvider(job.provider) &&
      active === limit &&
      (scheduler.#providerTaskActive.get(job.provider) ?? 0) === active
    );
  }
}
