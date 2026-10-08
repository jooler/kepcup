import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryKeystore } from '@kepcup/core';
import type { Embedder } from '../../src/memory/embedder.js';
import type { Bot, Message, Run, TaskEventContent, UsageSummaryEntry } from '@kepcup/shared';
import {
  agentTurn,
  createTestStack,
  fakeAgentEntry,
  fakeAgentSpawner,
  isTaskRequest,
  makeBot,
  makeGroup,
  openDirect,
  sendBatch,
  sendDrafts,
  step,
  waitFor,
  waitForMessage,
  type FakeAcpAgentHandle,
  type FakeAgentScript,
  type MockChatRequest,
  type MockLlmStep,
  type TestStack,
} from '@kepcup/testkit';

/**
 * P5 第二部分经 orchestrator 的端到端（todo §8.1 / §8.2「30 分钟内连续两问
 * 复用会话」），按 D75 改写（design 30 §8.1 / §8.5）：对话轮固定内置引擎
 * （模拟模型脚本），外部 Agent 只跑任务，会话按任务分行；会话复用只发生在
 * `continues_task_id` 接续上一条任务时（继承它的会话行）。用例覆盖：接续任务
 * 复用会话只发增量对话段、不重发会话级提示词；增量 = 来源任务的会话之后的
 * 共享行（不含任务私有条目）；用量页单列外部 Agent；删除对话 → session/delete
 * + 删行；被拒的注入记为未送达、由被唤醒的对话轮接续；重启后不猜增量；崩溃
 * 后保留会话行、接续任务 resume；群成员移除与会话建立 / 恢复的竞态。
 */

const stacks: TestStack[] = [];
afterEach(async () => {
  for (const stack of stacks.splice(0)) await stack.cleanup();
});

const CLAUDE_MODES = {
  currentModeId: 'default',
  availableModes: [
    { id: 'default', name: 'Default' },
    { id: 'acceptEdits', name: 'Accept Edits' },
  ],
};

async function start(
  scripts: Record<string, FakeAgentScript | FakeAgentScript[]>,
  extra: ReturnType<typeof fakeAgentEntry>[] = [],
  more: Parameters<typeof createTestStack>[0] = {},
) {
  const started: FakeAcpAgentHandle[] = [];
  const stack = await createTestStack({
    ...more,
    ...(extra.length > 0 ? { agentCatalog: extra } : {}),
    agentLaunch: () => ({ command: 'in-process', args: [], env: {} }),
    agentSpawn: fakeAgentSpawner(scripts, started) as never,
  });
  stacks.push(stack);
  await stack.core.rpc.call('settings.update', {
    experimental: { externalAgents: true },
    agents: Object.fromEntries(Object.keys(scripts).map((id) => [id, { enabled: true }])),
    // The agent's rounds serve the tasks only (no background agent sessions).
    backgroundTasks: { agentEnabled: false },
  });
  return { stack, started };
}

async function agentBot(stack: TestStack, agentId: string): Promise<Bot> {
  const bot = await makeBot(stack.core, '外援');
  const profile = {
    ...bot.profile,
    runtime: { ...bot.profile.runtime, agent: { ...bot.profile.runtime.agent, id: agentId } },
  };
  return ((await stack.core.rpc.call('bots.update', { id: bot.id, profile })) as { bot: Bot }).bot;
}

function domain(stack: TestStack) {
  return stack.core.services.domain!;
}

function textOf(message: Message): string {
  return 'text' in message.content ? message.content.text : '';
}

/** The conversation's tasks, oldest first. */
function tasksIn(stack: TestStack, conversationId: string): Run[] {
  return domain(stack).runs.listTasks({ conversationId });
}

function taskAt(stack: TestStack, conversationId: string, index: number): string {
  const task = tasksIn(stack, conversationId)[index];
  if (task === undefined) throw new Error(`no task #${index}`);
  return task.id;
}

function waitTask(
  stack: TestStack,
  conversationId: string,
  index: number,
  statuses: Run['status'][],
): Promise<Run> {
  return waitFor(
    () => {
      const task = tasksIn(stack, conversationId)[index];
      return task !== undefined && statuses.includes(task.status) ? task : null;
    },
    { label: `task #${index} ${statuses.join('/')}`, timeoutMs: 20_000 },
  );
}

