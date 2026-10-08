import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Bot, Message, Run, RunStep, TaskEventContent } from '@kepcup/shared';
import type { Embedder } from '../../src/memory/embedder.js';
import type { RunIdentity } from '../../src/agent/types.js';
import {
  agentTurn,
  botProfile,
  createTestStack,
  fakeAcpAgentLaunch,
  fakeAgentEntry,
  fakeAgentSpawner,
  isTaskRequest,
  listMessages,
  makeBot,
  openDirect,
  readFakeAgentRecord,
  sendBatch,
  step,
  waitFor,
  waitForRun,
  writeFakeAgentScript,
  type FakeAcpAgentHandle,
  type FakeAgentScript,
  type MockChatRequest,
  type MockLlmStep,
  type TestStack,
} from '@kepcup/testkit';

/**
 * 外部智能体引擎 P1 最小闭环与 P2 能力注入（todo/acp-external-agents.md §4.2，
 * D72），按 D75 语义（docs/design/30-supervisor-and-tasks.md §8.1）：外部
 * Agent 只是 Bot 的**任务引擎**——对话轮固定跑内置引擎（这里是脚本化的模拟
 * 模型：派任务 → 确认 → 被任务结果唤醒后转述），任务在假 Agent 上执行。
 * 覆盖：开发开关、引擎选择、伪 ref / runs.engine、任务的 run_steps 与中间说明
 * （origin:'task'）、最终文本落为私有 result 条目、与内置任务的步骤字段对齐、
 * 仅改目录数据的第二个 Agent、准备期到达的注入并入首个 prompt、宿主 MCP 桥。
 */

const stacks: TestStack[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const stack of stacks.splice(0)) {
    stack.llm.releaseAll();
    await stack.cleanup();
  }
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** Core + the fake agent as a real child process (bin/fake-acp-agent.mjs). */
async function startWithFakeAgent(script: FakeAgentScript) {
  const dir = await mkdtemp(path.join(tmpdir(), 'kepcup-ext-agent-'));
  dirs.push(dir);
  const scriptFile = path.join(dir, 'script.json');
  const recordFile = path.join(dir, 'record.jsonl');
  writeFakeAgentScript(scriptFile, script);
  const stack = await createTestStack({
    agentLaunch: (entry) =>
      entry.id === 'fake' ? fakeAcpAgentLaunch(scriptFile, recordFile) : null,
  });
  stacks.push(stack);
  return { ...stack, record: () => readFakeAgentRecord(recordFile) };
}

async function enableAgents(stack: TestStack, ids: string[]): Promise<void> {
  await stack.core.rpc.call('settings.update', {
    experimental: { externalAgents: true },
    agents: Object.fromEntries(ids.map((id) => [id, { enabled: true }])),
  });
}

async function useAgent(stack: TestStack, bot: Bot, agentId: string): Promise<Bot> {
  const profile = {
    ...bot.profile,
    runtime: { ...bot.profile.runtime, agent: { ...bot.profile.runtime.agent, id: agentId } },
  };
  const result = (await stack.core.rpc.call('bots.update', { id: bot.id, profile })) as {
    bot: Bot;
  };
  return result.bot;
}

async function steps(stack: TestStack, runId: string): Promise<RunStep[]> {
  return ((await stack.core.rpc.call('runs.steps', { runId })) as { steps: RunStep[] }).steps;
}

function payloadKeys(all: RunStep[], type: RunStep['type']): string[][] {
  return all.filter((s) => s.type === type).map((s) => Object.keys(s.payload as object).sort());
}

function domain(stack: TestStack) {
  return stack.core.services.domain!;
}

function textOf(message: Message): string {
  return 'text' in message.content ? message.content.text : '';
}

async function botMessages(stack: TestStack, conversationId: string, botId: string) {
  return (await listMessages(stack.core, conversationId)).filter((m) => m.senderBotId === botId);
}

/** The terminal entry (`result` / `failure`) of a task. */
function terminalEntry(stack: TestStack, taskId: string): TaskEventContent | null {
  const entry = domain(stack).messages.terminalTaskEvent(taskId);
  return entry === null ? null : (entry.content as TaskEventContent);
}

