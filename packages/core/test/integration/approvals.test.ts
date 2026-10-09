import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { step, viaTask, type TestStack } from '@kepcup/testkit';
import {
  createTestCore,
  createTestStack,
  listMessages,
  startMockLlm,
  makeBot,
  openDirect,
  sendBatch,
  waitFor,
  waitForMessage,
  waitForRun,
} from '@kepcup/testkit';
import { createMemoryKeystore } from '@kepcup/core';
import { TASK_MAX_WALL_MS, type Approval, type Run } from '@kepcup/shared';
import { resolvePaths, workspacePathFor } from '../../src/infra/paths.js';

const stacks: TestStack[] = [];

afterEach(async () => {
  for (const stack of stacks.splice(0)) await stack.cleanup();
});

async function start(env: NodeJS.ProcessEnv = {}): Promise<TestStack> {
  const stack = await createTestStack({ env });
  stacks.push(stack);
  return stack;
}

function workspaceOf(
  stackOrCore: { core?: { services: { paths: { home: string } } }; services?: { paths: { home: string } } },
  botId: string,
  conversationId: string,
): string {
  const home = stackOrCore.core?.services.paths.home ?? stackOrCore.services?.paths.home;
  return workspacePathFor(resolvePaths(home!), botId, conversationId);
}

async function pendingApproval(core: TestStack, conversationId: string): Promise<Approval> {
  return waitFor(async () => {
    const result = (await core.rpc.call('approvals.list', { conversationId })) as {
      approvals: Approval[];
    };
    return result.approvals.find((a) => a.status === 'pending') ?? null;
  }, { label: 'pending approval' });
}

/**
 * D75 W2: access requests, commands and unsandboxed runs are a task's work (a
 * turn is read-only and has none of these tools): the steps run in a task the
 * turn starts; `relay` is the waking turn's reply to the task's result.
 */
function inTask(taskSteps: ReturnType<typeof step>[], relay = '好了'): ReturnType<typeof step>[] {
  return viaTask({ taskSteps, relay });
}

/** The latest settled task of the conversation (D75 W2 migration helper). */
function waitForTask(core: TestStack['core'], conversationId: string, status: Run['status']) {
  return waitForRun(core, conversationId, status, { loopType: 'task', timeoutMs: 120_000 });
}

/** Resolves once the waking turn relayed a task result with exactly `text`. */
function waitForRelay(core: TestStack['core'], conversationId: string, text: string) {
  return waitForMessage(
    core,
    conversationId,
    (m) => 'text' in m.content && m.content.text === text,
    { timeoutMs: 60_000 },
  );
}

/** The conversation's newest task run. */
async function latestTask(core: TestStack['core'], conversationId: string): Promise<Run> {
  const result = (await core.rpc.call('runs.list', { conversationId, limit: 20 })) as {
    runs: Run[];
  };
  const tasks = result.runs
    .filter((r) => r.loopType === 'task')
    .sort((a, b) => b.createdAt - a.createdAt);
  return tasks[0]!;
}

async function stepsOf(core: TestStack, runId: string) {
  const result = (await core.rpc.call('runs.steps', { runId })) as {
    steps: Array<{ type: string; payload: Record<string, unknown> }>;
  };
  return result.steps;
}