/** The task's engine run is released (a continuation may inherit its session, §8.5). */
function waitIdle(stack: TestStack, taskId: string) {
  return waitFor(
    () => (stack.core.services.orchestrator!.tasks.isExecuting(taskId) ? null : true),
    { label: `task ${taskId} execution released` },
  );
}

function waitVisible(stack: TestStack, conversationId: string, fragment: string) {
  return waitForMessage(stack.core, conversationId, (m) => textOf(m).includes(fragment), {
    timeoutMs: 20_000,
  });
}

/** The trigger segment of a supervisor turn's request (its last `<trigger`). */
function triggerOf(req: MockChatRequest): string {
  const text = req.lastUserText();
  const at = text.lastIndexOf('<trigger');
  return at === -1 ? '' : text.slice(at);
}

const isWake = (req: MockChatRequest): boolean =>
  !isTaskRequest(req) && triggerOf(req).startsWith('<trigger reason="task"');

/** A turn triggered by user messages containing `fragment`. */
const userTurn =
  (fragment: string) =>
  (req: MockChatRequest): boolean =>
    !isTaskRequest(req) && !isWake(req) && triggerOf(req).includes(fragment);

function userMessageId(stack: TestStack, conversationId: string, fragment: string): string {
  const message = domain(stack)
    .messages.listShared(conversationId, { limit: 100 })
    .find((m) => m.senderType === 'user' && textOf(m).includes(fragment));
  if (message === undefined) throw new Error(`no user message with ${fragment}`);
  return message.id;
}

/**
 * The turn for the user message containing `fragment` starts a read-only task
 * on it (optionally continuing an earlier task), then acknowledges.
 */
function dispatch(
  stack: TestStack,
  conversationId: () => string,
  fragment: string,
  input: { instruction: string; continues?: () => string; onStart?: () => void },
): MockLlmStep[] {
  return [
    step()
      .inTurn()
      .expect(userTurn(fragment))
      .replyToolCall('start_task', () => {
        input.onStart?.();
        return {
          title: fragment,
          instruction: input.instruction,
          source_message_ids: [userMessageId(stack, conversationId(), fragment)],
          writes: false,
          ...(input.continues !== undefined ? { continues_task_id: input.continues() } : {}),
        };
      }),
    step().inTurn().expect(userTurn(fragment)).replyText('ACK 好的，我去办'),
  ];
}

/** A turn woken by a task's terminal entry relays it in its own words. */
function relay(text: string): MockLlmStep {
  return step().inTurn().expect(isWake).replyText(text);
}

function sessionRows(stack: TestStack, conversationId: string) {
  return stack.core.services
    .mainDb!.prepare(
      'select id, task_id, agent_session_id from agent_sessions where conversation_id = ?',
    )
    .all(conversationId) as Array<{ id: string; task_id: string; agent_session_id: string }>;
}

