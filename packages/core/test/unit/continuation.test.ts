import { describe, expect, it } from 'vitest';
import type { Run, RunStep } from '@kepcup/shared';
import {
  buildRunDigest,
  NOT_RUN_CALL_NOTE,
  UNCERTAIN_RESULT_NOTE,
  UNRETURNED_CALL_NOTE,
} from '../../src/agent/context/continuation.js';

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

describe('buildRunDigest「结果未知」标注（W3-P0 / W1）', () => {
  const run = makeRun({ id: 'run_a', loopType: 'task', status: 'interrupted' });
  const digestOf = (
    steps: RunStep[],
    effects?: Array<{ toolCallId: string; status: 'uncertain' | 'completed' }>,
  ) =>
    buildRunDigest({
      run,
      steps,
      timeZone: TZ,
      budgetTokens: 4000,
      ...(effects !== undefined ? { effects } : {}),
    });

  it('flags a side-effecting call that never returned; a read-only one only says so', () => {
    const digest = digestOf([
      makeStep(0, 'tool_call', { toolCallId: 't1', toolName: 'read', args: { path: 'a.txt' } }),
      makeStep(1, 'tool_call', {
        toolCallId: 't2',
        toolName: 'browser_click',
        args: { ref: 'e12' },
      }),
    ]);
    expect(digest).toContain(
      `[15:56] [结果未知] browser_click({"ref":"e12"}) ${UNRETURNED_CALL_NOTE}`,
    );
    expect(digest).toContain('read({"path":"a.txt"}) →（未返回结果）');
    expect(digest).not.toContain('[结果未知] read');
  });

  it('flags an uncertain browser result (W1 outcome, or only the error code on old rows) and keeps it untrusted', () => {
    const digest = digestOf([
      makeStep(0, 'tool_call', {
        toolCallId: 't1',
        toolName: 'browser_click',
        args: { ref: 'e1' },
      }),
      makeStep(1, 'tool_result', {
        toolCallId: 't1',
        toolName: 'browser_click',
        ok: false,
        content: '动作可能已生效：先 browser_snapshot 核实',
        errorCode: 'BROWSER_OUTCOME_UNKNOWN',
        outcome: 'uncertain',
      }),
      makeStep(2, 'tool_call', {
        toolCallId: 't2',
        toolName: 'browser_press',
        args: { key: 'Enter' },
      }),
      makeStep(3, 'tool_result', {
        toolCallId: 't2',
        ok: false,
        content: '旧格式',
        errorCode: 'BROWSER_OUTCOME_UNKNOWN',
      }),
      makeStep(4, 'tool_call', {
        toolCallId: 't3',
        toolName: 'browser_click',
        args: { ref: 'e2' },
      }),
      makeStep(5, 'tool_result', {
        toolCallId: 't3',
        ok: false,
        content: '页面已变化',
        errorCode: 'BROWSER_REF_STALE',
        outcome: 'not_started',
      }),
    ]);
    expect(digest).toContain(
      `[结果未知] browser_click({"ref":"e1"}) ${UNCERTAIN_RESULT_NOTE} → 失败：<untrusted>动作可能已生效：先 browser_snapshot 核实</untrusted>`,
    );
    expect(digest).toContain('[结果未知] browser_press({"key":"Enter"})');
    // not_started is a plain failure (safe to retry).
    expect(digest).toContain(
      'browser_click({"ref":"e2"}) → 失败：<untrusted>页面已变化</untrusted>',
    );
    expect(digest).not.toContain('[结果未知] browser_click({"ref":"e2"})');
  });

  it('W4: an unreturned call whose ledger row is denied (stopped at its approval) is not 结果未知', () => {
    const steps = [
      makeStep(0, 'tool_call', {
        toolCallId: 't1',
        toolName: 'mcp_srv_send',
        args: { to: 'ann' },
      }),
    ];
    // Without the ledger: an external call that never returned — flagged.
    expect(digestOf(steps)).toContain('[结果未知] mcp_srv_send');
    // Interrupted / recovered while waiting on its approval (intended → denied).
    const digest = digestOf(steps, [{ toolCallId: 't1', status: 'denied' }]);
    expect(digest).not.toContain('[结果未知]');
    expect(digest).toContain(`mcp_srv_send({"to":"ann"}) ${NOT_RUN_CALL_NOTE}`);
  });

  it('uses the W2 ledger when given: a thrown call recorded uncertain is flagged', () => {
    const steps = [
      makeStep(0, 'tool_call', {
        toolCallId: 't1',
        toolName: 'git_remote',
        args: { operation: 'push' },
      }),
      makeStep(1, 'tool_result', {
        toolCallId: 't1',
        ok: false,
        content: '工具执行失败：boom',
        errorCode: 'INTERNAL',
      }),
    ];
    expect(digestOf(steps)).not.toContain('[结果未知]');
    expect(digestOf(steps, [{ toolCallId: 't1', status: 'uncertain' }])).toContain(
      `[结果未知] git_remote({"operation":"push"}) ${UNCERTAIN_RESULT_NOTE}`,
    );
    expect(digestOf(steps, [{ toolCallId: 't1', status: 'completed' }])).not.toContain(
      '[结果未知]',
    );
  });

  it('matches ledger rows by base id when the run reused a tool-call id (`id#2`)', () => {
    const steps = [
      makeStep(0, 'tool_call', {
        toolCallId: 'call_x',
        toolName: 'browser_click',
        args: { ref: 'e1' },
      }),
      makeStep(1, 'tool_result', { toolCallId: 'call_x', ok: true, content: '已点击' }),
      makeStep(2, 'tool_call', {
        toolCallId: 'call_x',
        toolName: 'git_remote',
        args: { operation: 'push' },
      }),
      makeStep(3, 'tool_result', {
        toolCallId: 'call_x',
        ok: false,
        content: '工具执行失败：boom',
        errorCode: 'INTERNAL',
      }),
    ];
    const digest = digestOf(steps, [
      { toolCallId: 'call_x', status: 'completed' },
      { toolCallId: 'call_x#2', status: 'uncertain' },
    ]);
    expect(digest).toContain(
      `[结果未知] git_remote({"operation":"push"}) ${UNCERTAIN_RESULT_NOTE}`,
    );
    // The successful sibling with the same id is not dragged along.
    expect(digest).toContain('browser_click({"ref":"e1"}) → ok：<untrusted>已点击</untrusted>');
    expect(digest).not.toContain('[结果未知] browser_click');
  });

  it('a step stamped outcome:uncertain (thrown / MCP transport failure) is flagged without the ledger', () => {
    const digest = digestOf([
      makeStep(0, 'tool_call', { toolCallId: 't1', toolName: 'mcp_srv_post', args: { text: 'x' } }),
      makeStep(1, 'tool_result', {
        toolCallId: 't1',
        ok: false,
        content: 'MCP 调用失败：socket hang up',
        errorCode: 'MCP_CALL_FAILED',
        outcome: 'uncertain',
      }),
    ]);
    expect(digest).toContain(`[结果未知] mcp_srv_post({"text":"x"}) ${UNCERTAIN_RESULT_NOTE}`);
  });
});
