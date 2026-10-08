import { describe, expect, it } from 'vitest';
import type { Run } from '@kepcup/shared';
import { restoredFailedRun, showsFailure, stepAutoContinue } from './setup-continue';

/** 对话内 Agent 设置卡的自动续跑与失败 run 恢复（P4-B 审查 HIGH #1）。 */

function run(id: string, overrides: Partial<Run> = {}): Run {
  return {
    id,
    botId: 'bot_a',
    conversationId: 'conv',
    loopType: 'turn',
    status: 'completed',
    setup: null,
    continuedFromRunIds: [],
    ...overrides,
  } as Run;
}

describe('stepAutoContinue', () => {
  it('no baseline before the agent state is loaded; the first known snapshot is the baseline', () => {
    let state = stepAutoContinue(null, { known: false, usable: false });
    expect(state).toEqual({ baseline: null, proceed: false });
    // Relaunch: the store loads with the agent already "ready" → never auto-retries.
    state = stepAutoContinue(state.baseline, { known: true, usable: true });
    expect(state).toEqual({ baseline: true, proceed: false });
    state = stepAutoContinue(state.baseline, { known: true, usable: true });
    expect(state.proceed).toBe(false);
  });

  it('continues only on a not-usable → usable transition observed afterwards', () => {
    let state = stepAutoContinue(null, { known: true, usable: false });
    expect(state.proceed).toBe(false);
    state = stepAutoContinue(state.baseline, { known: true, usable: false });
    expect(state.proceed).toBe(false);
    state = stepAutoContinue(state.baseline, { known: true, usable: true });
    expect(state.proceed).toBe(true);
    // usable → unusable → usable again is a new transition.
    state = stepAutoContinue(state.baseline, { known: true, usable: false });
    state = stepAutoContinue(state.baseline, { known: true, usable: true });
    expect(state.proceed).toBe(true);
  });
});

describe('restoredFailedRun', () => {
  const setup = { kind: 'agent' as const, agentId: 'codex-acp', reason: 'auth_required' as const };

  it('restores the latest setup failure only when no newer response run of that bot exists', () => {
    const failed = run('r1', { status: 'failed', setup });
    expect(restoredFailedRun([failed], new Set())).toBe(failed);
    expect(restoredFailedRun([run('r2'), failed], new Set())).toBeNull();
    // Background runs or other bots do not supersede it.
    expect(
      restoredFailedRun(
        [run('r3', { loopType: 'reflection' }), run('r4', { botId: 'bot_b' }), failed],
        new Set(),
      ),
    ).toBe(failed);
  });

  it('plain failures keep the previous behaviour; dismissed runs are skipped', () => {
    const plain = run('p1', { status: 'failed' });
    expect(restoredFailedRun([run('r2'), plain], new Set())).toBe(plain);
    expect(restoredFailedRun([plain], new Set(['p1']))).toBeNull();
  });

  it('D75: failed tasks surface only with a setup, and only until a task retries them', () => {
    const setupTask = run('t1', { loopType: 'task', status: 'failed', setup });
    const plainTask = run('t0', { loopType: 'task', status: 'failed' });
    expect(showsFailure(plainTask)).toBe(false);
    expect(showsFailure(setupTask)).toBe(true);
    expect(showsFailure(run('r1', { status: 'failed' }))).toBe(true);
    // A plain task failure is the task card's business (no banner).
    expect(restoredFailedRun([plainTask], new Set())).toBeNull();
    // The turn its failure woke does not supersede the setup card …
    expect(restoredFailedRun([run('turn'), setupTask], new Set())).toBe(setupTask);
    // … the task retrying it does.
    expect(
      restoredFailedRun(
        [run('t2', { loopType: 'task', continuedFromRunIds: ['t1'] }), setupTask],
        new Set(),
      ),
    ).toBeNull();
  });
});