describe('external agent session reuse through task continuation (P5, D75 §8.5)', () => {
  it('a continuation task reuses the source session with the delta only; usage lists the agent; deletion deletes it', async () => {
    const { stack, started } = await start({
      fake: {
        sessionDelete: true,
        turns: [
          agentTurn().text('第一答').usage({ inputTokens: 50, outputTokens: 5, totalTokens: 55 }),
          agentTurn().text('第二答'),
        ],
      },
    });
    const bot = await agentBot(stack, 'fake');
    const conv = await openDirect(stack.core, bot.id);
    const convId = () => conv.id;
    stack.llm.script('mock-main', [
      ...dispatch(stack, convId, '第一问', { instruction: 'TASK-ONE 回答用户的问题' }),
      relay('RELAY-ONE 外援答好了'),
      ...dispatch(stack, convId, '第二问', {
        instruction: 'TASK-TWO 接着回答用户的追问',
        continues: () => taskAt(stack, conv.id, 0),
      }),
      relay('RELAY-TWO 外援又答好了'),
    ]);

    await sendBatch(stack.core, conv.id, ['第一问：天空为什么是蓝的']);
    const first = await waitTask(stack, conv.id, 0, ['completed']);
    await waitVisible(stack, conv.id, 'RELAY-ONE');
    await waitIdle(stack, first.id);
    await sendBatch(stack.core, conv.id, ['第二问：那晚霞呢']);
    const second = await waitTask(stack, conv.id, 1, ['completed']);
    await waitVisible(stack, conv.id, 'RELAY-TWO');

    expect(second.continuedFromRunIds).toEqual([first.id]);
    expect([first.agentSessionId, second.agentSessionId]).toEqual([
      'fake-session-1',
      'fake-session-1',
    ]);
    const observed = started[0]!.observed;
    expect(observed.sessions).toHaveLength(1);
    const [p1, p2] = observed.prompts;
    expect(p1!.text).toContain('<platform_rules');
    expect(p1!.text).toContain('第一问');
    // Reused: no session prompt, no replay of what the session already saw;
    // its own result is a private entry (never in the shared delta), the
    // turn's relay since then is.
    expect(p2!.text).not.toContain('<platform_rules');
    expect(p2!.text).not.toContain('第一问');
    expect(p2!.text).not.toContain('第一答');
    expect(p2!.text).toContain('RELAY-ONE');
    expect(p2!.text).toContain('第二问');
    expect(p2!.text).toContain('TASK-TWO');

    const steps = (await stack.core.rpc.call('runs.steps', { runId: second.id })) as {
      steps: Array<{ type: string; payload: { session?: string } }>;
    };
    expect(steps.steps.find((s) => s.type === 'request')!.payload.session).toBe('reused');
    // One row, moved to the continuation.
    expect(sessionRows(stack, conv.id).map((row) => row.task_id)).toEqual([second.id]);

    // Usage: external agents listed apart (the two tasks; tokens when reported).
    const summary = (await stack.core.rpc.call('usage.summary', { days: 1 })) as {
      entries: UsageSummaryEntry[];
    };
    const agentRows = summary.entries.filter((entry) => entry.agentId === 'fake');
    expect(agentRows).toHaveLength(1);
    expect(agentRows[0]).toMatchObject({
      turns: 2,
      inputTokens: 50,
      outputTokens: 5,
      costUsd: null,
    });

    await stack.core.rpc.call('conversations.delete', { id: conv.id });
    await waitFor(() => (observed.deletedSessions.length === 1 ? true : null), {
      label: 'session/delete',
    });
    expect(observed.deletedSessions).toEqual(['fake-session-1']);
  }, 40_000);

  it('the conversation since the source session (others included) reaches the continuation as a delta', async () => {
    const { stack, started } = await start({
      fake: { turns: [agentTurn().text('收到'), agentTurn().text('再收到')] },
    });
    const bot = await agentBot(stack, 'fake');
    const conv = await openDirect(stack.core, bot.id);
    const convId = () => conv.id;
    stack.llm.script('mock-main', [
      ...dispatch(stack, convId, 'ALPHA', { instruction: 'TASK-ALPHA 处理' }),
      relay('RELAY-ALPHA 处理好了'),
      // Answered by the turn itself: no task, no agent round.
      step().inTurn().expect(userTurn('GAMMA')).replyText('DIRECT-GAMMA 直接回答'),
      ...dispatch(stack, convId, 'BETA', {
        instruction: 'TASK-BETA 接着处理',
        continues: () => taskAt(stack, conv.id, 0),
      }),
      relay('RELAY-BETA 也处理好了'),
    ]);

    await sendBatch(stack.core, conv.id, ['ALPHA 甲']);
    const first = await waitTask(stack, conv.id, 0, ['completed']);
    await waitVisible(stack, conv.id, 'RELAY-ALPHA');
    await waitIdle(stack, first.id);
    await sendBatch(stack.core, conv.id, ['GAMMA 丙']);
    await waitVisible(stack, conv.id, 'DIRECT-GAMMA');
    // Another participant's line too (a system note lands in the shared timeline).
    domain(stack).messages.append({
      conversationId: conv.id,
      senderType: 'system',
      kind: 'system_event',
      event: 'test_note',
      text: 'NOTE-OTHERS 旁路通知',
    });
    await sendBatch(stack.core, conv.id, ['BETA 乙']);
    await waitTask(stack, conv.id, 1, ['completed']);
    await waitVisible(stack, conv.id, 'RELAY-BETA');

    const prompts = started[0]!.observed.prompts;
    expect(prompts).toHaveLength(2);
    expect(started[0]!.observed.sessions).toHaveLength(1);
    const delta = prompts[1]!.text;
    expect(delta).toContain('BETA 乙');
    expect(delta).not.toContain('ALPHA 甲');
    for (const since of ['RELAY-ALPHA', 'GAMMA 丙', 'DIRECT-GAMMA', 'NOTE-OTHERS']) {
      expect(delta).toContain(since);
    }
  }, 40_000);

  it('an inject the agent refuses is recorded as not delivered; the woken turn continues the task with it', async () => {
    const entry = fakeAgentEntry('fake-steer', { provider: 'claude' });
    const { stack, started } = await start(
      {
        'fake-steer': {
          steering: true,
          steeringOutcome: 'promptRequired',
          modes: CLAUDE_MODES,
          turns: [agentTurn().sleep(600).text('先答第一条'), agentTurn().text('再答第二条')],
        },
      },
      [entry],
    );
    const bot = await agentBot(stack, 'fake-steer');
    const conv = await openDirect(stack.core, bot.id);
    const convId = () => conv.id;
    stack.llm.script('mock-main', [
      ...dispatch(stack, convId, '第一条', { instruction: 'TASK-FIRST 处理第一条' }),
      step()
        .inTurn()
        .expect(userTurn('第二条'))
        .replyToolCall('inject_task', () => ({
          task_id: taskAt(stack, conv.id, 0),
          text: 'INJECT 用户又补充了第二条',
          source_message_ids: [userMessageId(stack, conv.id, '第二条')],
        })),
      step().inTurn().expect(userTurn('第二条')).replyText('ACK 已转告'),
      // Woken by the first result: its context shows the inject did not land.
      step()
        .inTurn()
        .expect((req) => isWake(req) && req.lastUserText().includes('未送达'))
        .replyToolCall('start_task', () => ({
          title: '第二条',
          instruction: 'TASK-SECOND 处理没送达的补充',
          source_message_ids: [userMessageId(stack, conv.id, '第二条')],
          writes: false,
          continues_task_id: taskAt(stack, conv.id, 0),
        })),
      step().inTurn().expect(isWake).replyText('RELAY-FIRST 先答了第一条，第二条接着做'),
      relay('RELAY-SECOND 第二条也答了'),
    ]);

    await sendBatch(stack.core, conv.id, ['第一条']);
    await waitFor(() => (started[0]?.observed.prompts.length === 1 ? true : null), {
      label: 'first prompt',
    });
    await sendBatch(stack.core, conv.id, ['第二条']);
    await waitFor(() => (started[0]!.observed.steerings.length === 1 ? true : null), {
      label: 'steering attempted',
    });
    const first = await waitTask(stack, conv.id, 0, ['completed']);
    const inject = domain(stack)
      .messages.taskEvents(first.id)
      .map((m) => m.content as TaskEventContent)
      .find((content) => content.phase === 'inject');
    expect(inject).toMatchObject({ delivery: 'queued' });

    const second = await waitTask(stack, conv.id, 1, ['completed']);
    expect(second.continuedFromRunIds).toEqual([first.id]);
    expect(started[0]!.observed.prompts).toHaveLength(2);
    expect(started[0]!.observed.prompts[1]!.text).toContain('第二条');
    await waitVisible(stack, conv.id, 'RELAY-SECOND');
    // Nothing was re-delivered behind the bot's back: two tasks, both dispatched by turns.
    expect(tasksIn(stack, conv.id)).toHaveLength(2);
  }, 40_000);
});

