import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentView, Bot, Run } from '@kepcup/shared';
import {
  agentTurn,
  createTestStack,
  fakeAcpAgentLaunch,
  fakeAgentEntry,
  listMessages,
  listRuns,
  makeBot,
  openDirect,
  readFakeAgentRecord,
  sendBatch,
  waitFor,
  waitForRun,
  writeFakeAgentScript,
  type FakeAgentScript,
  type TestStack,
} from '@kepcup/testkit';

/**
 * 外部智能体 P4 B 部分（todo/acp-external-agents.md §7.1，D72 + D58）：
 * 结构化 setup 失败 `{kind:'agent', agentId, reason}` → 完成设置 → runs.retry
 * 续跑；订阅登录（auth_required）回写状态、门禁在开跑前拦下；onboarding 的
 * 默认 Agent；无内置模型时后台 loop 优雅跳过。
 */

const stacks: TestStack[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const stack of stacks.splice(0)) await stack.cleanup();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** 需要订阅登录的假 Agent（auth.kinds 含 subscription）。 */
const SUBSCRIPTION_ENTRY = fakeAgentEntry('fake-sub', {
  name: 'Fake Subscription',
  tier: 'supported',
  auth: { kinds: ['subscription'], note: '订阅登录' },
});

async function start(script: FakeAgentScript, env: NodeJS.ProcessEnv = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'kepcup-ext-agent-p4b-'));
  dirs.push(dir);
  const scriptFile = path.join(dir, 'script.json');
  const recordFile = path.join(dir, 'record.jsonl');
  writeFakeAgentScript(scriptFile, script);
  const stack = await createTestStack({
    env,
    agentCatalog: [SUBSCRIPTION_ENTRY],
    agentLaunch: (entry) =>
      entry.id.startsWith('fake') ? fakeAcpAgentLaunch(scriptFile, recordFile) : null,
  });
  stacks.push(stack);
  return {
    ...stack,
    rewrite: (next: FakeAgentScript) => writeFakeAgentScript(scriptFile, next),
    record: () => readFakeAgentRecord(recordFile),
  };
}

async function useAgent(stack: TestStack, bot: Bot, agentId: string): Promise<Bot> {
  const profile = {
    ...bot.profile,
    runtime: { ...bot.profile.runtime, agent: { ...bot.profile.runtime.agent, id: agentId } },
  };
  return ((await stack.core.rpc.call('bots.update', { id: bot.id, profile })) as { bot: Bot }).bot;
}

async function agentView(stack: TestStack, id: string): Promise<AgentView | undefined> {
  const { agents } = (await stack.core.rpc.call('agents.list')) as { agents: AgentView[] };
  return agents.find((agent) => agent.id === id);
}

async function retry(stack: TestStack, runId: string): Promise<Run> {
  return ((await stack.core.rpc.call('runs.retry', { runId })) as { run: Run }).run;
}

/** Waits for a settled response run other than the ones already seen. */
async function nextSettledRun(stack: TestStack, conversationId: string, seen: string[]) {
  return waitFor(
    async () =>
      (await listRuns(stack.core, conversationId)).find(
        (run) =>
          run.loopType === 'response' &&
          !seen.includes(run.id) &&
          (run.status === 'failed' || run.status === 'completed'),
      ) ?? null,
    { label: 'next settled response run' },
  );
}

