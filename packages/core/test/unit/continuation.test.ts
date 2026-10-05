import { describe, expect, it } from 'vitest';
import type { Run, RunStep } from '@kepcup/shared';
import {
  buildArbiterUserMessage,
  buildRunDigest,
  resolveContinuation,
  type ContinuationCandidate,
} from '../../src/agent/context/continuation.js';

/**
 * Loop 续接单元测试（docs/design/02-execution.md "Loop 续接", D56）：
 * L1 确定性回放、cancelled 排除、L2 仲裁选择与非法 id 过滤、
 * 回放预算的尾部保留与截断标注。
 */

const TZ = 'Asia/Shanghai';
const NOW = Date.parse('2026-10-04T08:00:00.000Z'); // 本地 16:00

function makeRun(overrides: Partial<Run> & Pick<Run, 'id'>): Run {
  return {
    botId: 'bot_a',
    conversationId: 'conv_1',
    loopType: 'response',
    status: 'completed',
    triggerReason: 'direct',
    triggerMessageIds: [],
    provider: 'mock',
    model: 'mock-main',
    outputMessageIds: [],
    summary: null,
    continuedFromRunIds: [],
    error: null,
    chainId: null,
    chainDepth: null,
    createdAt: NOW - 10 * 60_000,
    startedAt: NOW - 10 * 60_000,
    endedAt: NOW - 5 * 60_000,
    ...overrides,
  };
}

function makeStep(
  seq: number,
  type: RunStep['type'],
  payload: unknown,
  createdAt = NOW - 4 * 60_000,
): RunStep {
  return { id: `stp_${seq}`, runId: 'run_a', seq, type, payload, createdAt };
}

function candidate(run: Run, summaryLine = '修复了超时'): ContinuationCandidate {
  return { run, summaryLine };
}

describe('resolveContinuation', () => {
  it('replays the newest run deterministically within the window and never calls the arbiter', async () => {
    const run = makeRun({ id: 'run_a' });
    const steps = [
      makeStep(
        0,
        'assistant',
        { text: '收到，我先看看日志', stopReason: 'toolUse' },
        NOW - 5 * 60_000,
      ),
      makeStep(1, 'tool_call', {
        toolCallId: 't1',
        toolName: 'read',
        args: { path: 'logs/error.log' },
      }),
      makeStep(2, 'tool_result', { toolCallId: 't1', ok: true, content: 'x'.repeat(4000) }),
      makeStep(3, 'assistant', { text: '已经定位到超时原因', stopReason: 'stop' }, NOW - 60_000),
    ];
    let arbiterCalls = 0;
    const plan = await resolveContinuation({
      candidates: [candidate(run)],
      now: NOW,
      timeZone: TZ,
      recentLines: ['[m1 | 2026-10-04 16:00 | 用户] 帮我看下报错'],
      stepsFor: () => steps,
      arbiter: async () => {
        arbiterCalls += 1;
        return null;
      },
    });
    expect(plan).not.toBeNull();
    expect(plan!.continuedFromRunIds).toEqual(['run_a']);
    expect(plan!.segment).toContain('<continuation>');
    expect(plan!.segment).toContain('<previous_run id="run_a" status="completed"');
    // 大段工具输出省略、参数内联、assistant 文本带标注。
    expect(plan!.segment).toContain(
      'read({"path":"logs/error.log"}) → ok：输出 4000 字符（已省略）',
    );
    expect(plan!.segment).toContain('（说明） 收到，我先看看日志');
    expect(plan!.segment).toContain('（最终回复） 已经定位到超时原因');
    expect(arbiterCalls).toBe(0);
  });

  it('never auto-replays a cancelled run but offers it to the arbiter', async () => {
    const run = makeRun({ id: 'run_a', status: 'cancelled' });
    const seen: ContinuationCandidate[][] = [];
    const plan = await resolveContinuation({
      candidates: [candidate(run, '用户取消')],
      now: NOW,
      timeZone: TZ,
      recentLines: [],
      stepsFor: () => [],
      arbiter: async (input) => {
        seen.push(input.candidates);
        return null;
      },
    });
    expect(plan).toBeNull();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.map((entry) => entry.run.id)).toEqual(['run_a']);
  });

  it('beyond the window the arbiter decides; invalid ids are dropped', async () => {
    const run = makeRun({ id: 'run_a', endedAt: NOW - 2 * 60 * 60_000 });
    const steps = [makeStep(0, 'progress', { text: '做过一步' })];
    const cases: Array<{ arbiterResult: string[] | null; expected: string[] | null }> = [
      { arbiterResult: ['run_a'], expected: ['run_a'] },
      { arbiterResult: ['run_x', 'run_a'], expected: ['run_a'] },
      { arbiterResult: ['run_x'], expected: null },
      { arbiterResult: [], expected: null },
      { arbiterResult: null, expected: null },
    ];
    for (const testCase of cases) {
      const plan = await resolveContinuation({
        candidates: [candidate(run)],
        now: NOW,
        timeZone: TZ,
        recentLines: [],
        stepsFor: () => steps,
        arbiter: async () => testCase.arbiterResult,
      });
      expect(plan?.continuedFromRunIds ?? null).toEqual(testCase.expected);
    }
  });

  it('runs with no steps are dropped from the plan', async () => {
    const old = makeRun({ id: 'run_old', endedAt: NOW - 2 * 60 * 60_000 });
    const plan = await resolveContinuation({
      candidates: [candidate(old)],
      now: NOW,
      timeZone: TZ,
      recentLines: [],
      stepsFor: () => [],
      arbiter: async () => ['run_old'],
    });
    expect(plan).toBeNull();
  });

  it('the newest run claims the budget first; starved older runs are dropped', async () => {
    const old = makeRun({ id: 'run_old', endedAt: NOW - 2 * 60 * 60_000 });
    const recent = makeRun({ id: 'run_new', endedAt: NOW - 60 * 60_000 });
    const manySteps = (runId: string): RunStep[] =>
      Array.from({ length: 120 }, (_, i) =>
        makeStep(i, 'progress', { text: `第 ${i} 步的执行进度记录，包含足够长度以消耗预算` }),
      ).map((step) => ({ ...step, runId }));
    const plan = await resolveContinuation({
      candidates: [candidate(old), candidate(recent)],
      now: NOW,
      timeZone: TZ,
      recentLines: [],
      stepsFor: (runId) => manySteps(runId),
      arbiter: async () => ['run_old', 'run_new'],
    });
    expect(plan).not.toBeNull();
    expect(plan!.continuedFromRunIds).toEqual(['run_new']);
    expect(plan!.segment).toContain('run_new');
    expect(plan!.segment).not.toContain('run_old');
  });
});