function systemNote(stack: TestStack, conversationId: string, text: string) {
  return domain(stack).messages.append({
    conversationId,
    senderType: 'system',
    kind: 'system_event',
    event: 'test_note',
    text,
  });
}

describe('continuation delta (P5-2 review #2, #3, #5, #12; D75 tasks)', () => {
  it('a message shown neither by the task context nor its inject still reaches the next delta', async () => {
    const entry = fakeAgentEntry('fake-steer', { provider: 'claude' });
    const { stack, started } = await start(
      {
        'fake-steer': {
          steering: true,
          modes: CLAUDE_MODES,
          turns: [agentTurn().sleep(500).echoSteers().text(' 完'), agentTurn().text('第二答')],
        },
      },
      [entry],
    );
    const bot = await agentBot(stack, 'fake-steer');
    const conv = await openDirect(stack.core, bot.id);
    const convId = () => conv.id;
    stack.llm.script('mock-main', [
      ...dispatch(stack, convId, '第一问', { instruction: 'TASK-ONE 回答' }),
      step()
        .inTurn()
        .expect(userTurn('补充一句'))
        .replyToolCall('inject_task', () => ({
          task_id: taskAt(stack, conv.id, 0),
          text: 'INJECT 用户补充了一句',
          source_message_ids: [userMessageId(stack, conv.id, '补充一句')],
        })),
      step().inTurn().expect(userTurn('补充一句')).replyText('ACK 已转告'),
      relay('RELAY-ONE 答好了'),
      ...dispatch(stack, convId, '第三问', {
        instruction: 'TASK-THREE 接着回答',
        continues: () => taskAt(stack, conv.id, 0),
      }),
      relay('RELAY-THREE 又答好了'),
    ]);

    await sendBatch(stack.core, conv.id, ['第一问']);
    await waitFor(() => (started[0]?.observed.prompts.length === 1 ? true : null), {
      label: 'first prompt',
    });
    // Not shown to the agent: lands after the task's context, outside the inject.
    systemNote(stack, conv.id, '旁路系统通知');
    await sendBatch(stack.core, conv.id, ['补充一句']);
    await waitFor(() => (started[0]!.observed.steerings.length === 1 ? true : null), {
      label: 'steered',
    });
    const first = await waitTask(stack, conv.id, 0, ['completed']);
    await waitVisible(stack, conv.id, 'RELAY-ONE');
    await waitIdle(stack, first.id);
    await sendBatch(stack.core, conv.id, ['第三问']);
    await waitTask(stack, conv.id, 1, ['completed']);
    const [p1, p2] = started[0]!.observed.prompts;
    expect(p2!.sessionId).toBe(p1!.sessionId);
    const second = p2!.text;
    expect(second).toContain('旁路系统通知');
    expect(second).not.toContain('补充一句');
    expect(second).not.toContain('第一问');
    expect(second).toContain('第三问');
  }, 40_000);

  it('messages newer than the task context stay out of its delta and come with the next continuation', async () => {
    let gate: (() => void) | null = null;
    let holdNext = false;
    const embedder: Embedder = {
      id: 'fake:8',
      dim: 8,
      ready: () => true,
      embed: async (texts: string[]) => {
        if (holdNext) {
          holdNext = false;
          await new Promise<void>((resolve) => {
            gate = resolve;
          });
        }
        return texts.map((text) => {
          const vector = new Float32Array(8);
          for (let i = 0; i < text.length; i++) vector[(text.charCodeAt(i) + i) % 8] += 1;
          return vector;
        });
      },
    };
    const { stack, started } = await start(
      { fake: { turns: [agentTurn().text('一'), agentTurn().text('二'), agentTurn().text('三')] } },
      [],
      { memoryEmbedder: embedder, env: { KEPCUP_PROFILE_CURATION_DELAY_MS: '60000' } },
    );
    const bot = await agentBot(stack, 'fake');
    await stack.core.services.memory!.writeMemory(bot.id, null, {
      content: '用户喜欢简短回答',
      kind: 'self_note',
      triggerMessages: [],
    });
    const conv = await openDirect(stack.core, bot.id);
    const convId = () => conv.id;
    stack.llm.script('mock-main', [
      ...dispatch(stack, convId, '第一问', { instruction: 'TASK-ONE 回答' }),
      relay('RELAY-ONE'),
      ...dispatch(stack, convId, '第二问', {
        instruction: 'TASK-TWO 回答',
        continues: () => taskAt(stack, conv.id, 0),
        // The turn's own preparation is done: the next recall is the task's.
        onStart: () => {
          holdNext = true;
        },
      }),
      relay('RELAY-TWO'),
      ...dispatch(stack, convId, '第三问', {
        instruction: 'TASK-THREE 回答',
        continues: () => taskAt(stack, conv.id, 1),
      }),
      relay('RELAY-THREE'),
    ]);

    await sendBatch(stack.core, conv.id, ['第一问']);
    const first = await waitTask(stack, conv.id, 0, ['completed']);
    await waitVisible(stack, conv.id, 'RELAY-ONE');
    await waitIdle(stack, first.id);
    await sendBatch(stack.core, conv.id, ['第二问']);
    await waitFor(() => (gate !== null ? true : null), { label: 'task preparation held' });
    systemNote(stack, conv.id, '准备期间的通知');
    gate!();
    const second = await waitTask(stack, conv.id, 1, ['completed']);
    await waitVisible(stack, conv.id, 'RELAY-TWO');
    expect(started[0]!.observed.prompts[1]!.text).toContain('第二问');
    expect(started[0]!.observed.prompts[1]!.text).not.toContain('准备期间的通知');
    await waitIdle(stack, second.id);
    await sendBatch(stack.core, conv.id, ['第三问']);
    await waitTask(stack, conv.id, 2, ['completed']);
    expect(started[0]!.observed.prompts[2]!.text).toContain('准备期间的通知');
    expect(started[0]!.observed.sessions).toHaveLength(1);
  }, 40_000);

  it('after an app restart a continuation does not reuse the session (no guessed delta)', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'kepcup-p5-restart-'));
    const keystore = createMemoryKeystore();
    try {
      const first = await start({ fake: { turns: [agentTurn().text('一')] } }, [], {
        home,
        keystore,
      });
      const bot = await agentBot(first.stack, 'fake');
      const conv = await openDirect(first.stack.core, bot.id);
      const convId = () => conv.id;
      first.stack.llm.script('mock-main', [
        ...dispatch(first.stack, convId, '重启前', { instruction: 'TASK-BEFORE 回答' }),
        relay('RELAY-BEFORE'),
      ]);
      await sendBatch(first.stack.core, conv.id, ['重启前']);
      const before = await waitTask(first.stack, conv.id, 0, ['completed']);
      await waitVisible(first.stack, conv.id, 'RELAY-BEFORE');
      await waitFor(
        () =>
          domain(first.stack).runs.getOrThrow(before.id).resultConsumedAt !== null ? true : null,
        { label: 'result consumed' },
      );
      await first.stack.cleanup();
      stacks.splice(stacks.indexOf(first.stack), 1);

      const second = await start({ fake: { turns: [agentTurn().text('二')] } }, [], {
        home,
        keystore,
      });
      second.stack.llm.script('mock-main', [
        ...dispatch(second.stack, convId, '重启后', {
          instruction: 'TASK-AFTER 接着回答',
          continues: () => before.id,
        }),
        relay('RELAY-AFTER'),
      ]);
      await sendBatch(second.stack.core, conv.id, ['重启后']);
      const after = await waitTask(second.stack, conv.id, 1, ['completed']);
      expect(after.continuedFromRunIds).toEqual([before.id]);
      const prompt = second.started[0]!.observed.prompts[0]!.text;
      // A new session with the full context.
      expect(second.started[0]!.observed.sessions).toHaveLength(1);
      expect(prompt).toContain('<platform_rules');
      expect(prompt).toContain('重启前');
      expect(prompt).toContain('重启后');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 50_000);

  it('deleting the bot while an inject waits for the agent: the task stops, nothing is re-delivered (#12)', async () => {
    const entry = fakeAgentEntry('fake-steer', { provider: 'claude' });
    const { stack, started } = await start(
      {
        'fake-steer': {
          steering: true,
          steeringOutcome: 'promptRequired',
          steeringDelayMs: 300,
          modes: CLAUDE_MODES,
          turns: [agentTurn().waitCancel(), agentTurn().text('不该运行')],
        },
      },
      [entry],
    );
    const bot = await agentBot(stack, 'fake-steer');
    const conv = await openDirect(stack.core, bot.id);
    const convId = () => conv.id;
    stack.llm.script('mock-main', [
      ...dispatch(stack, convId, '第一条', { instruction: 'TASK-FIRST 一直做' }),
      step()
        .inTurn()
        .expect(userTurn('第二条'))
        .replyToolCall('inject_task', () => ({
          task_id: taskAt(stack, conv.id, 0),
          text: 'INJECT 第二条',
          source_message_ids: [userMessageId(stack, conv.id, '第二条')],
        })),
      step().inTurn().expect(userTurn('第二条')).replyText('ACK 已转告'),
    ]);
    await sendBatch(stack.core, conv.id, ['第一条']);
    await waitFor(() => (started[0]?.observed.prompts.length === 1 ? true : null), {
      label: 'first prompt',
    });
    await sendBatch(stack.core, conv.id, ['第二条']);
    await waitFor(() => (started[0]!.observed.steerings.length === 1 ? true : null), {
      label: 'steering sent',
    });
    await stack.core.rpc.call('bots.delete', { id: bot.id });
    // The refusal arrives meanwhile (300 ms): no further prompt, no new task.
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(started[0]!.observed.prompts).toHaveLength(1);
    expect(started[0]!.observed.cancels).toHaveLength(1);
    // The bot's runs (its task included) went with it.
    expect(tasksIn(stack, conv.id)).toEqual([]);
  }, 30_000);
});

