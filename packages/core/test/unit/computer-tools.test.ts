import { describe, expect, test } from 'vitest';
import type { RunIdentity, ToolContext } from '@kepcup/core';
import { buildComputerTools } from '../../src/tools/computer-tools.js';
import type { ToolDefinition, ToolResult } from '@kepcup/core';
import type { ComputerHostRpc } from '../../src/computer/facade.js';
import type { ApprovalOutcome, Approval, ApprovalsService } from '../../src/permissions/approvals.js';
import type { ComputerSnapshotResult, ComputerActionResult } from '@kepcup/shared';

/**
 * computer 工具层（D105）的安全语义回归锚（docs/design/52 §5，执行文档
 * 「风险与注意」3/4：防重放与脱敏不得简化）：
 * - `ComputerActionVerification` unverified → `outcome: 'uncertain'` + 先观察文案；
 * - type / paste / set_value 的 `sensitiveParams` 与结果脱敏；
 * - 审批拒绝发生在动作前 → not_started（不标 uncertain）；
 * - run 内首动作出卡一次；conversation / bot 档既有批准复用；
 * - maybe-sent 错误（window_not_focused 的 focusRecordFailed）→ uncertain；
 * - PERMISSION_DENIED 指设置页且不换技术。
 */

const identity: RunIdentity = {
  runId: 'run_01TEST',
  botId: 'bot_01TEST',
  conversationId: 'conv_01TEST',
  loopType: 'task',
};

function makeContext(): ToolContext & { progressTexts: string[] } {
  const progressTexts: string[] = [];
  return {
    identity,
    signal: new AbortController().signal,
    terminate: () => {},
    progress: (text) => progressTexts.push(text),
    progressTexts,
  };
}

const snapshot: ComputerSnapshotResult = {
  snapshot: {
    id: 'snap-1',
    app: { name: 'Notes', bundleId: 'com.apple.Notes', pid: 42 },
    window: { id: 7, title: 'Notes', width: 800, height: 600 },
    coordinateSpace: 'window',
    treeText: '0 window Notes\n\t1 button New',
    elementCount: 2,
    focusedElementId: null,
  },
  screenshot: null,
  screenshotStatus: { state: 'skipped', reason: 'no_screenshot_flag' },
};

function actionResult(verification?: ComputerActionResult['action']['verification']): ComputerActionResult {
  return {
    ...snapshot,
    action: { path: 'accessibility', actionName: 'AXPress', delivery: 'background', ...(verification !== undefined ? { verification } : {}) },
  };
}

type InvokeCall = { method: string; params: Record<string, unknown> };

function fakeHost(result: unknown = snapshot, error: unknown = null) {
  const calls: InvokeCall[] = [];
  const host: ComputerHostRpc & { calls: typeof calls } = {
    calls,
    invoke: async (method, params) => {
      calls.push({ method, params });
      if (error !== null) throw error;
      return result as never;
    },
    capabilities: async () => null,
    permissionsStatus: async () => ({ accessibility: 'unknown', screenRecording: 'unknown' }),
    permissionsOpen: async () => ({ ok: true }),
    stop: async () => ({ stopped: true }),
  };
  return host;
}

type ApprovalRecorder = {
  requested: number;
  outcome: ApprovalOutcome;
};

function approvalRecorder(outcome: ApprovalOutcome): ApprovalRecorder {
  return { requested: 0, outcome };
}

function approvedOutcome(duration: 'once' | 'conversation' | 'bot' = 'once'): ApprovalOutcome {
  return {
    approval: { id: 'appr_01', kind: 'computer_control', status: 'approved', decision: { duration } } as Approval,
    decision: 'approved',
  };
}

const deniedOutcome: ApprovalOutcome = {
  approval: { id: 'appr_02', kind: 'computer_control', status: 'denied' } as Approval,
  decision: 'denied',
};

function fakeApprovals(approved: Approval[] = []): Pick<ApprovalsService, 'list'> {
  return { list: () => approved };
}

function tools(
  host: ComputerHostRpc,
  recorder?: ApprovalRecorder,
  approvals?: Pick<ApprovalsService, 'list'>,
): ToolDefinition[] {
  return buildComputerTools({
    identity,
    computer: host,
    ...(recorder !== undefined
      ? {
          requestApproval: async () => {
            recorder.requested += 1;
            return recorder.outcome;
          },
        }
      : {}),
    ...(approvals !== undefined ? { approvals } : {}),
  });
}

async function execute(def: ToolDefinition, params: unknown): Promise<ToolResult> {
  return def.execute(params as never, makeContext());
}

function findTool(defs: ToolDefinition[], name: string): ToolDefinition {
  const found = defs.find((t) => t.name === name);
  if (found === undefined) throw new Error(`missing tool ${name}`);
  return found;
}

