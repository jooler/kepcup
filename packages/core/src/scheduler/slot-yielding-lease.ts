import type { RunIdentity } from '../agent/types.js';
import { LeaseService, type LeaseWaitHooks } from '../workdir/lease.js';
import type { Scheduler } from './scheduler.js';

/**
 * Write leases that never hold a scheduler slot while waiting (D75 审查 H2):
 * an acquisition that has to queue is awaited through
 * `Scheduler.yieldSlotWhile`, so the job running that run gives its provider
 * slot back until the lease is granted. Without it a run holding a slot and
 * waiting for a lease, and a lease holder (a write task, a pinned external
 * agent run) waiting for that slot, deadlock — at any provider limit.
 * An immediate grant keeps the slot (no yield). D140-1: shared acquisitions
 * granted alongside other shared holders take the same fast path — only an
 * acquisition that actually parked yields its slot.
 */
export class SlotYieldingLeaseService extends LeaseService {
  #scheduler: Scheduler | null = null;

  /** §2.5: the conflict predicate must reach `LeaseService`'s internals. */
  constructor(conflict?: (a: string, b: string) => boolean) {
    super(conflict);
  }

  /** The scheduler is built after the lease service (start.ts). */
  attachScheduler(scheduler: Scheduler): void {
    this.#scheduler = scheduler;
  }

  override acquire(identity: RunIdentity, key: string, hooks: LeaseWaitHooks = {}): Promise<void> {
    const pending = super.acquire(identity, key, hooks);
    // The fast path (free key, coexisting shared holders, or the run's own
    // key) grants synchronously inside super.acquire, leaving keyOf set.
    if (this.keyOf(identity.runId) === key || hooks.signal?.aborted === true) {
      return pending;
    }
    return this.#scheduler?.yieldSlotWhile(identity.runId, pending, hooks.signal) ?? pending;
  }
}