/** The conversation's turns, oldest first. */
function turnsOf(stack: TestStack, conversationId: string): Run[] {
  return domain(stack)
    .runs.listByConversation(conversationId, 100)
    .filter((run) => run.loopType === 'turn')
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
}

/** A turn woken by a task's terminal entry (design 30 §3.3). */
const isWake = (req: MockChatRequest): boolean =>
  !isTaskRequest(req) && req.lastUserText().includes('<trigger reason="task"');

/**
 * D75 turn script: the bot's turn (built-in mock model) starts a task for
 * the latest user message and acknowledges; the task runs on the bot's task
 * engine (the fake agent, so no `inTask` steps); a non-empty result / a
 * failure wakes a turn that relays it (`relay`, null = no waking turn).
 */
function turnStartsTask(
  stack: TestStack,
  conversationId: string,
  input: { instruction: string; writes?: boolean; ack?: string; relay?: string | null },
): MockLlmStep[] {
  return [
    step()
      .inTurn()
      .expect((req) => !isWake(req))
      .replyToolCall('start_task', () => {
        const source = domain(stack)
          .messages.listShared(conversationId, { limit: 20 })
          .filter((message) => message.senderType === 'user')
          .at(-1)!;
        return {
          title: '处理请求',
          instruction: input.instruction,
          source_message_ids: [source.id],
          writes: input.writes ?? false,
        };
      }),
    step()
      .inTurn()
      .expect((req) => !isWake(req))
      .replyText(input.ack ?? '好的，我去处理。'),
    ...(input.relay === null
      ? []
      : [
          step()
            .inTurn()
            .expect(isWake)
            .replyText(input.relay ?? '任务有结果了。'),
        ]),
  ];
}

