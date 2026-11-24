import { describe, expect, it } from 'vitest';

import { LeaseService, leaseKeysConflict } from '../../src/workdir/lease.js';
import { encodeWriteDomainKey, writeDomainKeysConflict } from '../../src/workdir/domains.js';
import type { RunIdentity } from '../../src/agent/types.js';

const idA: RunIdentity = { runId: 'run_a', botId: 'bot_a', conversationId: 'conv_a', loopType: 'turn' };
const idB: RunIdentity = { runId: 'run_b', botId: 'bot_b', conversationId: 'conv_b', loopType: 'turn' };

describe('lease conflict rule (相同 / 祖先 / 兄弟)', () => {
  it('treats identical keys as conflicting', () => {
    expect(leaseKeysConflict('/proj', '/proj')).toBe(true);
  });

  it('treats ancestor and descendant as conflicting in both directions', () => {
    expect(leaseKeysConflict('/proj', '/proj/sub')).toBe(true);
    expect(leaseKeysConflict('/proj/sub', '/proj')).toBe(true);
    // Prefix strings that are not path ancestors do not conflict.
    expect(leaseKeysConflict('/workdir', '/proj')).toBe(false);
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

describe('shared holders (D140-1)', () => {
  it('coexists shared × shared on the same key', async () => {
    const leases = new LeaseService();
    await leases.acquire(idA, '/proj', { shared: true });
    // The second shared holder is granted at once — no waiting callback fired.
    let waited = false;
    await leases.acquire(idB, '/proj', {
      shared: true,
      onWaiting: () => {
        waited = true;
      },
    });
    expect(waited).toBe(false);
    expect(leases.holdersOf('/proj').map((holder) => holder.runId)).toEqual(['run_a', 'run_b']);
    expect(leases.holdersOf('/proj').every((holder) => holder.shared)).toBe(true);
    // heldKey / keyOf see each holder's own lease.
    expect(leases.heldKey(idB.runId, ['/proj'])).toBe('/proj');
    // Releasing one holder leaves the other intact (no promotion needed).
    expect(leases.release(idA.runId)?.runId).toBe('run_a');
    expect(leases.holdersOf('/proj').map((holder) => holder.runId)).toEqual(['run_b']);
  });

  it('shared × exclusive conflicts both ways', async () => {
    const leases = new LeaseService();
    await leases.acquire(idA, '/proj', { shared: true });
    // A shared holder also blocks an exclusive acquirer (external agent run /
    // host operation) — and conflictingHolder may return a shared holder.
    expect(leases.conflictingHolder('/proj')?.runId).toBe('run_a');
    let settled = false;
    const pending = leases.acquire(idB, '/proj').then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    leases.release(idA.runId);
    await pending;
    expect(leases.holderOf('/proj')?.runId).toBe('run_b');
    expect(leases.holderOf('/proj')?.shared).toBe(false);
    // And an exclusive holder blocks a later shared acquirer.
    const idC: RunIdentity = { runId: 'run_c', botId: null, conversationId: null, loopType: 'turn' };
    const sharedPending = leases.acquire(idC, '/proj', { shared: true });
    await Promise.resolve();
    expect(leases.holdersOf('/proj').some((holder) => holder.runId === 'run_c')).toBe(false);
    leases.release(idB.runId);
    await sharedPending;
    expect(leases.holdersOf('/proj').map((holder) => holder.runId)).toEqual(['run_c']);
  });

  it('promotes several shared waiters when an exclusive holder releases', async () => {
    const leases = new LeaseService();
    const idC: RunIdentity = { runId: 'run_c', botId: null, conversationId: null, loopType: 'turn' };
    await leases.acquire(idA, '/proj'); // exclusive
    const waiting: string[] = [];
    const bPending = leases.acquire(idB, '/proj', {
      shared: true,
      onWaiting: (holder) => waiting.push(holder.runId),
    });
    const cPending = leases.acquire(idC, '/proj', { shared: true });
    await Promise.resolve();
    expect(waiting).toEqual(['run_a']);
    leases.release(idA.runId);
    await Promise.all([bPending, cPending]);
    expect(new Set(leases.holdersOf('/proj').map((holder) => holder.runId))).toEqual(
      new Set(['run_b', 'run_c']),
    );
  });

  it('FIFO: an earlier exclusive waiter is not jumped by a later shared one', async () => {
    const leases = new LeaseService();
    const idC: RunIdentity = { runId: 'run_c', botId: null, conversationId: null, loopType: 'turn' };
    await leases.acquire(idA, '/proj'); // exclusive holder
    const exclusive = leases.acquire(idB, '/proj'); // queued first
    await Promise.resolve();
    const shared = leases.acquire(idC, '/proj', { shared: true }); // queued second
    await Promise.resolve();
    leases.release(idA.runId);
    await exclusive;
    expect(leases.holdersOf('/proj').map((holder) => holder.runId)).toEqual(['run_b']);
    leases.release(idB.runId);
    await shared;
    expect(leases.holdersOf('/proj').map((holder) => holder.runId)).toEqual(['run_c']);
  });

  it('mixed wave: a shared waiter batches with the promoted shared holder, not before a pending exclusive', async () => {
    const leases = new LeaseService();
    const idC: RunIdentity = { runId: 'run_c', botId: null, conversationId: null, loopType: 'turn' };
    const idD: RunIdentity = { runId: 'run_d', botId: null, conversationId: null, loopType: 'turn' };
    await leases.acquire(idA, '/proj'); // exclusive holder
    const s1 = leases.acquire(idB, '/proj', { shared: true }); // queued first
    const e = leases.acquire(idC, '/proj'); // queued second
    const s2 = leases.acquire(idD, '/proj', { shared: true }); // queued third
    await Promise.resolve();
    // Releasing the exclusive holder admits the first shared waiter only: the
    // second shared one is behind the exclusive waiter and must keep FIFO.
    leases.release(idA.runId);
    await Promise.resolve();
    expect(leases.holdersOf('/proj').map((holder) => holder.runId)).toEqual(['run_b']);
    // The shared holder releases: the exclusive waiter gets its turn, then the
    // last shared waiter.
    leases.release(idB.runId);
    await e;
    expect(leases.holdersOf('/proj').map((holder) => holder.runId)).toEqual(['run_c']);
    leases.release(idC.runId);
    await s2;
    expect(leases.holdersOf('/proj').map((holder) => holder.runId)).toEqual(['run_d']);
    await s1;
  });

  it('a waiter skipped when the run behind it is cancelled still gets its turn', async () => {
    const leases = new LeaseService();
    const idC: RunIdentity = { runId: 'run_c', botId: null, conversationId: null, loopType: 'turn' };
    await leases.acquire(idA, '/proj'); // exclusive holder
    const exclusive = leases.acquire(idB, '/proj'); // queued first
    await Promise.resolve();
    let sharedGranted = false;
    const shared = leases.acquire(idC, '/proj', { shared: true }).then(() => {
      sharedGranted = true;
    });
    await Promise.resolve();
    expect(sharedGranted).toBe(false);
    // The queued exclusive run dies while the holder still holds: the shared
    // waiter must not stay parked behind the vanished queue entry.
    leases.cancelWaitersOfRun(idB.runId);
    await exclusive;
    await Promise.resolve();
    expect(sharedGranted).toBe(false);
    leases.release(idA.runId);
    await shared;
    expect(sharedGranted).toBe(true);
    expect(leases.holdersOf('/proj').map((holder) => holder.runId)).toEqual(['run_c']);
  });

  it('forceRevoke removes every holder of the key (shared set included)', async () => {
    const leases = new LeaseService();
    await leases.acquire(idA, '/proj', { shared: true });
    await leases.acquire(idB, '/proj', { shared: true });
    expect(leases.forceRevoke('/proj')).toBe(true);
    expect(leases.holdersOf('/proj')).toEqual([]);
    expect(leases.keyOf(idA.runId)).toBeNull();
    expect(leases.keyOf(idB.runId)).toBeNull();
    // The revoked holders re-acquire through the queue as before.
    await leases.acquire(idA, '/proj', { shared: true });
    expect(leases.holdersOf('/proj').map((holder) => holder.runId)).toEqual(['run_a']);
  });
});

describe('domain-scoped holders (D123)', () => {
  it('finds a domain-keyed holder by the bare workdir path (force revoke / revert)', async () => {
    const leases = new LeaseService(writeDomainKeysConflict);
    const key = encodeWriteDomainKey('/proj', ['apps/**']);
    await leases.acquire(idA, key);
    // The raw key is not the plain path anymore …
    expect(leases.holderOf('/proj')).toBeNull();
    // … but the domain-aware lookup still finds the holder.
    expect(leases.conflictingHolder('/proj')?.runId).toBe('run_a');
    expect(leases.conflictingHolder('/other')).toBeNull();
  });

  it('treats the run’s domain lease as covering a plain request on the same root', async () => {
    const leases = new LeaseService(writeDomainKeysConflict);
    const key = encodeWriteDomainKey('/proj', ['apps/**']);
    await leases.acquire(idA, key);
    expect(leases.heldKey(idA.runId, ['/proj'])).toBe(key);
  });
});
