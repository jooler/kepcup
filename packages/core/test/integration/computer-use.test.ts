import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { step, viaTask, type TestStack } from '@kepcup/testkit';
import {
  createTestStack,
  listMessages,
  makeBot,
  openDirect,
  sendBatch,
  waitFor,
  waitForMessage,
} from '@kepcup/testkit';
import type { Approval, ComputerInvokeMethod } from '@kepcup/shared';
import type { ComputerHostRpc } from '../../src/computer/facade.js';

const stacks: TestStack[] = [];

afterEach(async () => {
  for (const stack of stacks.splice(0)) await stack.cleanup();
});

async function start(options: { computerRpc: unknown }): Promise<TestStack> {
  const stack = await createTestStack(options);
  stacks.push(stack);
  return stack;
}

/**
 * D105 端到端（M2/M3 的自动化部分）：任务 loop 里 computer_* 工具的注册门控、
 * computer_control 审批卡（首动作出卡 / conversation 档复用 / 敏感文本不进卡）、
 * sensitiveParams 脱敏与 uncertain 语义在真实 run 管线里的表现。宿主经
 * `computerRpc` 注入 fake（真 helper 的通路由 WP1/WP2 冒烟与编排层单测覆盖）。
 */

const notesSnapshot = {
  snapshot: {
    id: 'snap-1',
    app: { name: 'Notes', bundleId: 'com.apple.Notes', pid: 42 },
    window: { id: 7, title: 'Notes', width: 800, height: 600 },
    coordinateSpace: 'window',
    treeText: '0 window Notes\n\t1 text field (settable)',
    elementCount: 2,
    focusedElementId: 1,
  },
  screenshot: null,
  screenshotStatus: { state: 'skipped', reason: 'no_screenshot_flag' },
} as const;

function fakeComputerHost(
  invoke: (method: ComputerInvokeMethod, params: Record<string, unknown>) => unknown,
): ComputerHostRpc {
  return {
    invoke: (async (method: ComputerInvokeMethod, params: Record<string, unknown>) =>
      invoke(method, params)) as never,
    capabilities: async () =>
      ({
        platform: 'darwin',
        provider: 'orca-computer-use-macos',
        providerVersion: '1.0.0',
        protocolVersion: 1,
        supports: {
          apps: { list: true, bundleIds: true, pids: true },
          windows: { list: true, targetById: true, targetByIndex: true, focus: false, moveResize: false },
          observation: { screenshot: true, annotatedScreenshot: false, elementFrames: true, ocr: false },
          actions: {
            click: true,
            typeText: true,
            pressKey: true,
            hotkey: true,
            pasteText: true,
            scroll: true,
            drag: true,
            setValue: true,
            performAction: true,
          },
          surfaces: { menus: false, dialogs: false, dock: false, menubar: false },
        input: { background: true },
      },
    } as never),
    permissionsStatus: async () => ({ accessibility: 'granted', screenRecording: 'granted' }),
    permissionsOpen: async () => ({ ok: true }),
    stop: async () => ({ stopped: true }),
  };
}

async function pendingComputerApproval(
  core: TestStack,
  conversationId: string,
): Promise<Approval | null> {
  const result = (await core.rpc.call('approvals.list', { conversationId })) as {
    approvals: Approval[];
  };
  return (
    result.approvals.find((a) => a.kind === 'computer_control' && a.status === 'pending') ?? null
  );
}

/** 该对话最新的任务 run（waitForRun 会命中同对话里更早的 completed 任务）。 */
async function latestTask(core: TestStack['core'], conversationId: string) {
  const result = (await core.rpc.call('runs.list', { conversationId, limit: 20 })) as {
    runs: Array<{ id: string; status: string; loopType: string; createdAt: number }>;
  };
  return result.runs
    .filter((r) => r.loopType === 'task')
    .sort((a, b) => b.createdAt - a.createdAt)[0];
}

async function waitLatestTask(
  core: TestStack['core'],
  conversationId: string,
  beforeCreatedAt: number,
) {
  return waitFor(
    async () => {
      const task = await latestTask(core, conversationId);
      return task !== undefined && task.createdAt > beforeCreatedAt && task.status === 'completed'
        ? task
        : null;
    },
    { label: 'latest task completed', timeoutMs: 90_000 },
  );
}

/** pino-roll 按日切分，日志文件名不定；读整个目录拼接。 */
async function readLogs(dir: string): Promise<string> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const parts: string[] = [];
  for (const name of names) {
    if (!name.endsWith('.log')) continue;
    parts.push(await readFile(path.join(dir, name), 'utf8').catch(() => ''));
  }
  return parts.join('\n');
}

async function runSteps(core: TestStack, runId: string) {
  const result = (await core.rpc.call('runs.steps', { runId })) as {
    steps: Array<{ type: string; payload: Record<string, unknown> }>;
  };
  return result.steps;
}

