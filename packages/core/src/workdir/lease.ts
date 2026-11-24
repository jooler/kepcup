import type { RunIdentity } from '../agent/types.js';

export type LeaseHolder = {
  runId: string;
  botId: string | null;
  conversationId: string | null;
  /**
   * D140-1: shared holders coexist on conflicting keys (built-in write tasks).
   * Shared × shared = coexist; shared × exclusive and exclusive × exclusive =
   * conflict (external agent runs, host operations, non-task
   * acquire_workdir_write stay exclusive).
   */
  shared: boolean;
};

export interface LeaseWaitHooks {
  /** Called once when the request must queue (the run flips to waiting_lease). */
  onWaiting?(holder: LeaseHolder): void;
  /** Cooperative cancellation (run cancel/abort while queued). */
  signal?: AbortSignal | undefined;
  /** D140-1: acquire coexistently with other shared holders (see LeaseHolder.shared). */
  shared?: boolean;
}

interface Waiter {
  identity: RunIdentity;
  key: string;
  hooks: LeaseWaitHooks;
  /** Set by cancelWait so the parked acquire loop unwinds without a signal. */
  cancelled: boolean;
  /** D140-1: enqueue order — promotion and FIFO fairness use it across keys. */
  seq: number;
  /** Resolves the loop's current park; null while the loop is deciding. */
  wake: (() => void) | null;
  /** A promotion already woke this park — a later round must not re-resolve it. */
  woken: boolean;
}

/** True when the two lease keys collide (same directory or ancestor). */
export function leaseKeysConflict(a: string, b: string): boolean {
  if (a === b) return true;
  return a.startsWith(b.endsWith('/') ? b : `${b}/`) || b.startsWith(a.endsWith('/') ? a : `${a}/`);
}

/**
 * Write leases (docs/design/08-workdir.md "并发：写入租约"), in-memory per the
 * phase doc: at most one lease per run — acquiring a second key first releases
 * the current one (the caller snapshots `after` through the released-run
 * hook). A key may hold several **shared** holders at once (D140-1: built-in
 * write tasks of the same root run in parallel); a single exclusive holder
 * blocks every conflicting acquisition, shared or not. Holders re-acquiring
 * their own key pass straight through; after a force revoke the same run must
 * queue again.
 */
export class LeaseService {
  readonly #holders = new Map<string, LeaseHolder[]>();
  readonly #queues = new Map<string, Waiter[]>();
  /** runId -> held key (one lease per run). */
  readonly #byRun = new Map<string, string>();
  /**
   * D123: keys may encode write domains (`{root}|domains:…`); the composed
   * lease service injects the domain-aware predicate. The default keeps the
   * historical prefix rule (plain-root keys, every other caller unchanged).
   */
  readonly #conflict: (a: string, b: string) => boolean;
  /** D140-1: waiter enqueue sequence for FIFO promotion across keys. */
  #waiterSeq = 0;

  constructor(conflict: (a: string, b: string) => boolean = leaseKeysConflict) {
    this.#conflict = conflict;
  }

  /**
   * Acquires the lease for `key`, blocking until it is held. The returned
   * promise never rejects; aborting the signal just removes the waiter (the
   * caller observes the abort itself). D140-1: a shared acquisition is granted
   * alongside other shared holders and waits only behind an exclusive one.
   */
  async acquire(identity: RunIdentity, key: string, hooks: LeaseWaitHooks = {}): Promise<void> {
    if (this.#byRun.get(identity.runId) === key) {
      return;
    }
    if (this.#byRun.has(identity.runId)) {
      // One lease per run: the caller released the previous key first; drop a
      // stale bookkeeping entry if it somehow survived.
      this.#purgeRun(identity.runId);
    }

    const shared = hooks.shared === true;
    // The waiter (one per acquire call) keeps its queue slot and seq across
    // wakes: a fresh arrival can never jump it, and re-checks stay FIFO.
    let waiter: Waiter | null = null;
    for (;;) {
      const conflicting = this.#holderBlocking(identity.runId, key, shared);
      if (
        conflicting === undefined &&
        !this.#earlierWaiterBlocks(identity.runId, key, waiter?.seq ?? null, shared)
      ) {
        if (waiter !== null) this.#removeWaiter(key, waiter);
        this.#grant(identity, key, shared);
        // Compatible waiters (shared × shared) may be admitted in the same
        // round; holders that are not compatible re-park themselves.
        this.#promote();
        return;
      }
      const signal = hooks.signal;
      if (signal?.aborted) {
        if (waiter !== null) {
          this.#removeWaiter(key, waiter);
          waiter.cancelled = true;
          this.#promote();
        }
        return;
      }
      if (waiter === null) {
        waiter = this.#enqueue(identity, key, hooks);
        if (conflicting !== undefined && waiter === this.#peekWaiter(key)) {
          hooks.onWaiting?.(conflicting);
        }
      } else {
        waiter.woken = false;
      }
      const parked = waiter;
      const promise = new Promise<void>((resolve) => {
        parked.wake = resolve;
      });
      const onAbort = () => this.cancelWait(identity.runId, key);
      signal?.addEventListener('abort', onAbort, { once: true });
      await promise;
      signal?.removeEventListener('abort', onAbort);
      parked.wake = null;
      if (parked.cancelled) {
        // cancelWait already removed the waiter and promoted the ones behind it.
        return;
      }
      // Loop re-checks: a holder may have appeared (or a grant lost the race).
    }
  }

