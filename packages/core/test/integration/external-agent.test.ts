import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Bot, RunStep } from '@kepcup/shared';
import type { Embedder } from '../../src/memory/embedder.js';
import {
  agentTurn,
  botProfile,
  createTestStack,
  fakeAcpAgentLaunch,
  fakeAgentEntry,
  fakeAgentSpawner,
  listMessages,
  listRuns,
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
  type TestStack,
} from '@kepcup/testkit';

/**
 * 外部智能体引擎 P1 最小闭环（todo/acp-external-agents.md §4.2，D72）：
 * 开发开关、引擎选择、伪 ref / runs.engine、消息与 run_steps 落库、
 * 中间说明切分、与内置引擎的步骤字段对齐、仅改目录数据的第二个 Agent。
 */

const stacks: TestStack[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const stack of stacks.splice(0)) await stack.cleanup();
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

  it('a fake-agent bot answers a direct chat: messages, run_steps, runs.engine', async () => {
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

    await sendBatch(stack.core, conv.id, ['帮我查一下答案']);
    const run = await waitForRun(stack.core, conv.id, 'completed');

    expect(run).toMatchObject({
      engine: 'agent:fake',
      provider: 'agent:fake',
      model: 'agent:fake/default',
      agentSessionId: 'fake-session-1',
    });
    const botTexts = (await listMessages(stack.core, conv.id))
      .filter((m) => m.senderBotId === bot.id)
      .map((m) => ('text' in m.content ? m.content.text : ''));
    // Interim prose at the tool boundary (D54) + the final answer.
    expect(botTexts).toEqual(['我先查一下笔记。', '查好了：答案是 42。']);

    const runSteps = await steps(stack, run.id);
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
    expect(record.prompts[0]!.text).toContain('帮我查一下答案');
  }, 20_000);

  it('agent run steps carry the same payload fields as built-in runs', async () => {
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
    stack.llm.script('mock-main', [
      step().replyTextAndToolCall('先说一句。', 'search_messages', { query: 'x' }),
      step().replyText('完成。'),
    ]);
    const builtin = await makeBot(stack.core, '内置');
    const builtinConv = await openDirect(stack.core, builtin.id);
    await sendBatch(stack.core, builtinConv.id, ['开始']);
    const builtinRun = await waitForRun(stack.core, builtinConv.id, 'completed');
    expect(builtinRun.engine).toBe('builtin');
    expect(builtinRun.agentSessionId).toBeNull();

    const agentBot = await useAgent(stack, await makeBot(stack.core, '外援'), 'fake');
    const agentConv = await openDirect(stack.core, agentBot.id);
    await sendBatch(stack.core, agentConv.id, ['开始']);
    const agentRun = await waitForRun(stack.core, agentConv.id, 'completed');

    const builtinSteps = await steps(stack, builtinRun.id);
    const agentSteps = await steps(stack, agentRun.id);
    for (const type of ['assistant', 'tool_call', 'tool_result'] as const) {
      expect(payloadKeys(agentSteps, type).length).toBeGreaterThan(0);
      expect(payloadKeys(agentSteps, type)).toEqual(payloadKeys(builtinSteps, type));
    }
    const stopReasons = (all: RunStep[]) =>
      all
        .filter((s) => s.type === 'assistant')
        .map((s) => (s.payload as { stopReason: string }).stopReason);
    expect(stopReasons(agentSteps)).toEqual(stopReasons(builtinSteps));
  }, 20_000);

  it('fails the run with a readable reason when the agent is not enabled', async () => {
    const stack = await startWithFakeAgent({ turns: [] });
    await stack.core.rpc.call('settings.update', { experimental: { externalAgents: true } });
    const bot = await useAgent(stack, await makeBot(stack.core, '外援'), 'fake');
    const conv = await openDirect(stack.core, bot.id);
    await sendBatch(stack.core, conv.id, ['在吗']);
    const run = await waitForRun(stack.core, conv.id, 'failed');
    expect(run.error).toContain('未启用');
    expect(run.engine).toBe('agent:fake');
  }, 20_000);

  it('a batch sent while the run is still preparing joins its prompt, not lost (P5)', async () => {
    // Hold the run inside its preparation (memory retrieval embeds the query)
    // so the second batch lands between scheduling and run registration.
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

    holdNext = true;
    await sendBatch(stack.core, conv.id, ['第一条']);
    await waitFor(() => (gate !== null ? true : null), { label: 'preparation held' });
    await sendBatch(stack.core, conv.id, ['第二条']);
    gate!();

    await waitFor(
      async () =>
        (await listRuns(stack.core, conv.id)).some(
          (r) => r.loopType === 'response' && r.status === 'completed',
        )
          ? true
          : null,
      { label: 'completed response run' },
    );
    // Not yet prompted: the batch rides along in the same prompt (one run).
    const prompts = started[0]!.observed.prompts;
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.text).toContain('第一条');
    expect(prompts[0]!.text).toContain('第二条');
    const runs = (await listRuns(stack.core, conv.id)).filter((r) => r.loopType === 'response');
    expect(runs).toHaveLength(1);
    const botTexts = (await listMessages(stack.core, conv.id))
      .filter((m) => m.senderBotId === bot.id)
      .map((m) => ('text' in m.content ? m.content.text : ''));
    expect(botTexts).toEqual(['两条都收到。']);
  }, 20_000);

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

  it('a second catalog entry (data only) is selectable and runs', async () => {
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
    await sendBatch(stack.core, conv.id, ['你好']);
    const run = await waitForRun(stack.core, conv.id, 'completed');
    expect(run.engine).toBe('agent:fake-alt');
    const botTexts = (await listMessages(stack.core, conv.id))
      .filter((m) => m.senderBotId === bot.id)
      .map((m) => ('text' in m.content ? m.content.text : ''));
    expect(botTexts).toEqual(['第二个也行。']);
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

  it('the agent calls send_message and remember through the bridge (prompt, steps, audit)', async () => {
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
    await sendBatch(stack.core, conv.id, ['记住我喜欢猫']);
    const run = await waitForRun(stack.core, conv.id, 'completed');

    const botTexts = (await listMessages(stack.core, conv.id))
      .filter((m) => m.senderBotId === bot.id)
      .map((m) => ('text' in m.content ? m.content.text : ''));
    expect(botTexts).toEqual(['我记住了：你喜欢猫。', '还有别的吗？']);
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
    for (const never of ['bash', 'read', 'write', 'request_access', 'delegate_task']) {
      expect(listed).not.toContain(never);
    }
    // The generic provider: session prompt prefixes the first prompt.
    const prompt = record.prompts[0]!.text;
    expect(prompt).toContain('<platform_rules>');
    expect(prompt).toContain('<tool_policy>');
    const server = (record.sessions[0]!.mcpServers[0] as { name: string }).name;
    expect(prompt).toContain(`mcp__${server}__remember`);
    expect(prompt).toContain('记住我喜欢猫');

    const runSteps = await steps(stack, run.id);
    const calls = runSteps.filter((s) => s.type === 'tool_call').map((s) => s.payload);
    expect(calls).toMatchObject([
      { toolName: 'remember', capability: 'memory', nativeOverlap: false },
      { toolName: 'send_message', capability: 'core', nativeOverlap: false },
    ]);
    expect(runSteps.filter((s) => s.type === 'tool_result')).toHaveLength(2);

    const audit = stack.core.services
      .domain!.audit.listByConversation(conv.id, 50)
      .filter((entry) => entry.action === 'agent_bridge_tool_call');
    expect(audit.map((entry) => entry.detail.toolName).sort()).toEqual([
      'remember',
      'send_message',
    ]);
    for (const entry of audit) {
      expect(entry).toMatchObject({ runId: run.id, botId: bot.id, conversationId: conv.id });
    }
  }, 30_000);

  it('unchecked packs are neither listed nor mentioned; core cannot be removed', async () => {
    const stack = await startWithFakeAgent({ turns: [agentTurn().mcpList().text('好')] });
    await enableAgents(stack, ['fake']);
    // Everything but image_generation; `core` left out on purpose.
    const bot = await agentBot(stack, ['memory', 'wiki', 'schedule', 'web', 'speech']);
    const conv = await openDirect(stack.core, bot.id);
    await sendBatch(stack.core, conv.id, ['你好']);
    await waitForRun(stack.core, conv.id, 'completed');
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

  it('SETUP_REQUIRED from a bridge call ends in the in-chat setup failure', async () => {
    const stack = await startWithFakeAgent({
      turns: [agentTurn().mcpCall('g1', 'generate_image', { prompt: '一只猫' }).waitCancel()],
    });
    await enableAgents(stack, ['fake']);
    const bot = await agentBot(stack);
    const conv = await openDirect(stack.core, bot.id);
    await sendBatch(stack.core, conv.id, ['帮我画一只猫']);
    const failed = await waitForRun(stack.core, conv.id, 'failed');
    expect(failed.setup).toEqual({ kind: 'capability-model', capability: 'image' });
    expect(stack.record().cancels.length).toBeGreaterThan(0);
  }, 30_000);

  it('skip_reply through the bridge completes the run without a reply', async () => {
    const stack = await startWithFakeAgent({
      turns: [agentTurn().mcpCall('s1', 'skip_reply', { reason: '无需回复' }).waitCancel()],
    });
    await enableAgents(stack, ['fake']);
    const bot = await agentBot(stack);
    const conv = await openDirect(stack.core, bot.id);
    await sendBatch(stack.core, conv.id, ['嗯']);
    const run = await waitForRun(stack.core, conv.id, 'completed');
    expect(run.error).toBeNull();
    const botMessages = (await listMessages(stack.core, conv.id)).filter(
      (m) => m.senderBotId === bot.id,
    );
    expect(botMessages).toEqual([]);
  }, 30_000);

  it('a bot still in its setup interview runs on the built-in engine', async () => {
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
