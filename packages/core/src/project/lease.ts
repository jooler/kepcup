import type { RunIdentity } from '../agent/types.js';

export type LeaseHolder = {
  runId: string;
  botId: string | null;
  conversationId: string | null;
};

export interface LeaseWaitHooks {
  /** Called once when the request must queue (the run flips to waiting_lease). */
  onWaiting?(holder: LeaseHolder): void;
  /** Cooperative cancellation (run cancel/abort while queued). */
  signal?: AbortSignal | undefined;
}

interface Waiter {
  identity: RunIdentity;
  key: string;
  hooks: LeaseWaitHooks;
  /** Resolves when the waiter is promoted or cancelled (loop re-checks after). */
  promise: Promise<void>;
  resolve: () => void;
  /** Set by cancelWait so the parked acquire loop unwinds without a signal. */
  cancelled: boolean;
}

/** True when the two lease keys collide (same directory or ancestor). */
export function leaseKeysConflict(a: string, b: string): boolean {
  if (a === b) return true;
  return a.startsWith(b.endsWith('/') ? b : `${b}/`) || b.startsWith(a.endsWith('/') ? a : `${a}/`);
}

/**
 * Write leases (docs/design/08-project.md "并发：写入租约"), in-memory per the
 * phase doc: one holder per lease key (the project root or an authorized
 * directory), FIFO queue of waiters, at most one lease per run — acquiring a
 * second key first releases the current one (the caller snapshots `after`
 * through the released-run hook). Holders re-acquiring their own key pass
 * straight through; after a force revoke the same run must queue again.
 */
export class LeaseService {
  readonly #holders = new Map<string, LeaseHolder>();
  readonly #queues = new Map<string, Waiter[]>();
  /** runId -> held key (one lease per run). */
  readonly #byRun = new Map<string, string>();