  /**
   * Releases whatever lease `runId` holds (run ended/cancelled/replaced).
   * Returns the removed holder (null when the run held nothing).
   */
  release(runId: string): LeaseHolder | null {
    const key = this.#byRun.get(runId);
    if (key === undefined) return null;
    this.#byRun.delete(runId);
    const holder = this.#removeHolder(runId, key);
    this.#promote();
    return holder;
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
    if (index < 0) return;
    const waiter = queue.splice(index, 1)[0];
    if (waiter === undefined) return;
    if (queue.length === 0) this.#queues.delete(key);
    waiter.cancelled = true;
    const wake = waiter.wake;
    waiter.wake = null;
    wake?.();
    // The cancelled waiter may have been the only thing deferring the waiters
    // behind it (D140-1: shared waiters queue behind an earlier one without any
    // holder): give them their turn instead of parking forever.
    this.#promote();
  }

  /** Cancels every queued wait of the run (run cancel/interrupt). */
  cancelWaitersOfRun(runId: string): void {
    for (const key of this.waitersOfRun(runId)) this.cancelWait(runId, key);
  }

  /**
   * User-initiated force revoke: every holder of the key loses the lease
   * immediately; its next write attempt takes the full acquire path again.
   * Waiters are promoted.
   */
  forceRevoke(key: string): boolean {
    const holders = this.#holders.get(key);
    if (holders === undefined || holders.length === 0) return false;
    for (const holder of holders) this.#byRun.delete(holder.runId);
    this.#holders.delete(key);
    // Without the byRun entry a holder's next acquire takes the full queue
    // path, so a promoted waiter keeps its turn (用户强制收回).
    this.#promote();
    return true;
  }

  /** The key the run holds, or null (D75: a write task's sub run writes only meanwhile). */
  keyOf(runId: string): string | null {
    return this.#byRun.get(runId) ?? null;
  }

  /** The first holder of exactly this key (single-holder view for callers/tests). */
  holderOf(key: string): LeaseHolder | null {
    return this.#holders.get(key)?.[0] ?? null;
  }

