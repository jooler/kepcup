import { describe, expect, it } from 'vitest';
import type { Run, RunStep } from '@kepcup/shared';
import { buildRunDigest } from '../../src/agent/context/continuation.js';

/**
 * Loop 续接单元测试（D56，按 D75 design 30 §7.1 修订）：自动续接（L1 窗口 +
 * L2 仲裁）对对话轮关闭、相关实现已删除（原 resolveContinuation /
 * buildArbiterUserMessage 用例随之移除）；保留任务 continues_task_id 回放所用的
 * buildRunDigest：过程行渲染、回放预算的尾部保留与截断标注。
 */

const TZ = 'Asia/Shanghai';
const NOW = Date.parse('2026-10-04T08:00:00.000Z'); // 本地 16:00

function makeRun(overrides: Partial<Run> & Pick<Run, 'id'>): Run {
  return {
    botId: 'bot_a',
    conversationId: 'conv_1',
    loopType: 'turn',
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

describe('buildRunDigest rendering', () => {
  it('renders tool calls with inlined args, omits large outputs and labels assistant texts', () => {
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
    const digest = buildRunDigest({ run, steps, timeZone: TZ, budgetTokens: 2000 });
    expect(digest).toContain('<previous_run id="run_a" status="completed"');
    expect(digest).toContain('read({"path":"logs/error.log"}) → ok：输出 4000 字符（已省略）');
    expect(digest).toContain('（说明） 收到，我先看看日志');
    expect(digest).toContain('（最终回复） 已经定位到超时原因');
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