  /**
   * Acquires the lease for `key`, blocking until it is held. The returned
   * promise never rejects; aborting the signal just removes the waiter (the
   * caller observes the abort itself).
   */
  async acquire(identity: RunIdentity, key: string, hooks: LeaseWaitHooks = {}): Promise<void> {
    if (this.#byRun.get(identity.runId) === key) {
      return;
    }
    if (this.#byRun.has(identity.runId)) {
      // One lease per run: the caller released the previous key first; drop a
      // stale bookkeeping entry if it somehow survived.
      this.#byRun.delete(identity.runId);
    }

    for (;;) {
      const conflicting = [...this.#holders.entries()].find(([held]) => leaseKeysConflict(held, key));
      if (conflicting === undefined) {
        // Conflicting waiters queued ahead of us keep FIFO fairness: only grant
        // when no earlier waiter for the same key is still pending.
        const queue = this.#queues.get(key) ?? [];
        const earliestConflictingWaiter = queue.find((w) => w.identity.runId !== identity.runId);
        if (earliestConflictingWaiter === undefined) {
          this.#grant(identity, key);
          return;
        }
      }
      const holder = conflicting?.[1];
      const signal = hooks.signal;
      if (signal?.aborted) return;
      const waiter = this.#enqueue(identity, key, hooks);
      if (holder !== undefined && waiter === this.#peekWaiter(key)) {
        hooks.onWaiting?.(holder);
      }
      const onAbort = () => this.cancelWait(identity.runId, key);
      signal?.addEventListener('abort', onAbort, { once: true });
      await waiter.promise;
      signal?.removeEventListener('abort', onAbort);
      if (waiter.cancelled || signal?.aborted) {
        this.#removeWaiter(key, waiter);
        return;
      }
      // Loop re-checks: another waiter may have won the race.
    }
  }

  /** Releases whatever lease `runId` holds (run ended/cancelled/replaced). */
  release(runId: string): LeaseHolder | null {
    const key = this.#byRun.get(runId);
    if (key === undefined) return null;
    this.#byRun.delete(runId);
    const holder = this.#holders.get(key);
    if (holder !== undefined && holder.runId === runId) {
      this.#holders.delete(key);
    }
    this.#promoteConflicting(key);
    return holder ?? null;
  }

  /** Runs waiting on any key (cancel/interrupt cleanup resolves them). */
  waitersOfRun(runId: string): string[] {
    const keys: string[] = [];
    for (const [key, queue] of this.#queues) {
      if (queue.some((w) => w.identity.runId === runId)) keys.push(key);
    }
    return keys;
  }

  /** Cancels a queued wait (the run is gone; the loop's await must unwind). */
  cancelWait(runId: string, key: string): void {
    const queue = this.#queues.get(key);
    if (queue === undefined) return;
    const index = queue.findIndex((w) => w.identity.runId === runId);
    if (index >= 0) {
      const waiter = queue.splice(index, 1)[0];
      if (waiter === undefined) return;
      waiter.cancelled = true;
      waiter.resolve();
    }
  }

  /** Cancels every queued wait of the run (run cancel/interrupt). */
  cancelWaitersOfRun(runId: string): void {
    for (const key of this.waitersOfRun(runId)) this.cancelWait(runId, key);
  }

  /**
   * User-initiated force revoke: the holder loses the lease immediately; its
   * next write attempt takes the full acquire path again. Waiters are promoted.
   */
  forceRevoke(key: string): boolean {
    const holder = this.#holders.get(key);
    if (holder === undefined) return false;
    this.#holders.delete(key);
    this.#byRun.delete(holder.runId);
    // Without the byRun entry the holder's next acquire takes the full queue
    // path, so a promoted waiter keeps its turn (用户强制收回).
    this.#promoteConflicting(key);
    return true;
  }

  /** The key the run holds, or null (D75: a write task's sub run writes only meanwhile). */
  keyOf(runId: string): string | null {
    return this.#byRun.get(runId) ?? null;
  }

  holderOf(key: string): LeaseHolder | null {
    return this.#holders.get(key) ?? null;
  }

  /** The key currently held by the run, when it is one of `keys`. */
  heldKey(runId: string, keys: string[]): string | null {
    const held = this.#byRun.get(runId);
    if (held === undefined) return null;
    return keys.some((k) => leaseKeysConflict(held, k)) ? held : null;
  }

  // --- internals -------------------------------------------------------------

  #grant(identity: RunIdentity, key: string): void {
    this.#holders.set(key, { runId: identity.runId, botId: identity.botId, conversationId: identity.conversationId });
    this.#byRun.set(identity.runId, key);
  }


  #enqueue(identity: RunIdentity, key: string, hooks: LeaseWaitHooks): Waiter {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    const waiter: Waiter = { identity, key, hooks, promise, resolve, cancelled: false };
    const queue = this.#queues.get(key) ?? [];
    queue.push(waiter);
    this.#queues.set(key, queue);
    return waiter;
  }

  #peekWaiter(key: string): Waiter | null {
    return this.#queues.get(key)?.[0] ?? null;
  }

  #removeWaiter(key: string, waiter: Waiter): void {
    const queue = this.#queues.get(key);
    if (queue === undefined) return;
    const index = queue.indexOf(waiter);
    if (index >= 0) queue.splice(index, 1);
  }

  /**
   * Wakes the longest-waiting waiter of every queue whose key conflicts with
   * the freed key (a `/proj/sub` waiter queues under its own key while the
   * `/proj` holder blocks it). Only one waiter is woken per release round —
   * the newly granted holder's release wakes the next one.
   */
  #promoteConflicting(freedKey: string): void {
    let best: { key: string; waiter: Waiter } | null = null;
    for (const [key, queue] of this.#queues) {
      if (!leaseKeysConflict(key, freedKey)) continue;
      const waiter = queue[0];
      if (waiter === undefined) continue;
      if (best === null || waiter.identity.runId < best.waiter.identity.runId) {
        best = { key, waiter };
      }
    }
    if (best === null) return;
    const queue = this.#queues.get(best.key);
    const index = queue?.indexOf(best.waiter) ?? -1;
    if (queue !== undefined && index >= 0) queue.splice(index, 1);
    best.waiter.resolve();
  }
}
