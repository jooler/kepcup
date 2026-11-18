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
 * 续跑；订阅登录（auth_required）回写状态、门禁在开跑前拦下。任务由内置
 * 对话轮经 `start_task` 派出（2026-11 修订：无内置模型的确定性降级、onboarding
 * 默认 Agent 与后台 Agent loop 已随「对话与后台恒内置」移除）。
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


/**
 * D75（design 30 §8.1）：外部 Agent 只是 Bot 的任务引擎——对话轮固定内置引擎，
 * Agent 的设置 / 登录门禁与失败分类落在任务上：任务以结构化 setup 失败，失败
 * 唤醒对话轮告诉用户，设置卡的自动重试（runs.retry）对任务 = 新开一条接续它
 * 的任务（§7.5）。无内置模型的 Bot 走 §8.4 第 2 级降级（DEV-011）：对话轮不调
 * 模型，消息原样派成任务，失败发一条简短说明、结果原文转发。
 */
describe('external agent in-chat setup (P4-B, D58)', () => {
  it('not enabled fails the task with a structured agent setup; retry continues it after enabling', async () => {
    const stack = await start({ turns: [agentTurn().text('你好，我是外援。')] });
    const bot = await useAgent(stack, await makeBot(stack.core, '外援'), 'fake');
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
      step().inTurn().expect(wakeWith('（失败）')).replyText('FAIL-1 外援还没启用'),
      step().inTurn().expect(wakeWith('（结果）')).replyText('RELAY 外援说：你好，我是外援。'),
    ]);

    await sendBatch(stack.core, conv.id, ['在吗']);
    const notEnabled = await waitForRun(stack.core, conv.id, 'failed', { loopType: 'task' });
    expect(notEnabled.setup).toEqual({ kind: 'agent', agentId: 'fake', reason: 'not_enabled' });
    expect(notEnabled.error ?? '').toContain('未启用');
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
    // 门禁在开跑前拦下：Agent 进程从未被启动。
    expect(stack.record().sessions).toHaveLength(0);

    // 设置卡：启用 → 自动重试 → 原消息得到 Agent 的回复（经对话轮转发）。
    await stack.core.rpc.call('settings.update', { agents: { fake: { enabled: true } } });
    const retried = await retry(stack, notEnabled.id);
    expect(retried).toMatchObject({ loopType: 'task', continuedFromRunIds: [notEnabled.id] });
    const done = await nextSettledTask(stack, conv.id, [notEnabled.id]);
    expect(done.id).toBe(retried.id);
    expect(done.status).toBe('completed');
    expect(done.setup).toBeNull();
    expect(done.engine).toBe('agent:fake');
    expect(done.triggerMessageIds).toEqual(notEnabled.triggerMessageIds);
    expect(notEnabled.triggerMessageIds).toHaveLength(1);
    // §6.1 2026-11 修订：the report stays on the card; the turn's reply is the
    // summary, and no verbatim task-origin message appears in the chat.
    const summary = await waitForMessage(
      stack.core,
      conv.id,
      (m) => m.senderBotId === bot.id && textOf(m).includes('你好，我是外援。'),
    );
    expect((summary.content as { origin?: string }).origin).toBeUndefined();
    expect((await listMessages(stack.core, conv.id)).filter(isTaskOrigin)).toEqual([]);
    // The agent got the original message once the setup was done.
    expect(stack.record().prompts.map((p) => p.text.includes('在吗'))).toEqual([true]);
  }, 30_000);

  it('auth_required → agent setup + needs_auth on the task; the gate blocks until login, then retry completes', async () => {
    const authMethods = [{ id: 'fake-login', name: '登录 Fake', description: '订阅登录' }];
    const stack = await start({
      requireAuth: true,
      authMethods,
      turns: [agentTurn().text('登录好了，继续。')],
    });
    await stack.core.rpc.call('settings.update', { agents: { 'fake-sub': { enabled: true } } });
    const bot = await useAgent(stack, await makeBot(stack.core, '订阅外援'), 'fake-sub');
    const conv = await openDirect(stack.core, bot.id);
    const sourceIds = () =>
      stack.core.services
        .domain!.messages.listShared(conv.id, { limit: 50 })
        .filter((m) => m.senderType === 'user')
        .map((m) => m.id);
    // The built-in turn starts the task; every failure wakes a turn that tells the user.
    stack.llm.script('mock-main', [
      step()
        .inTurn()
        .expect((req) => triggerOf(req).includes('帮我看看'))
        .replyToolCall('start_task', () => ({
          title: '看看',
          instruction: 'LOOK 处理用户的消息',
          source_message_ids: sourceIds(),
          writes: false,
        })),
      step()
        .inTurn()
        .expect((req) => triggerOf(req).includes('帮我看看'))
        .replyText('ACK 我交给外援'),
      step().inTurn().expect(wakeWith('（失败）')).replyText('FAIL-1 外援还没登录'),
      step().inTurn().expect(wakeWith('（结果）')).replyText('RELAY 外援说：登录好了，继续。'),
    ]);

    await sendBatch(stack.core, conv.id, ['帮我看看']);
    const failed = await waitForRun(stack.core, conv.id, 'failed', { loopType: 'task' });
    expect(failed.setup).toEqual({ kind: 'agent', agentId: 'fake-sub', reason: 'auth_required' });
    expect(failed.error ?? '').toContain('未登录');
    // 失败回写登录态：设置卡据此展示登录入口。
    expect((await agentView(stack, 'fake-sub'))?.status).toBe('needs_auth');
    // The failure woke a turn that told the user.
    await waitForMessage(stack.core, conv.id, (m) => textOf(m).includes('FAIL-1'));

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
    // The waking turn summarizes; no verbatim task-origin message appears in the chat.
    const summary = await waitForMessage(
      stack.core,
      conv.id,
      (m) => m.senderBotId === bot.id && textOf(m).includes('登录好了，继续。'),
    );
    expect((summary.content as { origin?: string }).origin).toBeUndefined();
    expect((await listMessages(stack.core, conv.id)).filter(isTaskOrigin)).toEqual([]);
  }, 45_000);
});