describe('buildRunDigest', () => {
  it('renders an empty digest for a run without steps', () => {
    const digest = buildRunDigest({
      run: makeRun({ id: 'run_a' }),
      steps: [],
      timeZone: TZ,
      budgetTokens: 1000,
    });
    expect(digest).toBe('');
  });

  it('keeps the tail under a tight budget and marks the dropped head', () => {
    const steps = Array.from({ length: 40 }, (_, i) =>
      makeStep(i, 'progress', { text: `步骤 ${i}` }),
    );
    const digest = buildRunDigest({
      run: makeRun({ id: 'run_a' }),
      steps,
      timeZone: TZ,
      budgetTokens: 200,
    });
    expect(digest).toContain('（更早的步骤已省略）');
    expect(digest).toContain('（进度） 步骤 39');
    expect(digest).not.toContain('步骤 0');
    expect(digest).toContain('</previous_run>');
  });

  it('keeps at least one line even when the header eats most of the budget', () => {
    const steps = [makeStep(0, 'progress', { text: '唯一的一步' })];
    const digest = buildRunDigest({
      run: makeRun({ id: 'run_a' }),
      steps,
      timeZone: TZ,
      budgetTokens: 1,
    });
    expect(digest).toContain('唯一的一步');
  });
});

describe('buildArbiterUserMessage', () => {
  it('lists candidates with summaries and appends the recent conversation', () => {
    const message = buildArbiterUserMessage({
      candidates: [candidate(makeRun({ id: 'run_a' }), '修复了超时')],
      recentLines: ['[m1 | 2026-10-04 16:00 | 用户] 帮我看下报错'],
      timeZone: TZ,
    });
    expect(message).toContain('<candidates>');
    expect(message).toContain(
      '- run_a | 2026-10-04 15:55 结束 | 触发 direct | 状态 completed | 摘要：修复了超时',
    );
    expect(message).toContain('<recent_conversation>');
    expect(message).toContain('帮我看下报错');
  });
});