  /** Every holder of exactly this key (D140-1: shared holders coexist). */
  holdersOf(key: string): LeaseHolder[] {
    return [...(this.#holders.get(key) ?? [])];
  }

  /**
   * The holder whose key conflicts with `key` under the injected predicate
   * (a domain-scoped task holds `dir:…|domains:…`, not the bare root). Used
   * by force revoke / revert, which ask for the workdir path. D140-1: a
   * shared holder may be returned — it still conflicts with an exclusive
   * request for the same key.
   */
  conflictingHolder(key: string): LeaseHolder | null {
    return this.conflictingHolders(key)[0] ?? null;
  }

  /** All holders whose key conflicts with `key` (shared ones included). */
  conflictingHolders(key: string): LeaseHolder[] {
    const holders: LeaseHolder[] = [];
    for (const [held, list] of this.#holders) {
      if (this.#conflict(held, key)) holders.push(...list);
    }
    return holders;
  }

  /** The key currently held by the run, when it is one of `keys`. */
  heldKey(runId: string, keys: string[]): string | null {
    const held = this.#byRun.get(runId);
    if (held === undefined) return null;
    return keys.some((k) => this.#conflict(held, k)) ? held : null;
  }

  // --- internals -------------------------------------------------------------

  /**
   * D140-1 conflict rule: `#conflict(heldKey, key)` and NOT both sides shared
   * → the held holder blocks this acquisition. Shared × shared coexists.
   */
  #holderBlocking(runId: string, key: string, shared: boolean): LeaseHolder | undefined {
    for (const [held, list] of this.#holders) {
      if (!this.#conflict(held, key)) continue;
      for (const holder of list) {
        if (holder.runId === runId) continue;
        if (shared && holder.shared) continue;
        return holder;
      }
    }
    return undefined;
  }

  /**
   * FIFO fairness: waiters queued earlier on a conflicting key must go first.
   * `mySeq` null = a fresh arrival (every queued waiter is earlier); a number
   * = only strictly smaller-seq waiters defer this one. A waiter keeps its seq
   * for the whole acquire call, so a wake never loses its queue position.
   *
   * An earlier **shared** waiter only defers a later exclusive one: two shared
   * waiters are compatible and may be admitted in the same round (D140-1's
   * parallel default), while an earlier exclusive waiter keeps its turn against
   * every later arrival (no hand-offs jumping a pending exclusive request).
   */
  #earlierWaiterBlocks(runId: string, key: string, mySeq: number | null, shared: boolean): boolean {
    for (const [held, queue] of this.#queues) {
      if (!this.#conflict(held, key)) continue;
      if (
        queue.some(
          (w) =>
            w.identity.runId !== runId &&
            (mySeq === null || w.seq < mySeq) &&
            !(shared && w.hooks.shared === true),
        )
      ) {
        return true;
      }
    }
    return false;
  }

  #grant(identity: RunIdentity, key: string, shared: boolean): void {
    const list = this.#holders.get(key) ?? [];
    list.push({ runId: identity.runId, botId: identity.botId, conversationId: identity.conversationId, shared });
    this.#holders.set(key, list);
    this.#byRun.set(identity.runId, key);
  }

  /** Drops the run's holder entry under `key` (empty lists delete the key). */
  #removeHolder(runId: string, key: string): LeaseHolder | null {
    const list = this.#holders.get(key);
    if (list === undefined) return null;
    const index = list.findIndex((holder) => holder.runId === runId);
    if (index < 0) return null;
    const [holder] = list.splice(index, 1);
    if (list.length === 0) this.#holders.delete(key);
    return holder ?? null;
  }

  /** Removes every trace of a run's stale bookkeeping (one lease per run). */
  #purgeRun(runId: string): void {
    const key = this.#byRun.get(runId);
    this.#byRun.delete(runId);
    if (key !== undefined) {
      this.#removeHolder(runId, key);
      this.#promote();
    }
  }

  #enqueue(identity: RunIdentity, key: string, hooks: LeaseWaitHooks): Waiter {
    const waiter: Waiter = {
      identity,
      key,
      hooks,
      cancelled: false,
      seq: (this.#waiterSeq += 1),
      wake: null,
      woken: false,
    };
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
    if (queue.length === 0) this.#queues.delete(key);
  }

  /**
   * Wakes every waiter no holder blocks any more, in enqueue order (D140-1:
   * freeing one exclusive holder may admit several shared waiters at once).
   * Promotion never grants and never removes the waiter: it only resolves the
   * current park, and each waiter's own loop re-checks both conditions
   * (conflicting holder, strictly-earlier conflicting waiter) to grant, to park
   * again (keeping its seq) or to unwind if cancelled. Keeping a woken waiter
   * in its queue slot means a fresh arrival cannot jump it before it decides.
   */
  #promote(): void {
    const woken: Waiter[] = [];
    for (const queue of this.#queues.values()) {
      for (const waiter of queue) {
        if (waiter.woken || waiter.cancelled) continue;
        if (
          this.#holderBlocking(waiter.identity.runId, waiter.key, waiter.hooks.shared === true) ===
          undefined
        ) {
          waiter.woken = true;
          woken.push(waiter);
        }
      }
    }
    woken.sort((a, b) => a.seq - b.seq);
    for (const waiter of woken) waiter.wake?.();
  }
}
