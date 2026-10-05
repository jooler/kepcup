import { describe, expect, it } from 'vitest';

import { LeaseService, leaseKeysConflict } from '../../src/project/lease.js';
import type { RunIdentity } from '../../src/agent/types.js';

const idA: RunIdentity = { runId: 'run_a', botId: 'bot_a', conversationId: 'conv_a', loopType: 'response' };
const idB: RunIdentity = { runId: 'run_b', botId: 'bot_b', conversationId: 'conv_b', loopType: 'response' };

describe('lease conflict rule (相同 / 祖先 / 兄弟)', () => {
  it('treats identical keys as conflicting', () => {
    expect(leaseKeysConflict('/proj', '/proj')).toBe(true);
  });

  it('treats ancestor and descendant as conflicting in both directions', () => {
    expect(leaseKeysConflict('/proj', '/proj/sub')).toBe(true);
    expect(leaseKeysConflict('/proj/sub', '/proj')).toBe(true);
    // Prefix strings that are not path ancestors do not conflict.
    expect(leaseKeysConflict('/project', '/proj')).toBe(false);
  });

  it('treats siblings as non-conflicting', () => {
    expect(leaseKeysConflict('/proj/a', '/proj/b')).toBe(false);
  });
});

describe('LeaseService', () => {
  it('grants immediately when free and re-acquire for the same run is a no-op', async () => {
    const leases = new LeaseService();
    await leases.acquire(idA, '/proj');
    expect(leases.holderOf('/proj')?.runId).toBe('run_a');
    await leases.acquire(idA, '/proj');
    expect(leases.holderOf('/proj')?.runId).toBe('run_a');
  });

  it('queues a conflicting acquirer FIFO and reports the holder', async () => {
    const leases = new LeaseService();
    await leases.acquire(idA, '/proj');
    const waiting: string[] = [];
    const pending = leases.acquire(idB, '/proj', {
      onWaiting: (holder) => waiting.push(holder.runId),
    });
    await Promise.resolve();
    expect(waiting).toEqual(['run_a']);
    expect(leases.release(idA.runId)?.runId).toBe('run_a');
    await pending;
    expect(leases.holderOf('/proj')?.runId).toBe('run_b');
  });

  it('resolves ancestor conflicts (lease keys are directories)', async () => {
    const leases = new LeaseService();
    await leases.acquire(idA, '/proj');
    const pending = leases.acquire(idB, '/proj/sub');
    await Promise.resolve();
    expect(leases.holderOf('/proj/sub')).toBeNull();
    leases.release(idA.runId);
    await pending;
    expect(leases.holderOf('/proj/sub')?.runId).toBe('run_b');
  });

  it('lets sibling keys run concurrently', async () => {
    const leases = new LeaseService();
    await leases.acquire(idA, '/proj/a');
    await leases.acquire(idB, '/proj/b');
    expect(leases.holderOf('/proj/a')?.runId).toBe('run_a');
    expect(leases.holderOf('/proj/b')?.runId).toBe('run_b');
  });

  it('cancels a queued wait when the run dies', async () => {
    const leases = new LeaseService();
    await leases.acquire(idA, '/proj');
    let settled = false;
    const pending = leases.acquire(idB, '/proj').then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    // The run was cancelled: its queued wait must unwind without a grant.
    expect(leases.cancelWaitersOfRun(idB.runId));
    await pending;
    expect(settled).toBe(true);
    expect(leases.holderOf('/proj')?.runId).toBe('run_a');
  });

  it('force revoke frees the lease and the holder must re-acquire', async () => {
    const leases = new LeaseService();
    await leases.acquire(idA, '/proj');
    expect(leases.forceRevoke('/proj')).toBe(true);
    expect(leases.holderOf('/proj')).toBeNull();
    // The revoked holder acquires again (write path re-applies).
    await leases.acquire(idA, '/proj');
    expect(leases.holderOf('/proj')?.runId).toBe('run_a');
    // Revoking a free key reports false.
    expect(leases.forceRevoke('/other')).toBe(false);
  });

  it('promotes the first waiter on force revoke (no starvation)', async () => {
    const leases = new LeaseService();
    await leases.acquire(idA, '/proj');
    const pending = leases.acquire(idB, '/proj');
    await Promise.resolve();
    leases.forceRevoke('/proj');
    await pending;
    expect(leases.holderOf('/proj')?.runId).toBe('run_b');
  });

  it('heldKey matches conflicting keys of a run', async () => {
    const leases = new LeaseService();
    await leases.acquire(idA, '/proj');
    expect(leases.heldKey(idA.runId, ['/proj'])).toBe('/proj');
    expect(leases.heldKey(idA.runId, ['/proj/nested/deep'])).toBe('/proj');
    expect(leases.heldKey(idA.runId, ['/elsewhere'])).toBeNull();
  });
});