describe('computer tools (tool layer on a fake host)', () => {
  test('twelve tools are registered', () => {
    expect(tools(fakeHost()).map((t) => t.name)).toEqual([
      'computer_list_apps',
      'computer_list_windows',
      'computer_get_app_state',
      'computer_click',
      'computer_perform_action',
      'computer_scroll',
      'computer_drag',
      'computer_type',
      'computer_key',
      'computer_paste',
      'computer_set_value',
      'computer_stop',
    ]);
  });

  test('observation tools map sidecar params (snake_case → camelCase)', async () => {
    const host = fakeHost(snapshot);
    const result = await execute(findTool(tools(host), 'computer_get_app_state'), {
      app: 'Notes',
      window_id: 7,
      screenshot: true,
    });
    expect(result.ok).toBe(true);
    expect(host.calls[0]).toEqual({
      method: 'getAppState',
      params: { app: 'Notes', windowId: 7 },
    });
    // screenshot 默认 false → noScreenshot: true;显式 true 则不带。
    const noShot = await execute(findTool(tools(host), 'computer_get_app_state'), { app: 'Notes' });
    expect(noShot.ok).toBe(true);
    expect(host.calls[1]?.params).toMatchObject({ noScreenshot: true });
  });

  test('unverified action verification → outcome uncertain with observe-first guidance', async () => {
    const host = fakeHost(actionResult({ state: 'unverified', reason: 'suspected_noop' }));
    const recorder = approvalRecorder(approvedOutcome());
    const result = await execute(findTool(tools(host, recorder), 'computer_click'), {
      app: 'Notes',
      element_index: 1,
    });
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe('uncertain');
    expect(result.content).toContain('先观察');
    expect(result.content).toContain('不要盲目重放');
    expect(recorder.requested).toBe(1);
  });

  test('a scroll readback that saw the layout move is not reported as "maybe nothing happened"', async () => {
    const host = fakeHost({
      ...snapshot,
      action: {
        path: 'synthetic',
        delivery: 'background',
        verification: {
          state: 'unverified',
          reason: 'synthetic_input',
          actualPreview: '滚动后内容上移 312pt（41 个元素位置变化）',
        },
      },
    });
    const result = await execute(findTool(tools(host, approvalRecorder(approvedOutcome())), 'computer_scroll'), {
      app: 'Notes',
      direction: 'down',
      element_index: 2,
    });
    expect(result.outcome).toBe('uncertain');
    expect(result.content).toContain('读回：滚动后内容上移 312pt（41 个元素位置变化）');
    expect(result.content).not.toContain('可能未生效');
  });

  test('a suspected no-op scroll says the readback saw no movement', async () => {
    const host = fakeHost({
      ...snapshot,
      action: {
        path: 'synthetic',
        delivery: 'background',
        verification: {
          state: 'unverified',
          reason: 'suspected_noop',
          actualPreview: '滚动前后 AX 布局指纹完全一致，内容没有移动',
        },
      },
    });
    const result = await execute(findTool(tools(host, approvalRecorder(approvedOutcome())), 'computer_scroll'), {
      app: 'Notes',
      direction: 'down',
    });
    expect(result.ok).toBe(true);
    expect(result.content).toContain('读回没有可观测变化');
    expect(result.content).toContain('滚动前后 AX 布局指纹完全一致');
    expect(result.content).toContain('不要盲目重放');
  });

  test('verified action verification → completed', async () => {
    const host = fakeHost(actionResult({ state: 'verified', property: 'value' }));
    const result = await execute(findTool(tools(host, approvalRecorder(approvedOutcome())), 'computer_set_value'), {
      app: 'Notes',
      element_index: 3,
      value: 'X',
    });
    expect(result.outcome).toBe('completed');
  });

  test('approval is requested once per run before the first action', async () => {
    const host = fakeHost(actionResult());
    const recorder = approvalRecorder(approvedOutcome());
    const defs = tools(host, recorder);
    await execute(findTool(defs, 'computer_click'), { app: 'Notes', element_index: 1 });
    await execute(findTool(defs, 'computer_type'), { app: 'Notes', text: 'hello' });
    await execute(findTool(defs, 'computer_scroll'), { app: 'Notes', direction: 'down' });
    expect(recorder.requested).toBe(1);
  });

  test('denied approval → not_started failure (never uncertain), no sidecar call', async () => {
    const host = fakeHost(actionResult());
    const recorder = approvalRecorder(deniedOutcome);
    const result = await execute(findTool(tools(host, recorder), 'computer_click'), {
      app: 'Notes',
      element_index: 1,
    });
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe('not_started');
    expect(result.errorCode).toBe('COMPUTER_DENIED');
    expect(host.calls).toHaveLength(0);
  });

  test('a standing conversation approval skips the card entirely', async () => {
    const host = fakeHost(actionResult());
    const recorder = approvalRecorder(deniedOutcome);
    const standing: Approval[] = [
      {
        id: 'appr_03',
        kind: 'computer_control',
        status: 'approved',
        autoApproved: false,
        botId: identity.botId,
        conversationId: identity.conversationId,
        decision: { duration: 'conversation' },
      } as Approval,
    ];
    const result = await execute(
      findTool(tools(host, recorder, fakeApprovals(standing)), 'computer_click'),
      { app: 'Notes', element_index: 1 },
    );
    expect(result.ok).toBe(true);
    expect(recorder.requested).toBe(0);
  });

  test('auto-approved rows never count as standing approvals', async () => {
    const host = fakeHost(actionResult());
    const recorder = approvalRecorder(approvedOutcome());
    const autoRow: Approval[] = [
      {
        id: 'appr_04',
        kind: 'computer_control',
        status: 'approved',
        autoApproved: true,
        botId: identity.botId,
        decision: { duration: 'conversation' },
      } as Approval,
    ];
    await execute(findTool(tools(host, recorder, fakeApprovals(autoRow)), 'computer_click'), {
      app: 'Notes',
      element_index: 1,
    });
    expect(recorder.requested).toBe(1);
  });

  test('type / paste / set_value mark sensitiveParams and mask the result text', async () => {
    const host = fakeHost({
      ...actionResult(),
      snapshot: {
        ...snapshot.snapshot,
        treeText: '0 window Notes\n\t1 text field (settable) secret-token-value',
      },
    });
    const recorder = approvalRecorder(approvedOutcome());
    const defs = tools(host, recorder);

    const typed = await execute(findTool(defs, 'computer_type'), { app: 'Notes', text: 'secret-token-value' });
    expect(typed.sensitiveParams).toEqual(['text']);
    expect(typed.content).not.toContain('secret-token-value');
    expect(host.calls[0]?.params).toMatchObject({ text: 'secret-token-value' });

    const pasted = await execute(findTool(defs, 'computer_paste'), { app: 'Notes', text: 'secret-token-value' });
    expect(pasted.sensitiveParams).toEqual(['text']);
    expect(pasted.content).not.toContain('secret-token-value');

    const set = await execute(findTool(defs, 'computer_set_value'), {
      app: 'Notes',
      element_index: 1,
      value: 'secret-token-value',
    });
    expect(set.sensitiveParams).toEqual(['value']);
    expect(set.content).not.toContain('secret-token-value');
  });

  test('approval summaries never carry the sensitive text', async () => {
    const host = fakeHost(actionResult());
    const seen: Record<string, unknown>[] = [];
    const defs = buildComputerTools({
      identity,
      computer: host,
      requestApproval: async (_id, _kind, payload) => {
        seen.push(payload);
        return approvedOutcome();
      },
    });
    await execute(findTool(defs, 'computer_type'), { app: 'Notes', text: 'hunter2-password' });
    expect(JSON.stringify(seen[0])).not.toContain('hunter2-password');
    expect(seen[0]?.['summary']).toContain('不回显');
  });

  test('maybe-sent errors (window_not_focused) map to uncertain with observe guidance', async () => {
    const { AppError } = await import('@kepcup/shared');
    const host = fakeHost(
      null,
      new AppError('WINDOW_NOT_FOCUSED', 'focus record failed — input may already have been delivered'),
    );
    const result = await execute(findTool(tools(host, approvalRecorder(approvedOutcome())), 'computer_click'), {
      app: 'Notes',
      element_index: 1,
    });
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe('uncertain');
    expect(result.content).toContain('先 computer_get_app_state 观察');
  });

  test('PERMISSION_DENIED guidance points at settings and forbids other automation', async () => {
    const { AppError } = await import('@kepcup/shared');
    const host = fakeHost(null, new AppError('PERMISSION_DENIED', 'Accessibility permission is required'));
    const result = await execute(findTool(tools(host, approvalRecorder(approvedOutcome())), 'computer_get_app_state'), {
      app: 'Notes',
    });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('PERMISSION_DENIED');
    expect(result.content).toContain('计算机操控');
    expect(result.content).toContain('不');
  });

  test('computer_key routes chords to hotkey and plain keys to pressKey', async () => {
    const host = fakeHost(actionResult());
    const defs = tools(host, approvalRecorder(approvedOutcome()));
    await execute(findTool(defs, 'computer_key'), { app: 'Notes', key: 'cmd+a' });
    await execute(findTool(defs, 'computer_key'), { app: 'Notes', key: 'return' });
    expect(host.calls.map((call) => call.method)).toEqual(['hotkey', 'pressKey']);
  });

  test('computer_stop reports session termination', async () => {
    const host = fakeHost();
    const result = await execute(findTool(tools(host), 'computer_stop'), { reason: 'done' });
    expect(result.ok).toBe(true);
    expect(result.content).toContain('已停止');
    expect(host.calls).toHaveLength(0); // stop goes through host.stop, not invoke
  });
});