describe('external agent in-chat setup (P4-B, D58)', () => {
  it('experimental off / not enabled end in a structured agent setup; retry continues after setup', async () => {
    const stack = await start({ turns: [agentTurn().text('你好，我是外援。')] });
    await stack.core.rpc.call('settings.update', { experimental: { externalAgents: true } });
    const bot = await useAgent(stack, await makeBot(stack.core, '外援'), 'fake');
    await stack.core.rpc.call('settings.update', { experimental: { externalAgents: false } });
    const conv = await openDirect(stack.core, bot.id);

    await sendBatch(stack.core, conv.id, ['在吗']);
    const off = await waitForRun(stack.core, conv.id, 'failed');
    expect(off.setup).toEqual({ kind: 'agent', agentId: 'fake', reason: 'experimental_off' });
    expect(off.error ?? '').toContain('实验');

    // 设置卡第一步：打开实验开关 → 自动重试，此时 Agent 尚未启用。
    await stack.core.rpc.call('settings.update', { experimental: { externalAgents: true } });
    await retry(stack, off.id);
    const notEnabled = await nextSettledRun(stack, conv.id, [off.id]);
    expect(notEnabled.status).toBe('failed');
    expect(notEnabled.setup).toEqual({ kind: 'agent', agentId: 'fake', reason: 'not_enabled' });
    // 门禁在开跑前拦下：Agent 进程从未被启动。
    expect(stack.record().sessions).toHaveLength(0);

    // 设置卡第二步：启用 → 自动重试 → 原消息得到回复。
    await stack.core.rpc.call('settings.update', { agents: { fake: { enabled: true } } });
    await retry(stack, notEnabled.id);
    const done = await nextSettledRun(stack, conv.id, [off.id, notEnabled.id]);
    expect(done.status).toBe('completed');
    expect(done.setup).toBeNull();
    expect(done.triggerMessageIds).toEqual(off.triggerMessageIds);
    const replies = (await listMessages(stack.core, conv.id)).filter(
      (m) => m.senderBotId === bot.id,
    );
    expect(replies.map((m) => ('text' in m.content ? m.content.text : ''))).toEqual([
      '你好，我是外援。',
    ]);
  }, 30_000);

  it('auth_required → agent setup + needs_auth; the gate blocks until login, then retry completes', async () => {
    const authMethods = [{ id: 'fake-login', name: '登录 Fake', description: '订阅登录' }];
    const stack = await start({
      requireAuth: true,
      authMethods,
      turns: [agentTurn().text('登录好了，继续。')],
    });
    await stack.core.rpc.call('settings.update', {
      experimental: { externalAgents: true },
      agents: { 'fake-sub': { enabled: true } },
    });
    const bot = await useAgent(stack, await makeBot(stack.core, '订阅外援'), 'fake-sub');
    const conv = await openDirect(stack.core, bot.id);

    await sendBatch(stack.core, conv.id, ['帮我看看']);
    const failed = await waitForRun(stack.core, conv.id, 'failed');
    expect(failed.setup).toEqual({ kind: 'agent', agentId: 'fake-sub', reason: 'auth_required' });
    expect(failed.error ?? '').toContain('未登录');
    // 失败回写登录态：设置卡据此展示登录入口。
    expect((await agentView(stack, 'fake-sub'))?.status).toBe('needs_auth');

    // 未登录时重试：门禁在开跑前拦下（不再尝试建会话）。
    const rejected = () =>
      stack.record().events.filter((event) => event.kind === 'session_rejected').length;
    expect(rejected()).toBe(1);
    await retry(stack, failed.id);
    const blocked = await nextSettledRun(stack, conv.id, [failed.id]);
    expect(blocked.setup).toEqual({ kind: 'agent', agentId: 'fake-sub', reason: 'auth_required' });
    expect(rejected()).toBe(1);

    // 设置卡内登录（agent 类登录方式 → ACP authenticate）→ 状态回到 ready。
    stack.rewrite({ authMethods, turns: [agentTurn().text('登录好了，继续。')] });
    await stack.core.rpc.call('agents.login', { id: 'fake-sub', methodId: 'fake-login' });
    await waitFor(
      async () => {
        const view = await agentView(stack, 'fake-sub');
        return view?.status === 'ready' &&
          view.login?.running === false &&
          view.login.exitCode === 0
          ? true
          : null;
      },
      { label: 'fake-sub logged in' },
    );
    expect(stack.record().events.some((event) => event.kind === 'authenticate')).toBe(true);

    await retry(stack, blocked.id);
    const done = await nextSettledRun(stack, conv.id, [failed.id, blocked.id]);
    expect(done.status).toBe('completed');
    const replies = (await listMessages(stack.core, conv.id)).filter(
      (m) => m.senderBotId === bot.id,
    );
    expect(replies.map((m) => ('text' in m.content ? m.content.text : ''))).toEqual([
      '登录好了，继续。',
    ]);
  }, 45_000);
});