describe('external agent engine (P1, fake agent)', () => {
  it('rejects selecting an external agent while the experimental switch is off', async () => {
    const stack = await startWithFakeAgent({ turns: [] });
    await expect(
      stack.core.rpc.call('bots.create', {
        profile: botProfile({ name: '外援', runtime: { agent: { id: 'fake' } } as never }),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const bot = await makeBot(stack.core, '外援');
    await expect(useAgent(stack, bot, 'fake')).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    await stack.core.rpc.call('settings.update', { experimental: { externalAgents: true } });
    await expect(useAgent(stack, bot, 'not-in-catalog')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    // Editing other fields of an agent bot stays possible after switching it off.
    const agentBot = await useAgent(stack, bot, 'fake');
    await stack.core.rpc.call('settings.update', { experimental: { externalAgents: false } });
    await stack.core.rpc.call('bots.update', {
      id: agentBot.id,
      profile: { ...agentBot.profile, identity: { ...agentBot.profile.identity, bio: '改简介' } },
    });
  }, 20_000);

  it('a fake-agent bot works a task: built-in turn, agent task steps, interim text, private result', async () => {
    const stack = await startWithFakeAgent({
      turns: [
        agentTurn()
          .text('我先查一下笔记。')
          .toolCall('t1', 'Read notes.md', {
            name: 'Read',
            kind: 'read',
            input: { path: 'notes.md' },
          })
          .toolResult('t1', '答案：42')
          .text('查好了：答案是 42。'),
      ],
    });
    await enableAgents(stack, ['fake']);
    const bot = await useAgent(stack, await makeBot(stack.core, '外援'), 'fake');
    const conv = await openDirect(stack.core, bot.id);
    stack.llm.script(
      'mock-main',
      turnStartsTask(stack, conv.id, { instruction: 'LOOKUP 查答案', relay: '答案是 42。' }),
    );

    await sendBatch(stack.core, conv.id, ['帮我查一下答案']);
    const task = await waitForRun(stack.core, conv.id, 'completed', { loopType: 'task' });
    // The task runs on the agent (pseudo ref / engine); the turn never does.
    expect(task).toMatchObject({
      engine: 'agent:fake',
      provider: 'agent:fake',
      model: 'agent:fake/default',
      agentSessionId: 'fake-session-1',
    });
    const [turn] = turnsOf(stack, conv.id);
    expect(turn).toMatchObject({ engine: 'builtin' });
    expect(turn!.provider?.startsWith('agent:')).toBe(false);
    expect(task.originRunId).toBe(turn!.id);

    // The final text is the task's private result, relayed by a woken turn.
    expect(terminalEntry(stack, task.id)).toMatchObject({
      phase: 'result',
      text: '查好了：答案是 42。',
    });
    await waitFor(
      async () =>
        (await botMessages(stack, conv.id, bot.id)).some((m) => textOf(m) === '答案是 42。')
          ? true
          : null,
      { label: 'relay of the result' },
    );
    const visible = await botMessages(stack, conv.id, bot.id);
    // Interim prose at the tool boundary (D54) is visible, attributed to the task.
    const interim = visible.filter((m) => textOf(m) === '我先查一下笔记。');
    expect(interim).toHaveLength(1);
    expect(interim[0]!.content).toMatchObject({ origin: 'task', taskId: task.id });
    expect(visible.map(textOf)).not.toContain('查好了：答案是 42。');
    expect(visible.map(textOf)).toEqual(
      expect.arrayContaining(['好的，我去处理。', '答案是 42。']),
    );
    expect(stack.llm.requests().find(isWake)?.lastUserText()).toContain('查好了：答案是 42。');

    const runSteps = await steps(stack, task.id);
    expect(runSteps.map((s) => s.type)).toEqual([
      'request',
      'assistant',
      'tool_call',
      'tool_result',
      'assistant',
    ]);
    expect(runSteps[2]!.payload).toMatchObject({ toolCallId: 't1', toolName: 'Read' });
    expect(runSteps[3]!.payload).toMatchObject({ toolCallId: 't1', ok: true, content: '答案：42' });

    const record = stack.record();
    expect(record.initialize?.clientInfo?.name).toBe('KepCup');
    expect(record.sessions[0]!.cwd).toContain(conv.id);
    expect(record.prompts).toHaveLength(1);
    expect(record.prompts[0]!.text).toContain('<task_brief');
    expect(record.prompts[0]!.text).toContain('LOOKUP 查答案');
    expect(record.prompts[0]!.text).toContain('帮我查一下答案');
  }, 30_000);

  it('agent task steps carry the same payload fields as built-in task steps', async () => {
    const stack = await startWithFakeAgent({
      turns: [
        agentTurn()
          .text('先说一句。')
          .toolCall('t1', 'Search', { name: 'Search', input: { q: 'x' } })
          .toolResult('t1', 'found')
          .text('完成。'),
      ],
    });
    await enableAgents(stack, ['fake']);
    const builtin = await makeBot(stack.core, '内置');
    const builtinConv = await openDirect(stack.core, builtin.id);
    stack.llm.script('mock-main', [
      ...turnStartsTask(stack, builtinConv.id, { instruction: 'BUILTIN 开始', relay: '好了' }),
      step().inTask().replyTextAndToolCall('先说一句。', 'search_messages', { query: 'x' }),
      step().inTask().replyText('完成。'),
    ]);
    await sendBatch(stack.core, builtinConv.id, ['开始']);
    const builtinTask = await waitForRun(stack.core, builtinConv.id, 'completed', {
      loopType: 'task',
    });
    expect(builtinTask.engine).toBe('builtin');
    expect(builtinTask.agentSessionId).toBeNull();
    await waitFor(() => (turnsOf(stack, builtinConv.id).length === 2 ? true : null), {
      label: 'built-in relay turn',
    });

    const agentBot = await useAgent(stack, await makeBot(stack.core, '外援'), 'fake');
    const agentConv = await openDirect(stack.core, agentBot.id);
    stack.llm.script(
      'mock-main',
      turnStartsTask(stack, agentConv.id, { instruction: 'AGENT 开始', relay: '好了' }),
    );
    await sendBatch(stack.core, agentConv.id, ['开始']);
    const agentTask = await waitForRun(stack.core, agentConv.id, 'completed', {
      loopType: 'task',
    });
    expect(agentTask.engine).toBe('agent:fake');

    const builtinSteps = await steps(stack, builtinTask.id);
    const agentSteps = await steps(stack, agentTask.id);
    for (const type of ['assistant', 'tool_call', 'tool_result'] as const) {
      expect(payloadKeys(agentSteps, type).length).toBeGreaterThan(0);
      expect(payloadKeys(agentSteps, type)).toEqual(payloadKeys(builtinSteps, type));
    }
    const stopReasons = (all: RunStep[]) =>
      all
        .filter((s) => s.type === 'assistant')
        .map((s) => (s.payload as { stopReason: string }).stopReason);
    expect(stopReasons(agentSteps)).toEqual(stopReasons(builtinSteps));
  }, 30_000);

  it('fails the task with a readable reason (and the agent setup) when the agent is not enabled', async () => {
    const stack = await startWithFakeAgent({ turns: [] });
    await stack.core.rpc.call('settings.update', { experimental: { externalAgents: true } });
    const bot = await useAgent(stack, await makeBot(stack.core, '外援'), 'fake');
    const conv = await openDirect(stack.core, bot.id);
    stack.llm.script(
      'mock-main',
      turnStartsTask(stack, conv.id, { instruction: 'HELLO 打个招呼', relay: '任务没跑起来。' }),
    );
    await sendBatch(stack.core, conv.id, ['在吗']);
    const task = await waitForRun(stack.core, conv.id, 'failed', { loopType: 'task' });
    expect(task.error).toContain('未启用');
    // (No engine ran: the gate refuses before the task's engine is recorded.)
    expect(task.setup).toMatchObject({ kind: 'agent', agentId: 'fake' });
    expect(terminalEntry(stack, task.id)).toMatchObject({ phase: 'failure', status: 'failed' });
    // The turns ran on the built-in model, unaffected: the failure woke one.
    const turns = await waitFor(
      () => {
        const all = turnsOf(stack, conv.id);
        return all.length === 2 && all.every((t) => t.status === 'completed') ? all : null;
      },
      { label: 'dispatching and woken turns completed' },
    );
    expect(turns.map((t) => t.engine)).toEqual(['builtin', 'builtin']);
    expect(task.originRunId).toBe(turns[0]!.id);
    expect(stack.record().prompts).toEqual([]);
  }, 20_000);

  it('an inject arriving while the task is still preparing joins its first prompt, not lost (P5)', async () => {
    // Hold the task inside its preparation (memory retrieval embeds the query)
    // so the inject lands between the launch and the engine run's prompt.
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
    const started: FakeAcpAgentHandle[] = [];
    const stack = await createTestStack({
      memoryEmbedder: embedder,
      env: { KEPCUP_PROFILE_CURATION_DELAY_MS: '60000' },
      agentLaunch: () => ({ command: 'in-process', args: [], env: {} }),
      agentSpawn: fakeAgentSpawner(
        { fake: { turns: [agentTurn().text('两条都收到。')] } },
        started,
      ),
    });
    stacks.push(stack);
    await enableAgents(stack, ['fake']);
    const bot = await useAgent(stack, await makeBot(stack.core, '外援'), 'fake');
    // A stored memory gives the bot a vector table, so retrieval embeds.
    await stack.core.services.memory!.writeMemory(bot.id, null, {
      content: '用户喜欢简短回答',
      kind: 'self_note',
      triggerMessages: [],
    });
    const conv = await openDirect(stack.core, bot.id);

    // The first turn's dispatch (driven directly: its only embed is the task's).
    const first = domain(stack).messages.append({
      conversationId: conv.id,
      senderType: 'user',
      kind: 'text',
      text: '第一条',
    });
    const turn: RunIdentity = {
      runId: 'run_turn_first',
      botId: bot.id,
      conversationId: conv.id,
      loopType: 'turn',
    };
    holdNext = true;
    const task = stack.core.services.orchestrator!.tasks.start(turn, {
      title: '处理',
      instruction: 'FIRST-BRIEF 处理第一条',
      sourceMessageIds: [first.id],
      writes: false,
    });
    await waitFor(() => (gate !== null ? true : null), { label: 'preparation held' });

    // The second message: its turn routes it into the task (inject_task).
    stack.llm.script('mock-main', [
      step()
        .inTurn()
        .expect((req) => !isWake(req))
        .replyToolCall('inject_task', { task_id: task.taskId, text: 'SECOND-INJECT 还有第二条' }),
      step()
        .inTurn()
        .expect((req) => !isWake(req))
        .replyText('已转给任务。'),
      step().inTurn().expect(isWake).replyText('两条都处理了。'),
    ]);
    await sendBatch(stack.core, conv.id, ['第二条']);
    await waitFor(
      () => (turnsOf(stack, conv.id).some((t) => t.status === 'completed') ? true : null),
      { label: 'inject turn completed' },
    );
    expect(started).toHaveLength(0);
    gate!();

    const done = await waitFor(
      () => {
        const run = domain(stack).runs.get(task.taskId);
        return run?.status === 'completed' ? run : null;
      },
      { label: 'task completed' },
    );
    expect(done.engine).toBe('agent:fake');
    // Not yet prompted: the inject rides along in the same prompt (one run).
    const prompts = started[0]!.observed.prompts;
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.text).toContain('FIRST-BRIEF');
    expect(prompts[0]!.text).toContain('SECOND-INJECT');
    const injects = domain(stack)
      .messages.taskEvents(task.taskId)
      .map((m) => m.content as TaskEventContent)
      .filter((content) => content.phase === 'inject');
    expect(injects).toMatchObject([{ text: 'SECOND-INJECT 还有第二条', delivery: 'delivered' }]);
    expect(
      domain(stack)
        .runs.listByConversation(conv.id, 50)
        .filter((r) => r.loopType === 'task'),
    ).toHaveLength(1);
    expect(terminalEntry(stack, task.taskId)).toMatchObject({
      phase: 'result',
      text: '两条都收到。',
    });
  }, 30_000);

  it('refuses the conversational setup interview for an external-agent bot', async () => {
    const stack = await startWithFakeAgent({ turns: [] });
    await stack.core.rpc.call('settings.update', { experimental: { externalAgents: true } });
    await expect(
      stack.core.rpc.call('bots.create', {
        profile: botProfile({ name: '外援', runtime: { agent: { id: 'fake' } } as never }),
        interview: true,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  }, 20_000);

  it('a second catalog entry (data only) is selectable and runs tasks', async () => {
    const extra = fakeAgentEntry('fake-alt', { name: '第二假智能体' });
    const stack = await createTestStack({
      agentCatalog: [extra],
      // In-process agent: the launch target is irrelevant but must resolve.
      agentLaunch: () => ({ command: 'in-process', args: [], env: {} }),
      agentSpawn: fakeAgentSpawner({ 'fake-alt': { turns: [agentTurn().text('第二个也行。')] } }),
    });
    stacks.push(stack);
    await enableAgents(stack, ['fake-alt']);
    const bot = await useAgent(stack, await makeBot(stack.core, '外援二号'), 'fake-alt');
    const conv = await openDirect(stack.core, bot.id);
    stack.llm.script(
      'mock-main',
      turnStartsTask(stack, conv.id, { instruction: 'HELLO 打招呼', relay: '它说第二个也行。' }),
    );
    await sendBatch(stack.core, conv.id, ['你好']);
    const task = await waitForRun(stack.core, conv.id, 'completed', { loopType: 'task' });
    expect(task.engine).toBe('agent:fake-alt');
    expect(terminalEntry(stack, task.id)).toMatchObject({ phase: 'result', text: '第二个也行。' });
  }, 20_000);
});

describe('external agent capability injection (P2, host MCP bridge)', () => {
  async function agentBot(stack: TestStack, capabilities: string[] | null = null): Promise<Bot> {
    const bot = await useAgent(stack, await makeBot(stack.core, '外援'), 'fake');
    if (capabilities === null) return bot;
    const profile = {
      ...bot.profile,
      runtime: { ...bot.profile.runtime, agent: { ...bot.profile.runtime.agent, capabilities } },
    };
    return ((await stack.core.rpc.call('bots.update', { id: bot.id, profile })) as { bot: Bot })
      .bot;
  }

  it('the agent task calls send_message and remember through the bridge (prompt, steps, audit)', async () => {
    const stack = await startWithFakeAgent({
      turns: [
        agentTurn()
          .mcpList()
          .mcpCall('m1', 'remember', { content: '用户喜欢猫', kind: 'preference' })
          .mcpCall('m2', 'send_message', { text: '我记住了：你喜欢猫。' })
          .text('还有别的吗？'),
      ],
    });
    await enableAgents(stack, ['fake']);
    const bot = await agentBot(stack);
    const conv = await openDirect(stack.core, bot.id);
    stack.llm.script(
      'mock-main',
      turnStartsTask(stack, conv.id, { instruction: 'REMEMBER 记下偏好', relay: '记好了。' }),
    );
    await sendBatch(stack.core, conv.id, ['记住我喜欢猫']);
    const task = await waitForRun(stack.core, conv.id, 'completed', { loopType: 'task' });

    // send_message from a task is a visible progress message attributed to it.
    const sent = (await botMessages(stack, conv.id, bot.id)).filter(
      (m) => textOf(m) === '我记住了：你喜欢猫。',
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]!.content).toMatchObject({ origin: 'task', taskId: task.id });
    expect(terminalEntry(stack, task.id)).toMatchObject({ phase: 'result', text: '还有别的吗？' });
    const memories = stack.core.services.memory!.storeFor(bot.id).allActiveWithRowids();
    expect(JSON.stringify(memories)).toContain('用户喜欢猫');

    const record = stack.record();
    expect(record.sessions[0]!.mcpServers).toMatchObject([
      { type: 'http', name: expect.stringMatching(/^kepcup_[0-9a-f]{8}$/) },
    ]);
    const listed = (record.mcp[0]!.result as Array<{ name: string; description: string }>).map(
      (tool) => tool.name,
    );
    expect(listed).toEqual(
      expect.arrayContaining(['send_message', 'skip_reply', 'remember', 'schedule']),
    );
    for (const never of [
      'bash',
      'read',
      'write',
      'request_access',
      'delegate_task',
      // The turn's routing tools never reach a task (design 30 §4.1).
      'start_task',
      'inject_task',
      'forward_task_result',
    ]) {
      expect(listed).not.toContain(never);
    }
    // The generic provider: session prompt prefixes the first prompt.
    const prompt = record.prompts[0]!.text;
    expect(prompt).toContain('<platform_rules>');
    expect(prompt).toContain('<tool_policy>');
    const server = (record.sessions[0]!.mcpServers[0] as { name: string }).name;
    expect(prompt).toContain(`mcp__${server}__remember`);
    expect(prompt).toContain('记住我喜欢猫');
    expect(prompt).toContain('REMEMBER 记下偏好');

    const runSteps = await steps(stack, task.id);
    const calls = runSteps.filter((s) => s.type === 'tool_call').map((s) => s.payload);
    expect(calls).toMatchObject([
      { toolName: 'remember', capability: 'memory', nativeOverlap: false },
      { toolName: 'send_message', capability: 'core', nativeOverlap: false },
    ]);
    expect(runSteps.filter((s) => s.type === 'tool_result')).toHaveLength(2);

    const audit = domain(stack)
      .audit.listByConversation(conv.id, 50)
      .filter((entry) => entry.action === 'agent_bridge_tool_call');
    expect(audit.map((entry) => entry.detail.toolName).sort()).toEqual([
      'remember',
      'send_message',
    ]);
    for (const entry of audit) {
      expect(entry).toMatchObject({ runId: task.id, botId: bot.id, conversationId: conv.id });
    }
  }, 30_000);

  it('unchecked packs are neither listed nor mentioned; core cannot be removed', async () => {
    const stack = await startWithFakeAgent({ turns: [agentTurn().mcpList().text('好')] });
    await enableAgents(stack, ['fake']);
    // Everything but image_generation; `core` left out on purpose.
    const bot = await agentBot(stack, ['memory', 'wiki', 'schedule', 'web', 'speech']);
    const conv = await openDirect(stack.core, bot.id);
    stack.llm.script(
      'mock-main',
      turnStartsTask(stack, conv.id, { instruction: 'HELLO 打招呼', relay: '好' }),
    );
    await sendBatch(stack.core, conv.id, ['你好']);
    await waitForRun(stack.core, conv.id, 'completed', { loopType: 'task' });
    const record = stack.record();
    const listed = (record.mcp[0]!.result as Array<{ name: string }>).map((tool) => tool.name);
    expect(listed).toContain('send_message');
    expect(listed).not.toContain('generate_image');
    expect(listed).not.toContain('delegate_to_bot');
    expect(record.prompts[0]!.text).not.toContain('generate_image');
    // Supplement tools carry the native-first prefix.
    const webSearch = (record.mcp[0]!.result as Array<{ name: string; description: string }>).find(
      (tool) => tool.name === 'web_search',
    );
    expect(webSearch?.description).toMatch(/^\[补充能力\]/);
  }, 30_000);

  it('SETUP_REQUIRED from a bridge call fails the task with the in-chat setup', async () => {
    const stack = await startWithFakeAgent({
      turns: [agentTurn().mcpCall('g1', 'generate_image', { prompt: '一只猫' }).waitCancel()],
    });
    await enableAgents(stack, ['fake']);
    const bot = await agentBot(stack);
    const conv = await openDirect(stack.core, bot.id);
    stack.llm.script(
      'mock-main',
      turnStartsTask(stack, conv.id, {
        instruction: 'DRAW 画猫',
        writes: true,
        relay: '画图需要先配置模型。',
      }),
    );
    await sendBatch(stack.core, conv.id, ['帮我画一只猫']);
    const failed = await waitForRun(stack.core, conv.id, 'failed', { loopType: 'task' });
    expect(failed.setup).toEqual({ kind: 'capability-model', capability: 'image' });
    expect(terminalEntry(stack, failed.id)).toMatchObject({ phase: 'failure', status: 'failed' });
    expect(stack.record().cancels.length).toBeGreaterThan(0);
  }, 30_000);

  it('skip_reply through the bridge completes the task with an empty result (no wake)', async () => {
    const stack = await startWithFakeAgent({
      turns: [agentTurn().mcpCall('s1', 'skip_reply', { reason: '无需回复' }).waitCancel()],
    });
    await enableAgents(stack, ['fake']);
    const bot = await agentBot(stack);
    const conv = await openDirect(stack.core, bot.id);
    stack.llm.script(
      'mock-main',
      turnStartsTask(stack, conv.id, { instruction: 'MAYBE 看看要不要回', relay: null }),
    );
    await sendBatch(stack.core, conv.id, ['嗯']);
    const task = await waitForRun(stack.core, conv.id, 'completed', { loopType: 'task' });
    expect(task.error).toBeNull();
    expect(terminalEntry(stack, task.id)).toMatchObject({ phase: 'result', text: '' });
    // Only the turn's acknowledgement: no task output, no woken turn (§3.3).
    expect((await botMessages(stack, conv.id, bot.id)).map(textOf)).toEqual(['好的，我去处理。']);
    expect(turnsOf(stack, conv.id)).toHaveLength(1);
    expect(stack.llm.requests().some(isWake)).toBe(false);
  }, 30_000);

  it('a bot still in its setup interview runs its turns on the built-in engine', async () => {
    const stack = await startWithFakeAgent({ turns: [agentTurn().text('不该由智能体回答')] });
    await enableAgents(stack, ['fake']);
    const created = (await stack.core.rpc.call('bots.create', {
      profile: {},
      interview: true,
    })) as {
      bot: Bot;
    };
    expect(created.bot.setupState).toBe('interviewing');
    // (bots.update validates the whole profile: give the placeholder a name.)
    const named = {
      ...created.bot,
      profile: {
        ...created.bot.profile,
        identity: { ...created.bot.profile.identity, name: '访谈中' },
      },
    };
    const bot = await useAgent(stack, named, 'fake');
    expect(bot.setupState).toBe('interviewing');
    expect(bot.profile.runtime.agent.id).toBe('fake');
    stack.llm.script('mock-main', [step().replyText('访谈由内置模型主持。')]);
    const conv = await openDirect(stack.core, bot.id);
    await sendBatch(stack.core, conv.id, ['你好']);
    const run = await waitForRun(stack.core, conv.id, 'completed');
    expect(run.engine).toBe('builtin');
    expect(stack.record().prompts).toHaveLength(0);
  }, 30_000);
});
