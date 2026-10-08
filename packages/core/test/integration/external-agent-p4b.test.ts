import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentView, Bot, Message, Run } from '@kepcup/shared';
import {
  agentTurn,
  createTestStack,
  fakeAcpAgentLaunch,
  fakeAgentEntry,
  isTaskRequest,
  listMessages,
  listRuns,
  makeBot,
  openDirect,
  readFakeAgentRecord,
  sendBatch,
  step,
  waitFor,
  waitForMessage,
  waitForRun,
  writeFakeAgentScript,
  type FakeAgentScript,
  type MockChatRequest,
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

/** Waits for a settled task other than the ones already seen. */
async function nextSettledTask(stack: TestStack, conversationId: string, seen: string[]) {
  return waitFor(
    async () =>
      (await listRuns(stack.core, conversationId)).find(
        (run) =>
          run.loopType === 'task' &&
          !seen.includes(run.id) &&
          (run.status === 'failed' || run.status === 'completed'),
      ) ?? null,
    { label: 'next settled task' },
  );
}

function textOf(message: Message): string {
  return 'text' in message.content ? message.content.text : '';
}

function isTaskOrigin(message: Message): boolean {
  return (message.content as { origin?: string }).origin === 'task';
}

/** The trigger segment of a supervisor turn's request (its last `<trigger`). */
function triggerOf(req: MockChatRequest): string {
  const text = req.lastUserText();
  const at = text.lastIndexOf('<trigger');
  return at === -1 ? '' : text.slice(at);
}

/** A turn woken by a task's terminal entry whose trigger contains `fragment`. */
const wakeWith = (fragment: string) => (req: MockChatRequest) =>
  !isTaskRequest(req) &&
  triggerOf(req).startsWith('<trigger reason="task"') &&
  triggerOf(req).includes(fragment);

/** The task id of the result entry in a waking turn's trigger. */
function resultTaskId(req: MockChatRequest): string {
  const match = /任务 (\S+)→你（结果）/.exec(triggerOf(req));
  if (match === null) throw new Error('no task result in the trigger');
  return match[1]!;
}

/**
 * D75（design 30 §8.1）：外部 Agent 只是 Bot 的任务引擎——对话轮固定内置引擎，
 * Agent 的设置 / 登录门禁与失败分类落在任务上：任务以结构化 setup 失败，失败
 * 唤醒对话轮告诉用户，设置卡的自动重试（runs.retry）对任务 = 新开一条接续它
 * 的任务（§7.5）。无内置模型的 Bot 走 §8.4 第 2 级降级（DEV-011）：对话轮不调
 * 模型，消息原样派成任务，失败发一条简短说明、结果原文转发。
 */
describe('external agent in-chat setup (P4-B, D58)', () => {
  it('experimental off / not enabled fail the task with a structured agent setup; retry continues it after setup', async () => {
    const stack = await start({ turns: [agentTurn().text('你好，我是外援。')] });
    await stack.core.rpc.call('settings.update', { experimental: { externalAgents: true } });
    const bot = await useAgent(stack, await makeBot(stack.core, '外援'), 'fake');
    await stack.core.rpc.call('settings.update', { experimental: { externalAgents: false } });
    const conv = await openDirect(stack.core, bot.id);
    const sourceIds = () =>
      stack.core.services
        .domain!.messages.listShared(conv.id, { limit: 50 })
        .filter((m) => m.senderType === 'user')
        .map((m) => m.id);
    // The built-in turn starts the task (the agent is the bot's task engine);
    // every failure wakes a turn that tells the user, the result is forwarded.
    stack.llm.script('mock-main', [
      step()
        .inTurn()
        .expect((req) => triggerOf(req).includes('在吗'))
        .replyToolCall('start_task', () => ({
          title: '回应',
          instruction: 'GREET 回应用户',
          source_message_ids: sourceIds(),
          writes: false,
        })),
      step()
        .inTurn()
        .expect((req) => triggerOf(req).includes('在吗'))
        .replyText('ACK 我问问外援'),
      step().inTurn().expect(wakeWith('（失败）')).replyText('FAIL-1 外援还没设置好'),
      step().inTurn().expect(wakeWith('（失败）')).replyText('FAIL-2 外援还没启用'),
      step()
        .inTurn()
        .expect(wakeWith('（结果）'))
        .replyToolCall('forward_task_result', (req: MockChatRequest) => ({
          task_id: resultTaskId(req),
        })),
      step().inTurn().expect(wakeWith('（结果）')).replyText('RELAY 以上是外援的回复'),
    ]);

    await sendBatch(stack.core, conv.id, ['在吗']);
    const off = await waitForRun(stack.core, conv.id, 'failed', { loopType: 'task' });
    expect(off.setup).toEqual({ kind: 'agent', agentId: 'fake', reason: 'experimental_off' });
    expect(off.error ?? '').toContain('实验');
    await waitForMessage(stack.core, conv.id, (m) => textOf(m).includes('FAIL-1'));
    // The turns themselves ran on the built-in engine and succeeded.
    const turns = await waitFor(
      async () => {
        const all = (await listRuns(stack.core, conv.id)).filter((r) => r.loopType === 'turn');
        return all.length === 2 && all.every((r) => r.status === 'completed') ? all : null;
      },
      { label: 'starting and waking turns settled' },
    );
    expect(turns.map((r) => r.engine)).toEqual(['builtin', 'builtin']);

    // 设置卡第一步：打开实验开关 → 自动重试（接续的新任务），此时 Agent 尚未启用。
    await stack.core.rpc.call('settings.update', { experimental: { externalAgents: true } });
    const retried = await retry(stack, off.id);
    expect(retried).toMatchObject({ loopType: 'task', continuedFromRunIds: [off.id] });
    const notEnabled = await nextSettledTask(stack, conv.id, [off.id]);
    expect(notEnabled.id).toBe(retried.id);
    expect(notEnabled.status).toBe('failed');
    expect(notEnabled.setup).toEqual({ kind: 'agent', agentId: 'fake', reason: 'not_enabled' });
    // 门禁在开跑前拦下：Agent 进程从未被启动。
    expect(stack.record().sessions).toHaveLength(0);

    // 设置卡第二步：启用 → 自动重试 → 原消息得到 Agent 的回复（经对话轮转发）。
    await stack.core.rpc.call('settings.update', { agents: { fake: { enabled: true } } });
    await retry(stack, notEnabled.id);
    const done = await nextSettledTask(stack, conv.id, [off.id, notEnabled.id]);
    expect(done.status).toBe('completed');
    expect(done.setup).toBeNull();
    expect(done.engine).toBe('agent:fake');
    expect(done.triggerMessageIds).toEqual(off.triggerMessageIds);
    expect(off.triggerMessageIds).toHaveLength(1);
    const forwarded = await waitForMessage(stack.core, conv.id, isTaskOrigin);
    expect(textOf(forwarded)).toBe('你好，我是外援。');
    expect(forwarded.senderBotId).toBe(bot.id);
    expect(forwarded.content).toMatchObject({ taskId: done.id });
    // The agent got the original message once the setup was done.
    expect(stack.record().prompts.map((p) => p.text.includes('在吗'))).toEqual([true]);
  }, 30_000);

  it('auth_required → agent setup + needs_auth on the task; the gate blocks until login, then retry completes (no built-in model)', async () => {
    const authMethods = [{ id: 'fake-login', name: '登录 Fake', description: '订阅登录' }];
    const stack = await start(
      { requireAuth: true, authMethods, turns: [agentTurn().text('登录好了，继续。')] },
      { KEPCUP_MOCK_LLM_URL: '' },
    );
    await stack.core.rpc.call('settings.update', {
      experimental: { externalAgents: true },
      agents: { 'fake-sub': { enabled: true } },
      backgroundTasks: { agentEnabled: false },
    });
    const bot = await useAgent(stack, await makeBot(stack.core, '订阅外援'), 'fake-sub');
    const conv = await openDirect(stack.core, bot.id);

    // §8.4 level 2: the downgraded turn hands the message to a task.
    await sendBatch(stack.core, conv.id, ['帮我看看']);
    const failed = await waitForRun(stack.core, conv.id, 'failed', { loopType: 'task' });
    expect(failed.setup).toEqual({ kind: 'agent', agentId: 'fake-sub', reason: 'auth_required' });
    expect(failed.error ?? '').toContain('未登录');
    // 失败回写登录态：设置卡据此展示登录入口。
    expect((await agentView(stack, 'fake-sub'))?.status).toBe('needs_auth');
    // The failure woke a (downgraded) turn that told the user.
    await waitForMessage(
      stack.core,
      conv.id,
      (m) => m.senderBotId === bot.id && textOf(m).includes('失败了'),
    );

    // 未登录时重试：门禁在开跑前拦下（不再尝试建会话）。
    const rejected = () =>
      stack.record().events.filter((event) => event.kind === 'session_rejected').length;
    expect(rejected()).toBe(1);
    await retry(stack, failed.id);
    const blocked = await nextSettledTask(stack, conv.id, [failed.id]);
    expect(blocked.setup).toEqual({ kind: 'agent', agentId: 'fake-sub', reason: 'auth_required' });
    expect(blocked.continuedFromRunIds).toEqual([failed.id]);
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
    const done = await nextSettledTask(stack, conv.id, [failed.id, blocked.id]);
    expect(done.status).toBe('completed');
    // The result is forwarded verbatim by the downgraded turn.
    const forwarded = await waitForMessage(stack.core, conv.id, isTaskOrigin);
    expect(textOf(forwarded)).toBe('登录好了，继续。');
    const replies = (await listMessages(stack.core, conv.id)).filter(
      (m) => m.senderBotId === bot.id && isTaskOrigin(m),
    );
    expect(replies.map(textOf)).toEqual(['登录好了，继续。']);
  }, 45_000);
});

describe('agent failures after visible work stay ordinary failures (review #4)', () => {
  it('auth_required before any output → setup; after interim text + a tool → plain failure (task level)', async () => {
    const stack = await start(
      {
        turns: [
          agentTurn().fail(-32000, 'Authentication required'),
          agentTurn()
            .text('我先看看文件。')
            .toolCall('t1', 'Read a.md', { name: 'Read', kind: 'read', input: { path: 'a.md' } })
            .toolResult('t1', 'ok')
            .fail(-32000, 'Authentication required'),
        ],
      },
      { KEPCUP_MOCK_LLM_URL: '' },
    );
    await stack.core.rpc.call('settings.update', {
      experimental: { externalAgents: true },
      agents: { fake: { enabled: true } },
      backgroundTasks: { agentEnabled: false },
    });
    // 无需登录的条目：任务失败不回写 needs_auth，第二句照常开跑。
    const bot = await useAgent(stack, await makeBot(stack.core, '外援'), 'fake');
    const conv = await openDirect(stack.core, bot.id);

    await sendBatch(stack.core, conv.id, ['第一句']);
    const first = await waitForRun(stack.core, conv.id, 'failed', { loopType: 'task' });
    expect(first.setup).toEqual({ kind: 'agent', agentId: 'fake', reason: 'auth_required' });

    // No task in flight any more: the next message starts a new task.
    await sendBatch(stack.core, conv.id, ['第二句']);
    const second = await nextSettledTask(stack, conv.id, [first.id]);
    expect(second.status).toBe('failed');
    expect(second.setup).toBeNull();
    expect(second.outputMessageIds.length).toBeGreaterThan(0);
    // The interim text reached the user as the task's progress.
    const progress = await waitForMessage(stack.core, conv.id, (m) =>
      textOf(m).includes('我先看看文件'),
    );
    expect(progress.content).toMatchObject({ origin: 'task', taskId: second.id });
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
    // §8.4 (DEV-011): the downgraded turn hands the message to a task.
    await sendBatch(stack.core, conv.id, ['记一下：我喜欢绿茶']);
    await waitForRun(stack.core, conv.id, 'completed', { loopType: 'task' });

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
      (run) => run.loopType !== 'turn' && run.loopType !== 'task',
    );
    expect(background).toEqual([]);
  }, 30_000);
});