describe('computer-use tools in a task run (D105)', () => {
  it('registers only for tasks with the setting on; first action raises a computer_control card, sensitive text stays off it', async () => {
    const invokeCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const host = fakeComputerHost((method, params) => {
      invokeCalls.push({ method, params });
      if (method === 'typeText') {
        return {
          ...notesSnapshot,
          action: {
            path: 'accessibility',
            actionName: 'AXReplaceSelection',
            delivery: 'background',
            verification: { state: 'verified', property: 'focusedText' },
          },
        };
      }
      return notesSnapshot;
    });
    const { core, llm } = await start({ computerRpc: host });
    const bot = await makeBot(core, '小操');
    const conv = await openDirect(core, bot.id);

    // 设置关闭时任务不注册 computer_*：模型试图调用，引擎按未知工具失败（步骤里
    // 不会有成功的 computer_get_app_state，宿主 invoke 也不会被调）。
    llm.script(
      'mock-main',
      viaTask(
        {
          taskSteps: [
            step().replyToolCall('computer_get_app_state', { app: 'Notes' }),
            step().replyText('没工具'),
          ],
          relay: 'RELAY-OFF',
        },
      ),
    );
    await sendBatch(core, conv.id, ['看看备忘录']);
    const beforeFirst = (await latestTask(core, conv.id))?.createdAt ?? 0;
    const task1 = await waitLatestTask(core, conv.id, beforeFirst - 1);
    const steps1 = await runSteps(core, task1.id);
    // 设置关：工具未注册——调用以 unknown-tool 失败收场，宿主从未被调。
    const offResult = steps1.find(
      (s) => s.type === 'tool_result' && s.payload['toolName'] === 'computer_get_app_state',
    );
    expect(offResult?.payload['ok'], '设置关闭时调用失败').not.toBe(true);
    expect(invokeCalls).toHaveLength(0);
    // relay turn 收尾后再进入下一轮脚本（openDirect 幂等：conv2 与 conv1 是同一对话）。
    await waitForMessage(core, conv.id, (m) => 'text' in m.content && m.content.text === 'RELAY-OFF', {
      timeoutMs: 30_000,
    });

    // 打开开关：任务里首个动作出 computer_control 卡；批准 conversation 档后，
    // 后续动作（含敏感输入）不再出卡，敏感文本也不出现在任何卡 payload 里。
    await core.rpc.call('settings.update', { computerUseEnabled: true });
    const conv2 = await openDirect(core, bot.id);
    llm.script(
      'mock-main',
      viaTask({
        taskSteps: [
          step().replyToolCall('computer_get_app_state', { app: 'Notes' }),
          step().replyToolCall('computer_type', { app: 'Notes', text: 'hunter2-secret-token' }),
          step().replyText('操控完成'),
        ],
        relay: 'RELAY-ON',
      }),
    );
    const beforeSecond = (await latestTask(core, conv2.id))?.createdAt ?? 0;
    await sendBatch(core, conv2.id, ['在备忘录里输入暗号']);

    const approval = await waitFor(async () => pendingComputerApproval(core, conv2.id), {
      label: 'computer_control card',
      timeoutMs: 60_000,
    });
    expect(approval.payload['app']).toBe('Notes');
    expect(JSON.stringify(approval.payload)).not.toContain('hunter2-secret-token');

    await core.rpc.call('approvals.decide', {
      id: approval.id,
      approve: true,
      duration: 'conversation',
    });

    const task2 = await waitLatestTask(core, conv2.id, beforeSecond);
    const steps2 = await runSteps(core, task2.id);
    expect(
      steps2.some((s) => s.type === 'tool_call' && s.payload['toolName'] === 'computer_type'),
      'computer_type ran',
    ).toBe(true);
    const typedResult = steps2.find(
      (s) => s.type === 'tool_result' && s.payload['toolName'] === 'computer_type',
    );
    // sensitiveParams 脱敏进步骤记录（持久层不落明文）。
    expect(typedResult?.payload['sensitiveParams']).toEqual(['text']);
    expect(JSON.stringify(typedResult?.payload)).not.toContain('hunter2-secret-token');
    // conversation 档：第二个动作没有再出卡。
    const cards = (await core.rpc.call('approvals.list', { conversationId: conv2.id })) as {
      approvals: Approval[];
    };
    expect(cards.approvals.filter((a) => a.kind === 'computer_control')).toHaveLength(1);
    // 两次 invoke 都到达宿主（getAppState + typeText）。
    expect(invokeCalls.map((c) => c.method)).toEqual(['getAppState', 'typeText']);
  }, 120_000);

  it('an unverified action reports uncertain and the tool text says observe first', async () => {
    const host = fakeComputerHost(() => ({
      ...notesSnapshot,
      action: {
        path: 'accessibility',
        actionName: 'AXPress',
        delivery: 'background',
        verification: { state: 'unverified', reason: 'suspected_noop' },
      },
    }));
    const { core, llm } = await start({ computerRpc: host });
    await core.rpc.call('settings.update', { computerUseEnabled: true });
    const bot = await makeBot(core, '小试');
    const conv = await openDirect(core, bot.id);
    llm.script(
      'mock-main',
      viaTask({
        taskSteps: [step().replyToolCall('computer_click', { app: 'Notes', element_index: 1 }), step().replyText('点了')],
        relay: 'RELAY-CLICK',
      }),
    );
    const beforeClick = (await latestTask(core, conv.id))?.createdAt ?? 0;
    await sendBatch(core, conv.id, ['点一下']);
    let approval: Approval;
    try {
      approval = await waitFor(async () => pendingComputerApproval(core, conv.id), {
        label: 'computer_control card',
        timeoutMs: 60_000,
      });
    } catch {
      const runsA = (await core.rpc.call('runs.list', { conversationId: conv.id, limit: 10 })) as {
        runs: Array<{ id: string; status: string; loopType: string }>;
      };
      for (const r of runsA.runs) {
        const steps = (await core.rpc.call('runs.steps', { runId: r.id })) as {
          steps: Array<{ type: string; payload: Record<string, unknown> }>;
        };
        const tail = steps.steps.filter((st) => st.type !== 'request' && st.type !== 'assistant');
        console.log('[diag3]', r.loopType, r.status, JSON.stringify(tail).slice(0, 1000));
      }
      throw new Error('card never appeared (diag3 above)');
    }
    await core.rpc.call('approvals.decide', { id: approval.id, approve: true, duration: 'once' });
    const task = await waitLatestTask(core, conv.id, beforeClick);
    const steps = await runSteps(core, task.id);
    const click = steps.find(
      (s) => s.type === 'tool_result' && s.payload['toolName'] === 'computer_click',
    );
    expect(click?.payload['outcome']).toBe('uncertain');
    expect(JSON.stringify(click?.payload)).toContain('先观察');
    // 无人值守也不会自动批准的底座在单测（NEVER_AUTO_DECIDED）；这里补一条
    // deny 路径：拒绝后动作未到达宿主。
    await waitForMessage(core, conv.id, (m) => 'text' in m.content && m.content.text === 'RELAY-CLICK', {
      timeoutMs: 30_000,
    });
    const conv2 = await openDirect(core, bot.id);
    llm.script(
      'mock-main',
      viaTask({
        taskSteps: [step().replyToolCall('computer_scroll', { app: 'Notes', direction: 'down' }), step().replyText('被拒')],
        relay: 'RELAY-DENY',
      }),
    );
    const beforeDeny = (await latestTask(core, conv2.id))?.createdAt ?? 0;
    await sendBatch(core, conv2.id, ['再滚一下']);
    const denial = await waitFor(async () => pendingComputerApproval(core, conv2.id), {
      label: 'second card',
      timeoutMs: 60_000,
    });
    await core.rpc.call('approvals.decide', { id: denial.id, approve: false });
    const task2 = await waitLatestTask(core, conv2.id, beforeDeny);
    const steps2 = await runSteps(core, task2.id);
    const scroll = steps2.find(
      (s) => s.type === 'tool_result' && s.payload['toolName'] === 'computer_scroll',
    );
    expect(scroll?.payload['outcome']).toBe('not_started');
    const messages = await listMessages(core, conv2.id);
    expect(JSON.stringify(messages)).not.toContain('先观察');
  }, 120_000);

  it('a failed capabilities handshake logs a warn and leaves computer_* unregistered', async () => {
    let capabilitiesCalls = 0;
    const host: ComputerHostRpc = {
      ...fakeComputerHost(() => notesSnapshot),
      capabilities: (async () => {
        capabilitiesCalls += 1;
        throw new Error('sidecar exited before handshake');
      }) as never,
    };
    const { core, llm } = await start({ computerRpc: host });
    await core.rpc.call('settings.update', { computerUseEnabled: true });
    const bot = await makeBot(core, '小门');
    const conv = await openDirect(core, bot.id);
    llm.script(
      'mock-main',
      viaTask({
        taskSteps: [
          step().replyToolCall('computer_list_apps', {}),
          step().replyText('RELAY-GATE'),
        ],
        relay: 'RELAY-GATE',
      }),
    );
    const beforeGate = (await latestTask(core, conv.id))?.createdAt ?? 0;
    await sendBatch(core, conv.id, ['列一下应用']);

    // 握手抛错：门控照旧不注册 computer_*，模型调用以 unknown-tool 失败收场。
    const task = await waitLatestTask(core, conv.id, beforeGate - 1);
    const steps = await runSteps(core, task.id);
    const call = steps.find(
      (s) => s.type === 'tool_result' && s.payload['toolName'] === 'computer_list_apps',
    );
    expect(call?.payload['ok'], '握手失败时 computer_* 不注册').not.toBe(true);
    expect(capabilitiesCalls).toBeGreaterThan(0);

    // 但失败不再静默：core 日志里留一条 warn（含错误文本，便于事后定位）。
    const logs = await waitFor(
      async () => {
        const text = await readLogs(core.services.paths.logsDir);
        return text.includes('computer capabilities handshake failed') ? text : null;
      },
      { label: 'handshake warn log', timeoutMs: 15_000 },
    );
    expect(logs).toContain('sidecar exited before handshake');
  }, 120_000);
});