describe('agent sessions of tasks (P5-2 re-review 复审 #1, #7; D75 §8.5)', () => {
  it('a crash mid-prompt keeps the agent_sessions row; the continuation resumes the session', async () => {
    const entry = fakeAgentEntry('fake-crash', { provider: 'claude' });
    const { stack, started } = await start(
      {
        'fake-crash': [
          { resume: true, modes: CLAUDE_MODES, turns: [agentTurn().text('半截').crash()] },
          { resume: true, modes: CLAUDE_MODES, turns: [agentTurn().text('恢复了')] },
        ],
      },
      [entry],
    );
    const bot = await agentBot(stack, 'fake-crash');
    const conv = await openDirect(stack.core, bot.id);
    const convId = () => conv.id;
    stack.llm.script('mock-main', [
      ...dispatch(stack, convId, '第一问', { instruction: 'TASK-ONE 回答' }),
      relay('RELAY-FAILED 外援中途出错了'),
      ...dispatch(stack, convId, '第二问', {
        instruction: 'TASK-TWO 接着回答',
        continues: () => taskAt(stack, conv.id, 0),
      }),
      relay('RELAY-TWO'),
    ]);
    await sendBatch(stack.core, conv.id, ['第一问']);
    const crashed = await waitTask(stack, conv.id, 0, ['failed']);
    // The failure woke a turn; give the release a moment: the row must survive it.
    await waitVisible(stack, conv.id, 'RELAY-FAILED');
    await waitIdle(stack, crashed.id);
    const before = sessionRows(stack, conv.id);
    expect(before).toEqual([
      { id: expect.any(String), task_id: crashed.id, agent_session_id: 'fake-session-1' },
    ]);

    await sendBatch(stack.core, conv.id, ['第二问']);
    const resumed = await waitTask(stack, conv.id, 1, ['completed']);
    expect(resumed.continuedFromRunIds).toEqual([crashed.id]);
    expect(resumed.agentSessionId).toBe('fake-session-1');
    expect(started[1]!.observed.resumedSessions.map((s) => s.sessionId)).toEqual([
      'fake-session-1',
    ]);
    expect(started[1]!.observed.sessions).toHaveLength(0);
    const prompt = started[1]!.observed.prompts[0]!.text;
    expect(prompt).not.toContain('<platform_rules');
    expect(prompt).toContain('第二问');
    // Same row (same id and session), inherited by the continuation.
    expect(sessionRows(stack, conv.id)).toEqual([
      { id: before[0]!.id, task_id: resumed.id, agent_session_id: 'fake-session-1' },
    ]);
  }, 40_000);

  it('a bot removed from the group before its task session exists gets no row (#7)', async () => {
    const { stack, started } = await start({
      fake: { newSessionDelayMs: 400, sessionDelete: true, turns: [agentTurn().text('答')] },
    });
    const bot = await agentBot(stack, 'fake');
    const other = await makeBot(stack.core, '旁人');
    const group = await makeGroup(stack.core, '群', [bot.id, other.id]);
    stack.llm.script('mock-main', [
      ...dispatch(stack, () => group.id, '问一下', { instruction: 'TASK-GROUP 回答' }),
    ]);
    await sendDrafts(stack.core, group.id, [{ text: '问一下', mentions: [bot.id] }]);
    await waitFor(() => (started[0]?.observed.sessions.length === 1 ? true : null), {
      label: 'session/new sent',
    });
    const taskId = taskAt(stack, group.id, 0);
    // Removed without reaching the task (the race the check closes).
    stack.core.services
      .mainDb!.prepare('delete from conversation_members where conversation_id = ? and bot_id = ?')
      .run(group.id, bot.id);
    await waitFor(
      () =>
        domain(stack).runs.getOrThrow(taskId).agentSessionId === 'fake-session-1' ? true : null,
      { label: 'session reported' },
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sessionRows(stack, group.id)).toEqual([]);
    // The session opened meanwhile is deleted, never prompted (第三轮 #9).
    await waitFor(() => (started[0]!.observed.deletedSessions.length === 1 ? true : null), {
      label: 'session/delete',
    });
    expect(started[0]!.observed.deletedSessions).toEqual(['fake-session-1']);
    expect(started[0]!.observed.prompts).toEqual([]);
  }, 30_000);

  for (const restore of ['resume', 'load'] as const) {
    it(`a bot removed from the group during the continuation's session/${restore} gets its session deleted (第三轮 #9)`, async () => {
      const entry = fakeAgentEntry('fake-restore', { provider: 'claude' });
      const restoring: FakeAgentScript =
        restore === 'resume'
          ? {
              resume: true,
              restoreDelayMs: 400,
              sessionDelete: true,
              modes: CLAUDE_MODES,
              turns: [],
            }
          : {
              history: [],
              restoreDelayMs: 400,
              sessionDelete: true,
              modes: CLAUDE_MODES,
              turns: [],
            };
      const { stack, started } = await start(
        {
          'fake-restore': [
            { resume: true, history: [], modes: CLAUDE_MODES, turns: [agentTurn().crash()] },
            restoring,
          ],
        },
        [entry],
      );
      const bot = await agentBot(stack, 'fake-restore');
      const other = await makeBot(stack.core, '旁人');
      const group = await makeGroup(stack.core, '群', [bot.id, other.id]);
      const groupId = () => group.id;
      stack.llm.script('mock-main', [
        ...dispatch(stack, groupId, '第一问', { instruction: 'TASK-ONE 回答' }),
        relay('RELAY-FAILED'),
        ...dispatch(stack, groupId, '第二问', {
          instruction: 'TASK-TWO 接着回答',
          continues: () => taskAt(stack, group.id, 0),
        }),
      ]);
      const rows = () => sessionRows(stack, group.id).length;
      await sendDrafts(stack.core, group.id, [{ text: '第一问', mentions: [bot.id] }]);
      const crashed = await waitTask(stack, group.id, 0, ['failed']);
      await waitVisible(stack, group.id, 'RELAY-FAILED');
      await waitIdle(stack, crashed.id);
      expect(rows()).toBe(1);
      await sendDrafts(stack.core, group.id, [{ text: '第二问', mentions: [bot.id] }]);
      await waitFor(
        () => {
          const observed = started[1]?.observed;
          if (observed === undefined) return null;
          return (restore === 'resume' ? observed.resumedSessions : observed.loadedSessions)
            .length === 1
            ? true
            : null;
        },
        { label: `session/${restore} sent` },
      );
      // Removed without reaching the task or the cascade (the race the check closes).
      stack.core.services
        .mainDb!.prepare(
          'delete from conversation_members where conversation_id = ? and bot_id = ?',
        )
        .run(group.id, bot.id);
      stack.core.services
        .mainDb!.prepare('delete from agent_sessions where conversation_id = ?')
        .run(group.id);
      await waitFor(() => (started[1]!.observed.deletedSessions.length === 1 ? true : null), {
        label: 'session/delete',
      });
      expect(started[1]!.observed.deletedSessions).toEqual(['fake-session-1']);
      expect(started[1]!.observed.prompts).toEqual([]);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(rows()).toBe(0);
    }, 40_000);
  }
});
