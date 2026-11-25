import { describe, expect, it } from 'vitest';
import { TASK_AUTO_CLAIM_MAX } from '@kepcup/shared';
import { TaskClaimRegistry } from '../../src/workdir/claims.js';

/** D140-1: auto-claims (first successful write claims the path) and the cap. */

const base = {
  botId: 'bot_1',
  conversationId: 'conv_1',
  title: '任务',
  root: '/repo/proj',
};

describe('TaskClaimRegistry.autoClaim (D140-1)', () => {
  it('registers the first path, merges later ones, and stays idempotent', () => {
    const claims = new TaskClaimRegistry();
    expect(
      claims.autoClaim({ ...base, taskId: 'run_a', path: 'src/a.ts' }),
    ).toBe('registered');
    expect(
      claims.autoClaim({ ...base, taskId: 'run_a', path: 'src/b.ts' }),
    ).toBe('registered');
    expect(claims.autoClaim({ ...base, taskId: 'run_a', path: 'src/a.ts' })).toBe('duplicate');
    expect(claims.entryOf('run_a')?.paths).toEqual(['src/a.ts', 'src/b.ts']);
    expect(claims.entryOf('run_a')?.reason).toContain('自动认领');
  });

  it('caps auto-claims at TASK_AUTO_CLAIM_MAX and reports the cap once', () => {
    const claims = new TaskClaimRegistry();
    for (let index = 0; index < TASK_AUTO_CLAIM_MAX; index += 1) {
      const outcome = claims.autoClaim({ ...base, taskId: 'run_cap', path: `f${index}.ts` });
      expect(outcome).toBe('registered');
    }
    expect(claims.entryOf('run_cap')?.paths).toHaveLength(TASK_AUTO_CLAIM_MAX);
    expect(claims.autoClaim({ ...base, taskId: 'run_cap', path: 'over.ts' })).toBe('capped');
    expect(claims.entryOf('run_cap')?.paths).toHaveLength(TASK_AUTO_CLAIM_MAX);
    // The caller logs the cap once per task.
    expect(claims.consumeCapNotice('run_cap')).toBe(true);
    expect(claims.consumeCapNotice('run_cap')).toBe(false);
    // The existing claim keeps blocking peers.
    expect(claims.denial('run_other', `${base.root}/f0.ts`, base.root)).toContain('run_cap');
    // clear() resets both the claim and the notice flag.
    claims.clear('run_cap');
    expect(claims.autoClaim({ ...base, taskId: 'run_cap', path: 'again.ts' })).toBe('registered');
    expect(claims.consumeCapNotice('run_cap')).toBe(true);
  });

  it('a manual claim and auto-claims share one entry (merged set)', () => {
    const claims = new TaskClaimRegistry();
    claims.set({ ...base, taskId: 'run_m', paths: ['docs/**'], reason: '要写文档', since: 1 });
    expect(claims.autoClaim({ ...base, taskId: 'run_m', path: 'src/x.ts' })).toBe('registered');
    const entry = claims.entryOf('run_m');
    expect(entry?.paths).toEqual(['docs/**', 'src/x.ts']);
    // The manual reason stays (the head the peer sees).
    expect(entry?.reason).toBe('要写文档');
  });
});