describe('agent failures after visible work stay ordinary failures (review #4)', () => {
  it('auth_required before any output → setup; after interim text + a tool → plain failure (task level)', async () => {
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
    await stack.core.rpc.call('settings.update', { agents: { fake: { enabled: true } } });
    // 无需登录的条目：任务失败不回写 needs_auth，第二句照常开跑。
    const bot = await useAgent(stack, await makeBot(stack.core, '外援'), 'fake');
    const conv = await openDirect(stack.core, bot.id);
    const sourceIds = () =>
      stack.core.services
        .domain!.messages.listShared(conv.id, { limit: 50 })
        .filter((m) => m.senderType === 'user')
        .map((m) => m.id);
    const dispatch = (expectFragment: string) => [
      step()
        .inTurn()
        .expect((req) => triggerOf(req).includes(expectFragment))
        .replyToolCall('start_task', () => ({
          title: '处理',
          instruction: `DO ${expectFragment}`,
          source_message_ids: sourceIds(),
          writes: false,
        })),
      step()
        .inTurn()
        .expect((req) => triggerOf(req).includes(expectFragment))
        .replyText('ACK 我交给外援'),
    ];
    stack.llm.script('mock-main', [
      ...dispatch('第一句'),
      ...dispatch('第二句'),
      step().inTurn().expect(wakeWith('（失败）')).replyText('FAIL-1 外援中断了'),
      step().inTurn().expect(wakeWith('（失败）')).replyText('FAIL-2 外援又中断了'),
    ]);

    await sendBatch(stack.core, conv.id, ['第一句']);
    const first = await waitForRun(stack.core, conv.id, 'failed', { loopType: 'task' });
    expect(first.setup).toEqual({ kind: 'agent', agentId: 'fake', reason: 'auth_required' });

    // No task in flight any more: the next message starts a new task.
    await sendBatch(stack.core, conv.id, ['第二句']);
    const second = await nextSettledTask(stack, conv.id, [first.id]);
    expect(second.status).toBe('failed');
    expect(second.setup).toBeNull();
    // Incomplete stop keeps the last status overlay so user/Bot can see where it stopped.
    expect(second.lastProgress ?? '').toContain('我先看看文件');
  }, 30_000);
});
