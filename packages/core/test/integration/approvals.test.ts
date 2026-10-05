import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { step, type TestStack } from '@kepcup/testkit';
import {
  createTestStack,
  listMessages,
  makeBot,
  openDirect,
  sendBatch,
  waitFor,
  waitForMessage,
  waitForRun,
} from '@kepcup/testkit';
import { createMemoryKeystore } from '@kepcup/core';
import type { Approval, Run } from '@kepcup/shared';
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

async function stepsOf(core: TestStack, runId: string) {
  const result = (await core.rpc.call('runs.steps', { runId })) as {
    steps: Array<{ type: string; payload: Record<string, unknown> }>;
  };
  return result.steps;
}

describe('access approvals for file tools (P03)', () => {
  it('runs an access approval for an out-of-workspace read; once-grants expire with the run', async () => {
    const { core, llm } = await start();
    const bot = await makeBot(core, '小授');
    const conv = await openDirect(core, bot.id);
    const dir = fsMkdtemp();
    writeFileSync(path.join(dir, 'secret.txt'), 'outside-content');

    // Run 1: read triggers the approval; approving 仅这一次 lets it through,
    // and the grant stays valid until the RUN ends (repeated reads in the
    // same run succeed without a second approval).
    llm.script('mock-main', [
      step().replyToolCall('read', { path: `${dir}/secret.txt` }),
      step().replyToolCall('read', { path: `${dir}/secret.txt` }),
      step().replyText('读完两次'),
    ]);
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
    await waitForRun(core, conv.id, 'completed', { timeoutMs: 60_000 });

    // Exactly one card for run 1: the once-grant covered both reads.
    const messages1 = await listMessages(core, conv.id);
    expect(messages1.filter((m) => m.kind === 'card').length).toBe(1);

    // Run 2: the once-grant died with run 1 -> a new approval appears.
    llm.script('mock-main', [
      step().replyToolCall('read', { path: `${dir}/secret.txt` }),
      step().replyText('第二次需要重新申请'),
    ]);
    await sendBatch(core, conv.id, ['再读一次']);
    const second = await pendingApproval(core, conv.id);
    expect(second.id).not.toBe(approval.id);
    await core.rpc.call('approvals.decide', { id: second.id, approve: false });
    await waitForRun(core, conv.id, 'completed', { timeoutMs: 60_000 });
    const runs2 = (await core.rpc.call('runs.list', { conversationId: conv.id, limit: 5 })) as {
      runs: Run[];
    };
    const steps = await stepsOf(core, runs2.runs.find((r) => r.loopType === 'response')!.id);
    const denied = steps.filter((s) => s.type === 'tool_result' && s.payload['ok'] === false);
    expect(denied.length).toBe(1);
    expect(String(denied[0]!.payload['content'])).toContain('APPROVAL_DENIED');
  }, 120_000);

  it('keeps conversation grants until revoked, scoped to bot + conversation', async () => {
    const { core, llm } = await start();
    const bot = await makeBot(core, '小持');
    const otherBot = await makeBot(core, '小他');
    const conv = await openDirect(core, bot.id);
    const otherConv = await openDirect(core, otherBot.id);
    const dir = fsMkdtemp();
    writeFileSync(path.join(dir, 'note.txt'), 'grant-me');

    llm.script('mock-main', [
      step().replyToolCall('request_access', { path: dir, access: 'read', reason: '批量读取前申请' }),
      step().replyText('申请好了'),
    ]);
    await sendBatch(core, conv.id, ['申请访问']);
    const approval = await pendingApproval(core, conv.id);
    expect(approval.kind).toBe('access');
    await core.rpc.call('approvals.decide', { id: approval.id, approve: true, duration: 'conversation' });
    await waitForRun(core, conv.id, 'completed', { timeoutMs: 60_000 });

    // The grant is listed and scoped to bot + conversation. The stored path is
    // the canonical (realpath) form, so compare through canonicalPath.
    const { canonicalPath } = await import('../../src/infra/paths.js');
    const grants = (await core.rpc.call('grants.list', { conversationId: conv.id })) as {
      grants: Array<{ id: string; botId: string; path: string }>;
    };
    expect(grants.grants.length).toBe(1);
    expect(grants.grants[0]!.botId).toBe(bot.id);
    expect(grants.grants[0]!.path).toBe(canonicalPath(dir));

    // A later run of the SAME bot reads the file without a new approval.
    llm.script('mock-main', [
      step().replyToolCall('read', { path: `${dir}/note.txt` }),
      step().replyText('读到了'),
    ]);
    await core.rpc.call('drafts.add', { conversationId: conv.id, text: '再读一次' });
    const second = (await core.rpc.call('drafts.flush', { conversationId: conv.id })) as {
      runId: string | null;
    };
    await waitFor(
      async () => {
        const runs = (await core.rpc.call('runs.list', { conversationId: conv.id, limit: 5 })) as {
          runs: Run[];
        };
        const run = runs.runs.find((r) => r.id === second.runId);
        return run && run.status === 'completed' ? run : null;
      },
      { label: 'grant-covered run completes', timeoutMs: 60_000 },
    );
    const approvalsAfter = (await core.rpc.call('approvals.list', { conversationId: conv.id })) as {
      approvals: Approval[];
    };
    expect(approvalsAfter.approvals.filter((a) => a.status === 'pending').length).toBe(0);

    // Another bot in its own conversation is NOT covered by the grant
    // (grants belong to bot + conversation): a fresh approval appears there.
    llm.script('mock-main', [
      step().replyToolCall('read', { path: `${dir}/note.txt` }),
      step().replyText('另一个对话读不到'),
    ]);
    await sendBatch(core, otherConv.id, ['读外部文件']);
    const otherApproval = await pendingApproval(core, otherConv.id);
    expect(otherApproval).toBeDefined();
    await core.rpc.call('approvals.decide', { id: otherApproval.id, approve: false });
    await waitForRun(core, otherConv.id, 'completed', { timeoutMs: 60_000 });

    // Revoke -> immediate effect: the next run needs a new approval.
    await core.rpc.call('grants.revoke', { id: grants.grants[0]!.id });
    llm.script('mock-main', [
      step().replyToolCall('read', { path: `${dir}/note.txt` }),
      step().replyText('撤销后读不到了'),
    ]);
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
    llm.script('mock-main', [
      step().replyToolCall('read', { path: dir }),
      step().replyText('不该到达'),
    ]);
    await sendBatch(core, conv.id, ['读外部']);
    const approval = await pendingApproval(core, conv.id);
    const runs = (await core.rpc.call('runs.list', { conversationId: conv.id, limit: 5 })) as {
      runs: Run[];
    };
    const runId = runs.runs.find((r) => r.loopType === 'response')!.id;

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
    const cancelledRun = await waitForRun(core, conv.id, 'cancelled', { timeoutMs: 30_000 });
    expect(cancelledRun.id).toBe(runId);

    // Restart on the same home: pending approvals never survive.
    const bot2 = await makeBot(core, '小启');
    const conv2 = await openDirect(core, bot2.id);
    const dir2 = fsMkdtemp();
    llm.script('mock-main', [step().replyToolCall('read', { path: dir2 }), step().replyText('x')]);
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
      expect(runs2.runs.find((r) => r.loopType === 'response')!.status).toBe('interrupted');
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
    const steps = await stepsOf(core, runsDb.find((r) => r.loopType === 'response')!.id);
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
    llm.script('mock-main', [
      step().replyToolCall('bash', { command: `cat "${dataHome}/main.db" | wc -c` }),
      step().replyText('拿不到'),
    ]);
    await sendBatch(core, conv.id, ['统计数据库大小']);
    await waitForRun(core, conv.id, 'completed', { timeoutMs: 60_000 });

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
    llm.script('mock-main', [
      step().replyToolCall('request_access', { path: outside, access: 'read', reason: 'r' }),
      step().replyToolCall('request_unsandboxed', { command: 'echo unattended-ok', reason: '需要沙箱外' }),
      step().replyToolCall('bash', { command: 'echo confirm-ok' }),
      step().replyText('都批准了'),
    ]);
    await sendBatch(core, conv.id, ['无人值守跑一轮']);
    const run = await waitForRun(core, conv.id, 'completed', { timeoutMs: 120_000 });

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

  it('returns approval cards in conversation context lines (system render)', async () => {
    const { core, llm } = await start();
    const bot = await makeBot(core, '小卡');
    const conv = await openDirect(core, bot.id);
    const dir = fsMkdtemp();
    llm.script('mock-main', [
      step().replyToolCall('request_access', { path: dir, access: 'write', reason: '要写文件' }),
      step().replyText('请求已发'),
    ]);
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

    llm.script('mock-main', [
      step().replyToolCall('bash', { command: 'touch confirm-marker' }),
      step().replyText('执行过了'),
    ]);
    await sendBatch(core, conv.id, ['建个文件']);
    const approval = await pendingApproval(core, conv.id);
    expect(approval.kind).toBe('command');
    expect(String(approval.payload['command'])).toBe('touch confirm-marker');

    await core.rpc.call('approvals.decide', { id: approval.id, approve: true });
    await waitForRun(core, conv.id, 'completed', { timeoutMs: 60_000 });
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
    llm.script('mock-main', [
      step().replyToolCall('bash', { command: 'cat in.txt' }),
      step().replyText('读到了'),
    ]);
    await sendBatch(core, conv.id, ['看下文件']);
    await waitForRun(core, conv.id, 'completed', { timeoutMs: 60_000 });
    const approvals1 = (await core.rpc.call('approvals.list', { conversationId: conv.id })) as {
      approvals: Approval[];
    };
    expect(approvals1.approvals.length).toBe(0);

    // Allowlisted command but path outside scope -> needs approval.
    const outsideDir = fsMkdtemp();
    llm.script('mock-main', [
      step().replyToolCall('bash', { command: `cat ${outsideDir}/out.txt` }),
      step().replyText('需要确认'),
    ]);
    await sendBatch(core, conv.id, ['读外面的']);
    const approval = await pendingApproval(core, conv.id);
    expect(approval.kind).toBe('command');
    await core.rpc.call('approvals.decide', { id: approval.id, approve: false });
    await waitForRun(core, conv.id, 'completed', { timeoutMs: 60_000 });
  }, 120_000);
});

describe('unsandboxed execution (P03)', () => {
  it('shows the full command in the card and runs it outside the sandbox after approval', async () => {
    const { core, llm } = await start();
    const bot = await makeBot(core, '小沙');
    const conv = await openDirect(core, bot.id);

    llm.script('mock-main', [
      step().replyToolCall('request_unsandboxed', { command: 'echo direct-$(date +%s)', reason: 'Docker 需要' }),
      step().replyText('沙箱外执行完成'),
    ]);
    await sendBatch(core, conv.id, ['帮我在沙箱外跑一条命令']);
    const approval = await pendingApproval(core, conv.id);
    expect(approval.kind).toBe('unsandboxed');
    expect(String(approval.payload['command'])).toContain('echo direct-');

    await core.rpc.call('approvals.decide', { id: approval.id, approve: true });
    await waitForRun(core, conv.id, 'completed', { timeoutMs: 60_000 });

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
