import type { RunIdentity } from '../agent/types.js';
import { LeaseService, type LeaseWaitHooks } from '../project/lease.js';
import type { Scheduler } from './scheduler.js';

/**
 * Write leases that never hold a scheduler slot while waiting (D75 审查 H2):
 * an acquisition that has to queue is awaited through
 * `Scheduler.yieldSlotWhile`, so the job running that run gives its provider
 * slot back until the lease is granted. Without it a run holding a slot and
 * waiting for a lease, and a lease holder (a write task, a pinned external
 * agent run) waiting for that slot, deadlock — at any provider limit.
 * An immediate grant keeps the slot (no yield).
 */
export class SlotYieldingLeaseService extends LeaseService {
  #scheduler: Scheduler | null = null;

  /** The scheduler is built after the lease service (start.ts). */
  attachScheduler(scheduler: Scheduler): void {
    this.#scheduler = scheduler;
  }

  override acquire(identity: RunIdentity, key: string, hooks: LeaseWaitHooks = {}): Promise<void> {
    const pending = super.acquire(identity, key, hooks);
    // The fast path grants synchronously inside super.acquire.
    if (this.holderOf(key)?.runId === identity.runId || hooks.signal?.aborted === true) {
      return pending;
    }
    return this.#scheduler?.yieldSlotWhile(identity.runId, pending, hooks.signal) ?? pending;
  }
}