describe('agent failures after visible work stay ordinary failures (review #4)', () => {
  it('auth_required before any output → setup; after interim text + a tool → plain failure', async () => {
    const stack = await start({
      turns: [
        agentTurn().fail(-32000, 'Authentication required'),
        agentTurn()
          .text('我先看看文件。')
          .toolCall('t1', 'Read a.md', { name: 'Read', kind: 'read', input: { path: 'a.md' } })
          .toolResult('t1', 'ok')
          .fail(-32000, 'Authentication required'),
      ],
    });
    await stack.core.rpc.call('settings.update', {
      experimental: { externalAgents: true },
      agents: { fake: { enabled: true } },
    });
    // 无需登录的条目：run 失败不回写 needs_auth，第二句照常开跑。
    const bot = await useAgent(stack, await makeBot(stack.core, '外援'), 'fake');
    const conv = await openDirect(stack.core, bot.id);

    await sendBatch(stack.core, conv.id, ['第一句']);
    const first = await waitForRun(stack.core, conv.id, 'failed');
    expect(first.setup).toEqual({ kind: 'agent', agentId: 'fake', reason: 'auth_required' });

    await sendBatch(stack.core, conv.id, ['第二句']);
    const second = await nextSettledRun(stack, conv.id, [first.id]);
    expect(second.status).toBe('failed');
    expect(second.setup).toBeNull();
    expect(second.outputMessageIds.length).toBeGreaterThan(0);
  }, 30_000);
});

describe('onboarding default agent (P4-B)', () => {
  it('new bots and the butler default to settings.defaultAgentId while no built-in model exists', async () => {
    const stack = await start({ turns: [] }, { KEPCUP_MOCK_LLM_URL: '' });
    await expect(
      stack.core.rpc.call('settings.update', { defaultAgentId: 'not-in-catalog' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await stack.core.rpc.call('settings.update', {
      experimental: { externalAgents: true },
      agents: { 'fake-sub': { enabled: true }, fake: { enabled: true } },
      defaultAgentId: 'fake-sub',
    });

    const butler = (await stack.core.rpc.call('butler.ensure', {})) as { bot: Bot };
    expect(butler.bot.profile.runtime.agent).toMatchObject({
      id: 'fake-sub',
      permission: 'workspace',
    });
    const plain = await makeBot(stack.core, '新 Bot');
    expect(plain.profile.runtime.agent.id).toBe('fake-sub');

    // 预览档 Agent 默认 ask（与 Bot 配置界面一致）。
    await stack.core.rpc.call('settings.update', { defaultAgentId: 'fake' });
    expect((await makeBot(stack.core, '预览')).profile.runtime.agent).toMatchObject({
      id: 'fake',
      permission: 'ask',
    });

    // 已有默认主模型 → 新 Bot 照旧用内置模型。
    await stack.core.rpc.call('settings.update', { defaultMainModel: 'custom:mock/mock-main' });
    expect((await makeBot(stack.core, '内置')).profile.runtime.agent.id).toBe('');
  }, 20_000);
});

describe('background loops without a built-in model (P4-B minimal fallback)', () => {
  it('reflection / summary jobs are skipped when background agents are off: no failed run, jobs done', async () => {
    const stack = await start({ turns: [agentTurn().text('收到。')] }, { KEPCUP_MOCK_LLM_URL: '' });
    await stack.core.rpc.call('settings.update', {
      experimental: { externalAgents: true },
      agents: { fake: { enabled: true } },
      // P6：后台任务默认改走外部 Agent；关闭后回到 P4 的优雅跳过。
      backgroundTasks: { agentEnabled: false },
    });
    const bot = await useAgent(stack, await makeBot(stack.core, '外援'), 'fake');
    const conv = await openDirect(stack.core, bot.id);
    await sendBatch(stack.core, conv.id, ['记一下：我喜欢绿茶']);
    await waitForRun(stack.core, conv.id, 'completed');

    const db = stack.core.services.mainDb!;
    stack.core.services.domain!.jobs.enqueue({
      type: 'conversation_summary',
      conversationId: conv.id,
      payload: { targetSeq: 2 },
      priority: 2,
      dedupeKey: `conversation_summary:${conv.id}`,
    });
    const jobs = await waitFor(
      () => {
        const rows = db
          .prepare(
            "select type, status, last_error as lastError from jobs where type in ('reflection', 'conversation_summary')",
          )
          .all() as Array<{ type: string; status: string; lastError: string | null }>;
        return rows.length === 2 && rows.every((row) => row.status === 'done') ? rows : null;
      },
      { label: 'background jobs done' },
    );
    expect(jobs.every((row) => row.lastError === null)).toBe(true);
    const background = (await listRuns(stack.core, conv.id)).filter(
      (run) => run.loopType !== 'response',
    );
    expect(background).toEqual([]);
  }, 30_000);
});