describe('access approvals for file tools (P03)', () => {
  it('runs an access approval for an out-of-workspace read; a once-grant covers a single tool call (D75)', async () => {
    const { core, llm } = await start();
    const bot = await makeBot(core, '小授');
    const conv = await openDirect(core, bot.id);
    const dir = fsMkdtemp();
    writeFileSync(path.join(dir, 'secret.txt'), 'outside-content');

    // Run 1: read triggers the approval; approving 仅这一次 lets it through.
    // D75 (D37 tightened): 仅这一次 = one tool call — the second read in the
    // same run needs a second approval (it used to ride on the run-long grant).
    // D75 审查 M4: access approvals are a task's (a turn fails fast instead).
    llm.script(
      'mock-main',
      inTask(
        [
          step().replyToolCall('read', { path: `${dir}/secret.txt` }),
          step().replyToolCall('read', { path: `${dir}/secret.txt` }),
          step().replyText('读完两次'),
        ],
        'RELAY-READ-1',
      ),
    );
    await sendBatch(core, conv.id, ['读一下外部文件']);

    await waitFor(
      async () => {
        const runs = (await core.rpc.call('runs.list', { conversationId: conv.id, limit: 5 })) as {
          runs: Run[];
        };
        return runs.runs.find((r) => r.status === 'waiting_approval') ?? null;
      },
      { label: 'waiting_approval run', timeoutMs: 30_000 },
    );
    const approval = await pendingApproval(core, conv.id);
    expect(approval.kind).toBe('access');
    expect(approval.payload['sensitive']).toBe(false);
    await core.rpc.call('approvals.decide', { id: approval.id, approve: true, duration: 'once' });
    const again = await pendingApproval(core, conv.id);
    expect(again.id).not.toBe(approval.id);
    expect(again.kind).toBe('access');
    await core.rpc.call('approvals.decide', { id: again.id, approve: true, duration: 'once' });
    await waitForRelay(core, conv.id, 'RELAY-READ-1');

    // Two approval cards for run 1 (one per tool call); nothing outlives the
    // calls. (The task's own card — D75 W3 — is not an approval card.)
    const messages1 = await listMessages(core, conv.id);
    const approvalCards = messages1.filter(
      (m) => m.kind === 'card' && (m.content as { cardType?: string }).cardType !== 'task',
    );
    expect(approvalCards.length).toBe(2);
    const left = (await core.rpc.call('grants.list', { conversationId: conv.id })) as {
      grants: unknown[];
    };
    expect(left.grants).toEqual([]);

    // Run 2: the once-grant died with run 1 -> a new approval appears.
    llm.script(
      'mock-main',
      inTask(
        [
          step().replyToolCall('read', { path: `${dir}/secret.txt` }),
          step().replyText('第二次需要重新申请'),
        ],
        'RELAY-READ-2',
      ),
    );
    await sendBatch(core, conv.id, ['再读一次']);
    const second = await pendingApproval(core, conv.id);
    expect(second.id).not.toBe(approval.id);
    await core.rpc.call('approvals.decide', { id: second.id, approve: false });
    await waitForRelay(core, conv.id, 'RELAY-READ-2');
    const steps = await stepsOf(core, (await latestTask(core, conv.id)).id);
    const denied = steps.filter((s) => s.type === 'tool_result' && s.payload['ok'] === false);
    expect(denied.length).toBe(1);
    expect(String(denied[0]!.payload['content'])).toContain('APPROVAL_DENIED');
  }, 120_000);

  it('a once-grant from request_access is used by the next tool call only (D75)', async () => {
    const { core, llm } = await start();
    const bot = await makeBot(core, '小预');
    const conv = await openDirect(core, bot.id);
    const dir = fsMkdtemp();
    writeFileSync(path.join(dir, 'data.txt'), 'pre-authorized');

    llm.script(
      'mock-main',
      inTask(
        [
          step().replyToolCall('request_access', { path: dir, access: 'read', reason: '先申请' }),
          step().replyToolCall('read', { path: `${dir}/data.txt` }),
          step().replyToolCall('read', { path: `${dir}/data.txt` }),
          step().replyText('完成'),
        ],
        'RELAY-PRE',
      ),
    );
    await sendBatch(core, conv.id, ['读目录']);
    const first = await pendingApproval(core, conv.id);
    expect(first.kind).toBe('access');
    await core.rpc.call('approvals.decide', { id: first.id, approve: true, duration: 'once' });
    // The first read consumed the pre-authorization; the second asks again.
    const second = await pendingApproval(core, conv.id);
    expect(second.id).not.toBe(first.id);
    await core.rpc.call('approvals.decide', { id: second.id, approve: false });
    await waitForRelay(core, conv.id, 'RELAY-PRE');
    const run = await latestTask(core, conv.id);
    const results = (await stepsOf(core, run.id)).filter(
      (s) => s.type === 'tool_result' && s.payload['toolName'] === 'read',
    );
    expect(results.map((s) => s.payload['ok'])).toEqual([true, false]);
    expect(String(results[0]!.payload['content'])).toContain('pre-authorized');
  }, 120_000);

  it('keeps conversation grants until revoked, scoped to bot + conversation', async () => {
    const { core, llm } = await start();
    const bot = await makeBot(core, '小持');
    const otherBot = await makeBot(core, '小他');
    const conv = await openDirect(core, bot.id);
    const otherConv = await openDirect(core, otherBot.id);
    const dir = fsMkdtemp();
    writeFileSync(path.join(dir, 'note.txt'), 'grant-me');

    llm.script(
      'mock-main',
      inTask(
        [
          step().replyToolCall('request_access', { path: dir, access: 'read', reason: '批量读取前申请' }),
          step().replyText('申请好了'),
        ],
        'RELAY-GRANT',
      ),
    );
    await sendBatch(core, conv.id, ['申请访问']);
    const approval = await pendingApproval(core, conv.id);
    expect(approval.kind).toBe('access');
    await core.rpc.call('approvals.decide', { id: approval.id, approve: true, duration: 'conversation' });
    await waitForTask(core, conv.id, 'completed');
    await waitForMessage(core, conv.id, (m) => 'text' in m.content && m.content.text === 'RELAY-GRANT');

    // The grant is listed and scoped to bot + conversation. The stored path is
    // the canonical (realpath) form, so compare through canonicalPath.
    const { canonicalPath } = await import('../../src/infra/paths.js');
    const grants = (await core.rpc.call('grants.list', { conversationId: conv.id })) as {
      grants: Array<{ id: string; botId: string; path: string }>;
    };
    expect(grants.grants.length).toBe(1);
    expect(grants.grants[0]!.botId).toBe(bot.id);
    expect(grants.grants[0]!.path).toBe(canonicalPath(dir));

    // A later run of the SAME bot reads the file without a new approval —
    // a turn too (no approval needed, so no fail-fast either).
    llm.script('mock-main', [
      step().replyToolCall('read', { path: `${dir}/note.txt` }),
      step().replyText('读到了'),
    ]);
    await core.rpc.call('drafts.add', { conversationId: conv.id, text: '再读一次' });
    const second = (await core.rpc.call('drafts.flush', { conversationId: conv.id })) as {
      runId: string | null;
    };
    const covered = await waitFor(
      async () => {
        const runs = (await core.rpc.call('runs.list', { conversationId: conv.id, limit: 5 })) as {
          runs: Run[];
        };
        const run = runs.runs.find((r) => r.id === second.runId);
        return run && run.status === 'completed' ? run : null;
      },
      { label: 'grant-covered run completes', timeoutMs: 60_000 },
    );
    const coveredRead = (await stepsOf(core, covered.id)).find(
      (s) => s.type === 'tool_result' && s.payload['toolName'] === 'read',
    );
    expect(String(coveredRead!.payload['content'])).toContain('grant-me');
    const approvalsAfter = (await core.rpc.call('approvals.list', { conversationId: conv.id })) as {
      approvals: Approval[];
    };
    expect(approvalsAfter.approvals.filter((a) => a.status === 'pending').length).toBe(0);

    // Another bot in its own conversation is NOT covered by the grant
    // (grants belong to bot + conversation): a fresh approval appears there.
    llm.script(
      'mock-main',
      inTask(
        [
          step().replyToolCall('read', { path: `${dir}/note.txt` }),
          step().replyText('另一个对话读不到'),
        ],
        'RELAY-OTHER',
      ),
    );
    await sendBatch(core, otherConv.id, ['读外部文件']);
    const otherApproval = await pendingApproval(core, otherConv.id);
    expect(otherApproval).toBeDefined();
    await core.rpc.call('approvals.decide', { id: otherApproval.id, approve: false });
    await waitForRelay(core, otherConv.id, 'RELAY-OTHER');

    // Revoke -> immediate effect: the next run needs a new approval.
    await core.rpc.call('grants.revoke', { id: grants.grants[0]!.id });
    llm.script(
      'mock-main',
      inTask([
        step().replyToolCall('read', { path: `${dir}/note.txt` }),
        step().replyText('撤销后读不到了'),
      ]),
    );
    await sendBatch(core, conv.id, ['撤销后再读']);
    const finalApproval = await pendingApproval(core, conv.id);
    expect(finalApproval).toBeDefined();
  }, 180_000);

  it('cancels pending approvals when the run is cancelled and on restart', async () => {
    const home = await mkdtempP03();
    const keystore = createMemoryKeystore();
    const { core, llm } = await createTestStack({ home, keystore });
    const bot = await makeBot(core, '小取');
    const conv = await openDirect(core, bot.id);
    const dir = fsMkdtemp();
    llm.script('mock-main', inTask([step().replyToolCall('read', { path: dir }), step().replyText('不该到达')]));
    await sendBatch(core, conv.id, ['读外部']);
    const approval = await pendingApproval(core, conv.id);
    const runId = (await latestTask(core, conv.id)).id;

    // Cancel while waiting: approval -> cancelled, run -> cancelled.
    await core.rpc.call('runs.cancel', { runId });
    await waitFor(
      async () => {
        const result = (await core.rpc.call('approvals.list', { conversationId: conv.id })) as {
          approvals: Approval[];
        };
        return result.approvals.find((a) => a.id === approval.id && a.status === 'cancelled') ?? null;
      },
      { label: 'approval cancelled' },
    );
    const cancelledRun = await waitForRun(core, conv.id, 'cancelled', {
      timeoutMs: 30_000,
      loopType: 'task',
    });
    expect(cancelledRun.id).toBe(runId);

    // Restart on the same home: pending approvals never survive.
    const bot2 = await makeBot(core, '小启');
    const conv2 = await openDirect(core, bot2.id);
    const dir2 = fsMkdtemp();
    llm.script('mock-main', inTask([step().replyToolCall('read', { path: dir2 }), step().replyText('x')]));
    await sendBatch(core, conv2.id, ['再来一次']);
    await pendingApproval(core, conv2.id);

    const mockUrl = (llm as unknown as { url: string }).url;
    await core.close();
    await llm.stop();
    const { startMockLlm } = await import('@kepcup/testkit');
    const llm2 = await startMockLlm();
    const restarted = await createTestStack({ home, keystore, env: { KEPCUP_MOCK_LLM_URL: mockUrl } });
    // The seeded mock provider keeps the old port; align it like start does.
    // (No model calls happen in the assertions below, so this is informational.)
    void llm2;
    try {
      const approvals = (await restarted.core.rpc.call('approvals.list', { conversationId: conv2.id })) as {
        approvals: Approval[];
      };
      expect(approvals.approvals.filter((a) => a.status === 'pending').length).toBe(0);
      expect(approvals.approvals.some((a) => a.status === 'cancelled')).toBe(true);
      const runs2 = (await restarted.core.rpc.call('runs.list', { conversationId: conv2.id, limit: 5 })) as {
        runs: Run[];
      };
      expect(runs2.runs.find((r) => r.loopType === 'task')!.status).toBe('interrupted');
      const services = restarted.core.services.domain!;
      const cancelled = approvals.approvals.find((a) => a.status === 'cancelled')!;
      expect(services.approvals.renderContextLine(cancelled)).toContain('已取消');
    } finally {
      await restarted.cleanup();
      await rmP03(home);
    }
  }, 120_000);

  it('never grants the data directory, even in unattended mode', async () => {
    const { core, llm } = await start();
    const bot = await makeBot(core, '小底');
    const conv = await openDirect(core, bot.id);
    const dataHome = core.services.paths.home;

    // Enable unattended mode through the UI-only RPC.
    await core.rpc.call('unattended.enable', { hours: 1, acknowledgeRisk: true });

    llm.script('mock-main', [
      step().replyToolCall('read', { path: path.join(dataHome, 'main.db') }),
      step().replyText('读不到数据目录'),
    ]);
    await sendBatch(core, conv.id, ['读数据库文件']);
    await waitForRun(core, conv.id, 'completed', { timeoutMs: 60_000 });

    const runsDb = (await core.rpc.call('runs.list', { conversationId: conv.id, limit: 5 }) as { runs: Run[] }).runs;
    const steps = await stepsOf(core, runsDb.find((r) => r.loopType === 'turn')!.id);
    const readResult = steps.find((s) => s.type === 'tool_result' && s.payload['toolName'] === 'read');
    expect(readResult!.payload['ok']).toBe(false);
    expect(String(readResult!.payload['content'])).toContain('PATH_OUT_OF_SCOPE');
  }, 120_000);

  it('denies data-dir commands in confirm mode under unattended mode (BR-P03-001)', async () => {
    const { core, llm } = await start({ KEPCUP_SANDBOX: 'off' });
    const bot = await makeBot(core, '小漏');
    const conv = await openDirect(core, bot.id);
    const dataHome = core.services.paths.home;

    await core.rpc.call('unattended.enable', { hours: 1, acknowledgeRisk: true });

    // The command targets the data directory; the unattended floor must refuse
    // the auto-approval instead of executing it unsandboxed.
    llm.script(
      'mock-main',
      inTask([
        step().replyToolCall('bash', { command: `cat "${dataHome}/main.db" | wc -c` }),
        step().replyText('拿不到'),
      ]),
    );
    await sendBatch(core, conv.id, ['统计数据库大小']);
    await waitForTask(core, conv.id, 'completed');

    const approvals = (await core.rpc.call('approvals.list', { conversationId: conv.id })) as {
      approvals: Array<{ kind: string; status: string; autoApproved: boolean; payload: Record<string, unknown> }>;
    };
    const commandApproval = approvals.approvals.find((a) => a.kind === 'command');
    expect(commandApproval).toBeDefined();
    expect(commandApproval!.status).toBe('denied');
    expect(commandApproval!.autoApproved).toBe(true);

    // The audit records the refused auto-decision.
    const audit = core.services.domain!.audit.listByConversation(conv.id, 100);
    const auto = audit.find((a) => a.action === 'approval_auto');
    expect(auto).toBeDefined();
    expect(auto!.detail['refused']).toBe(true);

    // Nothing leaked: no exec_unsandboxed for this run.
    expect(audit.some((a) => a.action === 'exec_unsandboxed')).toBe(false);
  }, 120_000);

  it('auto-approves all three kinds in unattended mode with audit + expiry', async () => {
    const { core, llm } = await start({ KEPCUP_SANDBOX: 'off' });
    const bot = await makeBot(core, '小无');
    const conv = await openDirect(core, bot.id);
    const outside = fsMkdtemp();
    writeFileSync(path.join(outside, 'f.txt'), 'x');

    await core.rpc.call('unattended.enable', { hours: null, acknowledgeRisk: true });
    expect(((await core.rpc.call('unattended.get')) as { enabled: boolean }).enabled).toBe(true);

    // access + unsandboxed + command (confirm mode) all auto-approve.
    llm.script(
      'mock-main',
      inTask([
        step().replyToolCall('request_access', { path: outside, access: 'read', reason: 'r' }),
        step().replyToolCall('request_unsandboxed', { command: 'echo unattended-ok', reason: '需要沙箱外' }),
        step().replyToolCall('bash', { command: 'echo confirm-ok' }),
        step().replyText('都批准了'),
      ]),
    );
    await sendBatch(core, conv.id, ['无人值守跑一轮']);
    const run = await waitForTask(core, conv.id, 'completed');

    const approvals = (await core.rpc.call('approvals.list', { conversationId: conv.id })) as {
      approvals: Approval[];
    };
    const auto = approvals.approvals.filter((a) => a.autoApproved);
    expect(new Set(auto.map((a) => a.kind))).toEqual(new Set(['access', 'unsandboxed', 'command']));

    // Audit trail for every auto-approval.
    const audit = core.services.domain!.audit.listByConversation(conv.id, 100);
    expect(audit.filter((a) => a.action === 'approval_auto').length).toBeGreaterThanOrEqual(3);
    expect(audit.some((a) => a.action === 'exec_unsandboxed')).toBe(true);

    // Auto-approved access grants are once-only: gone after the run.
    const grants = (await core.rpc.call('grants.list', { conversationId: conv.id })) as {
      grants: Array<{ id: string }>;
    };
    expect(grants.grants.length).toBe(0);
    void run;

    // Timed auto-off.
    await core.rpc.call('unattended.enable', { hours: 1, acknowledgeRisk: true });
    const state = (await core.rpc.call('unattended.disable')) as { enabled: boolean };
    expect(state.enabled).toBe(false);
  }, 180_000);

  it('auto-approves mcp_tool calls of every risk tier in unattended mode, risk in payload + audit (W5)', async () => {
    const { core } = await start();
    const bot = await makeBot(core, '小控');
    const conv = await openDirect(core, bot.id);
    await core.rpc.call('unattended.enable', { hours: null, acknowledgeRisk: true });
    const approvals = core.services.domain!.approvals;
    const identity = { runId: 'run_mcp_unattended', botId: bot.id, conversationId: conv.id, loopType: 'task' as const };
    const outcomes = [];
    for (const risk of ['read', 'write', 'destructive'] as const) {
      outcomes.push(
        await approvals.request(identity, 'mcp_tool', {
          serverId: 'srv1',
          serverName: '笔记服务器',
          toolName: `tool_${risk}`,
          argsSummary: '{}',
          risk,
        }),
      );
    }
    // Every tier is approved on its own: no pending card, no refusal.
    expect(outcomes.map((o) => o.decision)).toEqual(['approved', 'approved', 'approved']);
    expect(outcomes.every((o) => o.approval.autoApproved === true)).toBe(true);
    expect(outcomes.map((o) => o.approval.payload['risk'])).toEqual(['read', 'write', 'destructive']);
    const listed = (await core.rpc.call('approvals.list', { conversationId: conv.id })) as {
      approvals: Approval[];
    };
    expect(listed.approvals.filter((a) => a.kind === 'mcp_tool' && a.autoApproved)).toHaveLength(3);
    expect(listed.approvals.some((a) => a.status === 'pending')).toBe(false);
    // auto_approved=1 rows carry the risk into the audit trail and the summary.
    const audit = core.services.domain!.audit.listByConversation(conv.id, 50);
    const autoEntries = audit.filter((a) => a.action === 'approval_auto' && a.detail['kind'] === 'mcp_tool');
    expect(autoEntries.map((a) => a.detail['risk']).sort()).toEqual(['destructive', 'read', 'write']);
    const summary = approvals.summary();
    expect(summary.find((row) => row.detail.includes('tool_destructive'))?.detail).toContain('破坏性');
    // The folded context line says it was auto-approved and names the tier.
    const line = approvals.renderContextLine(outcomes[1]!.approval);
    expect(line).toContain('无人值守自动批准（写入）');
    expect(line).toContain('tool_write');
  }, 60_000);

  it('returns approval cards in conversation context lines (system render)', async () => {
    const { core, llm } = await start();
    const bot = await makeBot(core, '小卡');
    const conv = await openDirect(core, bot.id);
    const dir = fsMkdtemp();
    llm.script(
      'mock-main',
      inTask(
        [
          step().replyToolCall('request_access', { path: dir, access: 'write', reason: '要写文件' }),
          step().replyText('请求已发'),
        ],
        'RELAY-CARD',
      ),
    );
    const first = await (async () => {
      await core.rpc.call('drafts.add', { conversationId: conv.id, text: '申请写权限' });
      return (await core.rpc.call('drafts.flush', { conversationId: conv.id })) as {
        runId: string | null;
      };
    })();
    const approval = await pendingApproval(core, conv.id);
    await core.rpc.call('approvals.decide', { id: approval.id, approve: true, duration: 'once' });
    await waitFor(
      async () => {
        const runs = (await core.rpc.call('runs.list', { conversationId: conv.id, limit: 5 })) as {
          runs: Run[];
        };
        const run = runs.runs.find((r) => r.id === first.runId);
        return run && run.status === 'completed' ? run : null;
      },
      { label: 'first run completes', timeoutMs: 60_000 },
    );
    await waitForTask(core, conv.id, 'completed');
    await waitForMessage(core, conv.id, (m) => 'text' in m.content && m.content.text === 'RELAY-CARD');

    // The folded line appears in the next run's request context.
    llm.script('mock-main', [step().replyText('看到卡片记录了')]);
    await core.rpc.call('drafts.add', { conversationId: conv.id, text: '继续' });
    const second = (await core.rpc.call('drafts.flush', { conversationId: conv.id })) as {
      runId: string | null;
    };
    expect(second.runId).not.toBeNull();
    await waitFor(
      async () => {
        const runs = (await core.rpc.call('runs.list', { conversationId: conv.id, limit: 5 })) as {
          runs: Run[];
        };
        const run = runs.runs.find((r) => r.id === second.runId);
        return run && run.status === 'completed' ? run : null;
      },
      { label: 'second run completes', timeoutMs: 60_000 },
    );
    const bodies = llm.requests();
    expect(bodies.some((r) => r.lastUserText().includes('用户允许'))).toBe(true);
  }, 120_000);
});

