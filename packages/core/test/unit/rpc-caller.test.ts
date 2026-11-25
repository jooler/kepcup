import { describe, expect, it } from 'vitest';
import { currentCaller, withCaller, type RpcCaller } from '../../src/rpc/caller.js';

/**
 * 62.11 C1 caller context: AsyncLocalStorage propagation, nesting and
 * concurrency isolation (same seam as `remote/audit.ts` `withRemoteSource`).
 */

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('rpc caller context (62.11 C1)', () => {
  it('returns null outside any withCaller wrapper', () => {
    expect(currentCaller()).toBeNull();
  });

  it('exposes the caller inside the wrapper and clears it afterwards', async () => {
    const caller: RpcCaller = { principalId: 'mbr_alice' };
    const seen = await withCaller(caller, () => currentCaller());
    expect(seen).not.toBeNull();
    expect(seen?.principalId).toBe('mbr_alice');
    expect(seen?.deviceId).toBeUndefined();
    expect(currentCaller()).toBeNull();
  });

  it('passes deviceId through unchanged', () => {
    const caller: RpcCaller = { principalId: 'mbr_alice', deviceId: 'dev_01' };
    return withCaller(caller, async () => {
      await delay(1);
      expect(currentCaller()).toEqual({ principalId: 'mbr_alice', deviceId: 'dev_01' });
    });
  });

  it('lets sync tasks run and resolves their return value as a promise', async () => {
    const inside = await withCaller({ principalId: 'mbr_alice' }, () => 42);
    expect(inside).toBe(42);
    expect(currentCaller()).toBeNull();
  });

  it('inner withCaller overrides the outer one, restoring it when done', async () => {
    const outer: RpcCaller = { principalId: 'mbr_alice' };
    const inner: RpcCaller = { principalId: 'mbr_bob' };
    const outerSeesDuringInner: Array<RpcCaller | null> = [];
    await withCaller(outer, async () => {
      expect(currentCaller()?.principalId).toBe('mbr_alice');
      const innerResult = await withCaller(inner, async () => {
        await delay(1);
        expect(currentCaller()?.principalId).toBe('mbr_bob');
        return 'inner-done';
      });
      expect(innerResult).toBe('inner-done');
      outerSeesDuringInner.push(currentCaller());
    });
    expect(outerSeesDuringInner[0]?.principalId).toBe('mbr_alice');
    expect(currentCaller()).toBeNull();
  });

  it('keeps concurrent withCaller chains isolated across awaits', async () => {
    const seen: string[] = [];
    const chain = (principalId: string): Promise<void> =>
      withCaller({ principalId }, async () => {
        for (let i = 0; i < 5; i += 1) {
          await delay(1);
          const caller = currentCaller();
          if (caller?.principalId !== principalId) {
            throw new Error(
              `caller context leaked: expected ${principalId}, got ${caller?.principalId}`,
            );
          }
          seen.push(caller.principalId);
        }
      });
    await Promise.all([chain('mbr_alice'), chain('mbr_bob')]);
    expect(seen.filter((id) => id === 'mbr_alice')).toHaveLength(5);
    expect(seen.filter((id) => id === 'mbr_bob')).toHaveLength(5);
    expect(currentCaller()).toBeNull();
  });
});