describe('confirm mode (sandbox unavailable, P03)', () => {
  it('requires a command approval for non-allowlisted commands and executes after approval', async () => {
    const { core, llm } = await start({ KEPCUP_SANDBOX: 'off' });
    const bot = await makeBot(core, '小确');
    const conv = await openDirect(core, bot.id);

    llm.script(
      'mock-main',
      inTask([
        step().replyToolCall('bash', { command: 'touch confirm-marker' }),
        step().replyText('执行过了'),
      ]),
    );
    await sendBatch(core, conv.id, ['建个文件']);
    const approval = await pendingApproval(core, conv.id);
    expect(approval.kind).toBe('command');
    expect(String(approval.payload['command'])).toBe('touch confirm-marker');

    await core.rpc.call('approvals.decide', { id: approval.id, approve: true });
    await waitForTask(core, conv.id, 'completed');
    const workspace = workspaceOf(core, bot.id, conv.id);
    expect(existsSync(path.join(workspace, 'confirm-marker'))).toBe(true);
  }, 120_000);

  it('runs allowlisted read-only commands without confirmation but re-confirms out-of-scope paths', async () => {
    const { core, llm } = await start({ KEPCUP_SANDBOX: 'off' });
    const bot = await makeBot(core, '小白');
    const conv = await openDirect(core, bot.id);
    const workspace = workspaceOf(core, bot.id, conv.id);
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(workspace, 'in.txt'), 'workspace-file');

    // Allowlisted + paths inside workspace -> runs directly.
    llm.script(
      'mock-main',
      inTask([step().replyToolCall('bash', { command: 'cat in.txt' }), step().replyText('读到了')], 'RELAY-IN'),
    );
    await sendBatch(core, conv.id, ['看下文件']);
    await waitForTask(core, conv.id, 'completed');
    await waitForMessage(core, conv.id, (m) => 'text' in m.content && m.content.text === 'RELAY-IN');
    const approvals1 = (await core.rpc.call('approvals.list', { conversationId: conv.id })) as {
      approvals: Approval[];
    };
    expect(approvals1.approvals.length).toBe(0);

    // Allowlisted command but path outside scope -> needs approval.
    const outsideDir = fsMkdtemp();
    llm.script(
      'mock-main',
      inTask([
        step().replyToolCall('bash', { command: `cat ${outsideDir}/out.txt` }),
        step().replyText('需要确认'),
      ]),
    );
    await sendBatch(core, conv.id, ['读外面的']);
    const approval = await pendingApproval(core, conv.id);
    expect(approval.kind).toBe('command');
    await core.rpc.call('approvals.decide', { id: approval.id, approve: false });
    await waitFor(
      async () => {
        const runs = (await core.rpc.call('runs.list', { conversationId: conv.id, limit: 20 })) as {
          runs: Run[];
        };
        return runs.runs.filter((r) => r.loopType === 'task' && r.status === 'completed').length === 2
          ? true
          : null;
      },
      { label: 'second task completes', timeoutMs: 60_000 },
    );
  }, 120_000);
});

describe('unsandboxed execution (P03)', () => {
  it('shows the full command in the card and runs it outside the sandbox after approval', async () => {
    const { core, llm } = await start();
    const bot = await makeBot(core, '小沙');
    const conv = await openDirect(core, bot.id);

    llm.script(
      'mock-main',
      inTask([
        step().replyToolCall('request_unsandboxed', { command: 'echo direct-$(date +%s)', reason: 'Docker 需要' }),
        step().replyText('沙箱外执行完成'),
      ]),
    );
    await sendBatch(core, conv.id, ['帮我在沙箱外跑一条命令']);
    const approval = await pendingApproval(core, conv.id);
    expect(approval.kind).toBe('unsandboxed');
    expect(String(approval.payload['command'])).toContain('echo direct-');

    await core.rpc.call('approvals.decide', { id: approval.id, approve: true });
    await waitForTask(core, conv.id, 'completed');

    const audit = core.services.domain!.audit.listByConversation(conv.id, 100);
    expect(audit.some((a) => a.action === 'exec_unsandboxed')).toBe(true);
    // os.homedir exists only to keep the temp dir referenced for cleanup tools.
    void os.homedir();
  }, 120_000);
});

// --- helpers ------------------------------------------------------------------

const madeDirs: string[] = [];

function fsMkdtemp(): string {
  const dir = path.join(os.tmpdir(), `kepcup-p03-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  madeDirs.push(dir);
  return dir;
}

async function mkdtempP03(): Promise<string> {
  return fsMkdtemp();
}

async function rmP03(dir: string): Promise<void> {
  const { rm } = await import('node:fs/promises');
  await rm(dir, { recursive: true, force: true });
}

// Keep unused imports referenced.
void waitForMessage;

// ---------------------------------------------------------------------------
// W4 审批幂等与回执（todo/borrowings-from-personal-agents.md W4）：真实任务经
// PiEngine + 真实 stdio MCP server 调写工具——同一任务链里相同操作的去重门
// （completed / denied / uncertain）、跨任务链不去重、无人值守、payloadHash、
// 回执、收件方完整展示。

const W4_SERVER_SCRIPT = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\\n'); }
let n = 0;
const schema = { type: 'object', properties: { to: { type: 'string' }, text: { type: 'string' } } };
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: {
      protocolVersion: '2025-06-18', capabilities: { tools: {} },
      serverInfo: { name: 'chat', version: '1.0.0' } } });
    return;
  }
  if (String(msg.method).startsWith('notifications/')) return;
  if (msg.method === 'ping') { send({ jsonrpc: '2.0', id: msg.id, result: {} }); return; }
  if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: [
      { name: 'send_message', description: '发消息', inputSchema: schema,
        annotations: { destructiveHint: false } },
      { name: 'flaky_send', description: '发消息（连接会断）', inputSchema: schema,
        annotations: { destructiveHint: false } },
    ] } });
    return;
  }
  if (msg.method === 'tools/call') {
    if (msg.params?.name === 'flaky_send') process.exit(1);
    n += 1;
    send({ jsonrpc: '2.0', id: msg.id, result: {
      content: [{ type: 'text', text: JSON.stringify({ id: 'm-' + n, url: 'https://chat.example/m/' + n }) }],
      isError: false } });
  }
});
`;

type W4Approval = Approval & { payloadHash?: string; effect?: { status: string; receipt?: Record<string, string> } };

async function w4Stack() {
  const stack = await start();
  const dir = fsMkdtemp();
  const scriptPath = path.join(dir, 'chat-server.cjs');
  writeFileSync(scriptPath, W4_SERVER_SCRIPT);
  await stack.core.rpc.call('settings.update', {
    mcpServers: [
      {
        id: 'chat',
        name: '聊天服务',
        transport: 'stdio',
        command: process.execPath,
        args: [scriptPath],
        env: {},
        enabled: true,
        autoApprove: false,
      },
    ],
  });
  const bot = await makeBot(stack.core, '小信');
  await stack.core.rpc.call('bots.update', {
    id: bot.id,
    profile: { ...bot.profile, runtime: { ...bot.profile.runtime, mcp_server_ids: ['chat'] } },
  });
  const conv = await openDirect(stack.core, bot.id);
  return { ...stack, bot, conv };
}

async function mcpApprovals(core: TestStack['core'], conversationId: string): Promise<W4Approval[]> {
  const result = (await core.rpc.call('approvals.list', { conversationId })) as {
    approvals: W4Approval[];
  };
  return result.approvals
    .filter((a) => a.kind === 'mcp_tool')
    .sort((a, b) => a.createdAt - b.createdAt);
}

async function pendingMcp(core: TestStack['core'], conversationId: string, skip: string[] = []) {
  return waitFor(
    async () =>
      (await mcpApprovals(core, conversationId)).find(
        (a) => a.status === 'pending' && !skip.includes(a.id),
      ) ?? null,
    { label: 'pending mcp_tool approval', timeoutMs: 30_000 },
  );
}

async function toolResults(core: TestStack, runId: string, toolName: string) {
  return (await stepsOf(core, runId))
    .filter((s) => s.type === 'tool_result' && s.payload['toolName'] === toolName)
    .map((s) => s.payload);
}

describe('approval effect dedupe and receipts (W4)', () => {
  it('effect: a completed duplicate gets no card (DUPLICATE_EFFECT + receipt); different args ask again; stale hash refused; cards carry receipts and full recipients', async () => {
    const { core, llm, conv } = await w4Stack();
    llm.script(
      'mock-main',
      viaTask({
        writes: false,
        taskSteps: [
          step().replyToolCall('mcp_chat_send_message', { to: 'ann@example.com', text: '你好' }),
          step().replyToolCall('mcp_chat_send_message', { text: '你好', to: 'ann@example.com' }),
          step().replyToolCall('mcp_chat_send_message', { to: 'bob@example.com', text: '你好' }),
          step().replyText('都发了'),
        ],
        relay: 'W4-RELAY-1',
      }),
    );
    await sendBatch(core, conv.id, ['给 ann 发消息']);

    const first = await pendingMcp(core, conv.id);
    // Exact card: the recipient is listed in full, outside argsSummary.
    expect(first.payload['recipients']).toEqual([{ key: 'to', value: 'ann@example.com' }]);
    expect(first.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    // A decision bound to another payload is refused; the card stays pending.
    await expect(
      core.rpc.call('approvals.decide', { id: first.id, approve: true, payloadHash: 'f'.repeat(64) }),
    ).rejects.toMatchObject({ code: 'APPROVAL_STALE' });
    expect((await mcpApprovals(core, conv.id))[0]!.status).toBe('pending');
    await core.rpc.call('approvals.decide', {
      id: first.id,
      approve: true,
      payloadHash: first.payloadHash,
    });

    // The identical second call never shows a card: the next one is for bob.
    const second = await pendingMcp(core, conv.id, [first.id]);
    expect(second.payload['recipients']).toEqual([{ key: 'to', value: 'bob@example.com' }]);
    await core.rpc.call('approvals.decide', { id: second.id, approve: true });
    await waitForRelay(core, conv.id, 'W4-RELAY-1');

    const task = await latestTask(core, conv.id);
    const results = await toolResults(core, task.id, 'mcp_chat_send_message');
    expect(results.map((r) => [r['ok'], r['errorCode'] ?? null])).toEqual([
      [true, null],
      [false, 'DUPLICATE_EFFECT'],
      [true, null],
    ]);
    expect(String(results[1]!['content'])).toContain('相同操作已在本任务中完成');
    expect(String(results[1]!['content'])).toContain('https://chat.example/m/1');

    // Two cards, each with its receipt; the ledger has no row for the duplicate.
    const cards = await waitFor(
      async () => {
        const list = await mcpApprovals(core, conv.id);
        return list.every((a) => a.effect?.status === 'completed') ? list : null;
      },
      { label: 'receipts on cards' },
    );
    expect(cards).toHaveLength(2);
    expect(cards[0]!.effect).toMatchObject({
      status: 'completed',
      receipt: { url: 'https://chat.example/m/1', externalId: 'm-1' },
    });
    const effects = (await core.rpc.call('effects.list', { taskId: task.id })) as {
      effects: Array<{ status: string; approvalId: string | null }>;
    };
    expect(effects.effects.map((e) => e.status)).toEqual(['completed', 'completed']);
    const audit = core.services.domain!.audit.listByConversation(conv.id, 200);
    expect(audit.find((a) => a.action === 'approval_deduped')?.detail).toMatchObject({
      kind: 'mcp_tool',
      verdict: 'completed',
    });
  }, 120_000);

  it('effect: a denied duplicate is refused without a card (用户已拒绝相同操作)', async () => {
    const { core, llm, conv } = await w4Stack();
    llm.script(
      'mock-main',
      viaTask({
        writes: false,
        taskSteps: [
          step().replyToolCall('mcp_chat_send_message', { to: 'ann@example.com', text: '在吗' }),
          step().replyToolCall('mcp_chat_send_message', { to: 'ann@example.com', text: '在吗' }),
          step().replyText('用户不让发'),
        ],
        relay: 'W4-RELAY-2',
      }),
    );
    await sendBatch(core, conv.id, ['发一条']);
    const first = await pendingMcp(core, conv.id);
    await core.rpc.call('approvals.decide', { id: first.id, approve: false });
    await waitForRelay(core, conv.id, 'W4-RELAY-2');
    const task = await latestTask(core, conv.id);
    const results = await toolResults(core, task.id, 'mcp_chat_send_message');
    expect(results.map((r) => r['errorCode'])).toEqual(['APPROVAL_DENIED', 'APPROVAL_DENIED']);
    expect(String(results[1]!['content'])).toContain('用户已拒绝相同操作');
    expect(await mcpApprovals(core, conv.id)).toHaveLength(1);
    const effects = (await core.rpc.call('effects.list', { taskId: task.id })) as {
      effects: Array<{ status: string }>;
    };
    expect(effects.effects.map((e) => e.status)).toEqual(['denied', 'denied']);
  }, 120_000);

  it('effect: an uncertain earlier attempt still asks, with the 结果未知 flag on the card', async () => {
    const { core, llm, conv } = await w4Stack();
    llm.script(
      'mock-main',
      viaTask({
        writes: false,
        taskSteps: [
          step().replyToolCall('mcp_chat_flaky_send', { to: 'ann@example.com', text: '1' }),
          step().replyToolCall('mcp_chat_flaky_send', { to: 'ann@example.com', text: '1' }),
          step().replyText('先不发了'),
        ],
        relay: 'W4-RELAY-3',
      }),
    );
    await sendBatch(core, conv.id, ['发']);
    const first = await pendingMcp(core, conv.id);
    expect(first.payload['priorEffect']).toBeUndefined();
    await core.rpc.call('approvals.decide', { id: first.id, approve: true });
    const second = await pendingMcp(core, conv.id, [first.id]);
    expect(second.payload['priorEffect']).toMatchObject({ status: 'uncertain' });
    await core.rpc.call('approvals.decide', { id: second.id, approve: false });
    await waitForRelay(core, conv.id, 'W4-RELAY-3');
    const cards = await mcpApprovals(core, conv.id);
    expect(cards[0]!.effect?.status).toBe('uncertain');
    // The denied second card's row went intended → denied, never 结果未知.
    expect(cards[1]!.effect?.status).toBe('denied');
  }, 120_000);

  it('effect: another task chain asks again for the same operation', async () => {
    const { core, llm, conv } = await w4Stack();
    llm.script('mock-main', [
      ...viaTask({
        writes: false,
        taskSteps: [
          step().replyToolCall('mcp_chat_send_message', { to: 'ann@example.com', text: '早' }),
          step().replyText('发了'),
        ],
        relay: 'W4-RELAY-4A',
      }),
      ...viaTask({
        writes: false,
        taskSteps: [
          step().replyToolCall('mcp_chat_send_message', { to: 'ann@example.com', text: '早' }),
          step().replyText('又发了'),
        ],
        relay: 'W4-RELAY-4B',
      }),
    ]);
    await sendBatch(core, conv.id, ['发一条']);
    const first = await pendingMcp(core, conv.id);
    await core.rpc.call('approvals.decide', { id: first.id, approve: true });
    await waitForRelay(core, conv.id, 'W4-RELAY-4A');
    await sendBatch(core, conv.id, ['再发一条一样的']);
    const second = await pendingMcp(core, conv.id, [first.id]);
    expect(second.payload['priorEffect']).toBeUndefined();
    await core.rpc.call('approvals.decide', { id: second.id, approve: true });
    await waitForRelay(core, conv.id, 'W4-RELAY-4B');
    const task = await latestTask(core, conv.id);
    expect((await toolResults(core, task.id, 'mcp_chat_send_message'))[0]!['ok']).toBe(true);
  }, 120_000);

  it('effect: unattended mode never auto-approves a completed duplicate, and waits for the user on an uncertain one', async () => {
    const { core, llm, conv } = await w4Stack();
    await core.rpc.call('unattended.enable', { hours: null, acknowledgeRisk: true });
    llm.script(
      'mock-main',
      viaTask({
        writes: false,
        taskSteps: [
          step().replyToolCall('mcp_chat_send_message', { to: 'ann@example.com', text: '夜' }),
          step().replyToolCall('mcp_chat_send_message', { to: 'ann@example.com', text: '夜' }),
          step().replyToolCall('mcp_chat_flaky_send', { to: 'ann@example.com', text: '夜' }),
          step().replyToolCall('ask_user', { question: '再试一次？', options: ['再试'] }),
          step().replyToolCall('mcp_chat_flaky_send', { to: 'ann@example.com', text: '夜' }),
          step().replyText('完成'),
        ],
        relay: 'W4-RELAY-5',
      }),
    );
    await sendBatch(core, conv.id, ['夜里发']);
    // 复查 B2: the user answers the question — that never clears an uncertain attempt.
    const question = await waitForMessage(
      core,
      conv.id,
      (m) =>
        m.kind === 'system_event' &&
        (m.content as { event?: string; answer?: unknown }).event !== undefined &&
        Array.isArray((m.content as { options?: unknown }).options) &&
        (m.content as { answer?: unknown }).answer === undefined,
      { timeoutMs: 30_000 },
    );
    await core.rpc.call('tasks.answer', { messageId: question.id, answer: '再试' });
    // The uncertain repeat is not auto-approved: a pending card with the flag.
    const pending = await pendingMcp(core, conv.id);
    expect(pending.payload['toolName']).toBe('flaky_send');
    expect(pending.payload['priorEffect']).toMatchObject({ status: 'uncertain' });
    await core.rpc.call('approvals.decide', { id: pending.id, approve: false });
    await waitForRelay(core, conv.id, 'W4-RELAY-5');

    const task = await latestTask(core, conv.id);
    const sends = await toolResults(core, task.id, 'mcp_chat_send_message');
    expect(sends.map((r) => r['errorCode'] ?? null)).toEqual([null, 'DUPLICATE_EFFECT']);
    const cards = await mcpApprovals(core, conv.id);
    // send_message auto-approved once; flaky_send auto-approved once + the pending one.
    expect(cards.map((a) => [a.payload['toolName'], a.status, a.autoApproved])).toEqual([
      ['send_message', 'approved', true],
      ['flaky_send', 'approved', true],
      ['flaky_send', 'denied', false],
    ]);
    // The unattended summary carries the auto-approved calls' outcomes.
    const summary = (await core.rpc.call('unattended.summary', {})) as {
      items: Array<{ approvalId: string; effectStatus?: string }>;
    };
    expect(summary.items.find((i) => i.approvalId === cards[0]!.id)?.effectStatus).toBe('completed');
    expect(summary.items.find((i) => i.approvalId === cards[1]!.id)?.effectStatus).toBe('uncertain');
  }, 120_000);
  it('effect (复查 B1): cancelling a task while its card waits, then continuing it, asks again', async () => {
    const { core, llm, conv } = await w4Stack();
    llm.script(
      'mock-main',
      viaTask({
        writes: false,
        taskSteps: [
          step().replyToolCall('mcp_chat_send_message', { to: 'ann@example.com', text: '取消' }),
          step().replyText('没发成'),
        ],
      }),
    );
    await sendBatch(core, conv.id, ['发一条']);
    const first = await pendingMcp(core, conv.id);
    const task = await latestTask(core, conv.id);
    await core.rpc.call('runs.cancel', { runId: task.id });
    await waitFor(
      async () => ((await mcpApprovals(core, conv.id))[0]?.status === 'cancelled' ? true : null),
      { label: 'card cancelled' },
    );
    await waitFor(
      async () => {
        const effects = (await core.rpc.call('effects.list', { taskId: task.id })) as {
          effects: Array<{ status: string }>;
        };
        return effects.effects[0]?.status === 'denied' ? true : null;
      },
      { label: 'ledger row denied' },
    );

    // The bot continues the cancelled task: the same call shows a card again.
    llm.script('mock-main', [
      step().inTurn().replyToolCall('start_task', {
        title: '重发',
        instruction: '接着发',
        source_message_ids: [],
        writes: false,
        continues_task_id: task.id,
      }),
      step().inTurn().replyText('好的'),
      step().inTask().replyToolCall('mcp_chat_send_message', { to: 'ann@example.com', text: '取消' }),
      step().inTask().replyText('发了'),
      step().inTurn().replyText('W4-RELAY-B1'),
    ]);
    await sendBatch(core, conv.id, ['还是发吧']);
    const again = await pendingMcp(core, conv.id, [first.id]);
    expect(again.payload['priorEffect']).toBeUndefined();
    await core.rpc.call('approvals.decide', { id: again.id, approve: true });
    await waitForRelay(core, conv.id, 'W4-RELAY-B1');
    const retried = await latestTask(core, conv.id);
    expect(retried.continuedFromRunIds).toContain(task.id);
    expect((await toolResults(core, retried.id, 'mcp_chat_send_message'))[0]!['ok']).toBe(true);
  }, 120_000);

  it('effect (复查 B1): quitting while a card waits, then 检查后重试, asks again', async () => {
    const home = fsMkdtemp();
    const keystore = createMemoryKeystore();
    const dir = fsMkdtemp();
    const scriptPath = path.join(dir, 'chat-server.cjs');
    writeFileSync(scriptPath, W4_SERVER_SCRIPT);
    const boot = async () => {
      const llm = await startMockLlm();
      const core = await createTestCore({ home, keystore, env: { KEPCUP_MOCK_LLM_URL: llm.url } });
      return {
        core,
        llm,
        async close() {
          llm.releaseAll();
          await core.close();
          await llm.stop();
        },
      };
    };
    const first = await boot();
    let taskId = '';
    let convId = '';
    try {
      await first.core.rpc.call('settings.update', {
        mcpServers: [
          {
            id: 'chat',
            name: '聊天服务',
            transport: 'stdio',
            command: process.execPath,
            args: [scriptPath],
            env: {},
            enabled: true,
            autoApprove: false,
          },
        ],
      });
      const bot = await makeBot(first.core, '小退');
      await first.core.rpc.call('bots.update', {
        id: bot.id,
        profile: { ...bot.profile, runtime: { ...bot.profile.runtime, mcp_server_ids: ['chat'] } },
      });
      const conv = await openDirect(first.core, bot.id);
      convId = conv.id;
      first.llm.script(
        'mock-main',
        viaTask({
          writes: false,
          taskSteps: [
            step().replyToolCall('mcp_chat_send_message', { to: 'ann@example.com', text: '退出' }),
            step().replyText('发了'),
          ],
        }),
      );
      await sendBatch(first.core, conv.id, ['发一条']);
      await pendingMcp(first.core, conv.id);
      taskId = (await latestTask(first.core, conv.id)).id;
      const effects = first.core.services.domain!.effects.listForRun(taskId);
      expect(effects.map((e) => e.status)).toEqual(['intended']);
    } finally {
      await first.close(); // quit while the card waits
    }

    const second = await boot();
    try {
      const { core, llm } = second;
      const effects = (await core.rpc.call('effects.list', { taskId })) as {
        effects: Array<{ status: string }>;
      };
      // Never ran: denied by recovery (not 结果未知) — and no review needed.
      expect(effects.effects.map((e) => e.status)).toEqual(['denied']);
      llm.script('mock-main', [
        step().inTask().replyToolCall('mcp_chat_send_message', { to: 'ann@example.com', text: '退出' }),
        step().inTask().replyText('这次发了'),
        step().inTurn().replyText('W4-RELAY-RESTART'),
        step().inTurn().replyText('W4-RELAY-RESTART'),
      ]);
      await core.rpc.call('runs.retry', { runId: taskId });
      const card = await waitFor(
        async () =>
          (await mcpApprovals(core, convId)).find((a) => a.status === 'pending') ?? null,
        { label: 'card after retry', timeoutMs: 30_000 },
      );
      expect(card.payload['priorEffect']).toBeUndefined();
      await core.rpc.call('approvals.decide', { id: card.id, approve: true });
      await waitFor(
        async () => {
          const latest = await latestTask(core, convId);
          return latest.id !== taskId && latest.status === 'completed' ? latest : null;
        },
        { label: 'retried task completed', timeoutMs: 30_000 },
      );
    } finally {
      await second.close();
    }
  }, 120_000);

  it('effect (复查 S1): a completed request_unsandboxed repeat shows a flagged card instead of being blocked', async () => {
    const { core, llm, conv } = await w4Stack();
    llm.script(
      'mock-main',
      viaTask({
        taskSteps: [
          step().replyToolCall('request_unsandboxed', { command: 'echo w4-repeat', reason: '同步' }),
          step().replyToolCall('request_unsandboxed', { command: 'echo w4-repeat', reason: '同步' }),
          step().replyText('跑了两次'),
        ],
        relay: 'W4-RELAY-S1',
      }),
    );
    await sendBatch(core, conv.id, ['跑两次']);
    const first = await pendingApproval(core, conv.id);
    expect(first.payload['priorEffect']).toBeUndefined();
    await core.rpc.call('approvals.decide', { id: first.id, approve: true });
    const second = await waitFor(
      async () => {
        const list = (await core.rpc.call('approvals.list', { conversationId: conv.id })) as {
          approvals: Approval[];
        };
        return list.approvals.find((a) => a.status === 'pending' && a.id !== first.id) ?? null;
      },
      { label: 'second unsandboxed card' },
    );
    expect(second.kind).toBe('unsandboxed');
    expect(second.payload['priorEffect']).toMatchObject({ status: 'completed' });
    await core.rpc.call('approvals.decide', { id: second.id, approve: true });
    await waitForRelay(core, conv.id, 'W4-RELAY-S1');
    const task = await latestTask(core, conv.id);
    const results = await toolResults(core, task.id, 'request_unsandboxed');
    expect(results.map((r) => r['ok'])).toEqual([true, true]);
  }, 120_000);
  it('effect (复查 S4): an unattended task over the wall clock on a「上次结果未知」card fails with its own reason', async () => {
    const { core, llm, conv } = await w4Stack();
    await core.rpc.call('unattended.enable', { hours: null, acknowledgeRisk: true });
    llm.script(
      'mock-main',
      viaTask({
        writes: false,
        taskSteps: [
          step().replyToolCall('mcp_chat_flaky_send', { to: 'ann@example.com', text: '超时' }),
          step().replyToolCall('mcp_chat_flaky_send', { to: 'ann@example.com', text: '超时' }),
          step().replyText('不该到这里'),
        ],
      }),
    );
    await sendBatch(core, conv.id, ['夜里发']);
    const flagged = await pendingMcp(core, conv.id);
    expect(flagged.payload['priorEffect']).toMatchObject({ status: 'uncertain' });
    const task = await latestTask(core, conv.id);
    core.services.orchestrator!.tasks.sweep(Date.now() + TASK_MAX_WALL_MS + 60_000);
    const failed = await waitFor(
      () => {
        const run = core.services.domain!.runs.get(task.id);
        return run?.status === 'failed' ? run : null;
      },
      { label: 'task failed' },
    );
    expect(failed.errorReason).toBe('uncertain_repeat_timeout');
    expect(failed.error).toContain('等待确认「上次结果未知」的重复操作超时');
    expect((await mcpApprovals(core, conv.id)).at(-1)!.status).toBe('cancelled');
  }, 120_000);
});
