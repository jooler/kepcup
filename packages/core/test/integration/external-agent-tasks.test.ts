import { afterEach, describe, expect, it } from 'vitest';
import { CONTINUATION_WINDOW_MS, type Bot, type Message, type Run } from '@kepcup/shared';
import {
  agentTurn,
  createTestStack,
  fakeAgentEntry,
  fakeAgentSpawner,
  makeBot,
  openDirect,
  waitFor,
  type FakeAcpAgentHandle,
  type FakeAgentScript,
  type TestStack,
} from '@kepcup/testkit';
import type { RunIdentity } from '../../src/agent/types.js';

/**
 * D75 W4 外部 Agent 作任务引擎（docs/design/30-supervisor-and-tasks.md §8）：
 * 任务各占自己的会话（§8.5，agent_sessions 按任务分行、桥 token 各自签发）、
 * `features.parallelSessions=false` 的 Agent 任务并发钳为 1、
 * `continues_task_id` 继承来源任务的会话、只读任务强制 read_only 档位、
 * steering 异步拒绝把 inject 条目降为 queued、过期的任务会话被 reaper 关闭。
 * 任务经 TaskHost 直接派出（模拟一个对话轮的身份）；任务结果为空时不唤醒
 * 对话层（§3.3），用例里的 Agent 轮次因此只服务任务。
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
  scripts: Record<string, FakeAgentScript>,
  catalog: ReturnType<typeof fakeAgentEntry>[] = [],
) {
  const started: FakeAcpAgentHandle[] = [];
  const stack = await createTestStack({
    ...(catalog.length > 0 ? { agentCatalog: catalog } : {}),
    agentLaunch: () => ({ command: 'in-process', args: [], env: {} }),
    agentSpawn: fakeAgentSpawner(scripts, started) as never,
  });
  stacks.push(stack);
  await stack.core.rpc.call('settings.update', {
    experimental: { externalAgents: true },
    agents: Object.fromEntries(Object.keys(scripts).map((id) => [id, { enabled: true }])),
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

function tasksOf(stack: TestStack) {
  return stack.core.services.orchestrator!.tasks;
}

function turnIdentity(botId: string, conversationId: string, runId: string): RunIdentity {
  return { runId, botId, conversationId, loopType: 'turn' };
}

function userMessage(stack: TestStack, conversationId: string, text: string): Message {
  return domain(stack).messages.append({ conversationId, senderType: 'user', kind: 'text', text });
}

function startTask(
  stack: TestStack,
  bot: Bot,
  conversationId: string,
  input: { title: string; instruction: string; writes?: boolean; continuesTaskId?: string },
  turnRunId = `run_turn_${Math.random().toString(36).slice(2, 8)}`,
) {
  const source = userMessage(stack, conversationId, `请处理：${input.title}`);
  return tasksOf(stack).start(turnIdentity(bot.id, conversationId, turnRunId), {
    title: input.title,
    instruction: input.instruction,
    sourceMessageIds: [source.id],
    writes: input.writes ?? false,
    ...(input.continuesTaskId !== undefined ? { continuesTaskId: input.continuesTaskId } : {}),
  });
}

function runOf(stack: TestStack, id: string): Run {
  return domain(stack).runs.getOrThrow(id);
}

function waitStatus(stack: TestStack, id: string, statuses: Run['status'][], label: string) {
  return waitFor(
    () => {
      const run = domain(stack).runs.get(id);
      return run !== null && statuses.includes(run.status) ? run : null;
    },
    { label, timeoutMs: 20_000 },
  );
}

function sessionRows(stack: TestStack, conversationId: string) {
  return stack.core.services
    .mainDb!.prepare(
      'select id, task_id, agent_session_id, last_used_at from agent_sessions where conversation_id = ? order by created_at',
    )
    .all(conversationId) as Array<{
    id: string;
    task_id: string;
    agent_session_id: string;
    last_used_at: number;
  }>;
}

function bearer(server: unknown): string | null {
  const headers = (server as { headers?: Array<{ name: string; value: string }> }).headers ?? [];
  return headers.find((header) => header.name.toLowerCase() === 'authorization')?.value ?? null;
}

/** Waits until the task host no longer runs the task (its engine run is released). */
function waitIdle(stack: TestStack, taskId: string) {
  return waitFor(() => (tasksOf(stack).isExecuting(taskId) ? null : true), {
    label: `task ${taskId} execution released`,
  });
}

describe('external agents as the task engine (D75 §8)', () => {
  it('two tasks run in parallel, each in its own session with its own bridge token and row', async () => {
    const { stack, started } = await start({
      fake: {
        // Each task calls a host tool through the bridge once both sessions
        // exist: with a shared key the later session's token / run binding
        // would replace the earlier one's.
        turns: [
          agentTurn().sleep(700).mcpCall('m1', 'send_message', { text: '进度一' }),
          agentTurn().sleep(700).mcpCall('m2', 'send_message', { text: '进度二' }),
        ],
      },
    });
    const bot = await agentBot(stack, 'fake');
    const conv = await openDirect(stack.core, bot.id);

    const a = startTask(stack, bot, conv.id, { title: '查 A', instruction: 'TASK-A 只读调研' });
    const b = startTask(stack, bot, conv.id, { title: '查 B', instruction: 'TASK-B 只读调研' });

    // Both prompts are in flight at once (the agent has parallel sessions).
    await waitFor(() => ((started[0]?.observed.prompts.length ?? 0) >= 2 ? true : null), {
      label: 'two prompts in flight',
    });
    expect(runOf(stack, a.taskId).status).toBe('running');
    expect(runOf(stack, b.taskId).status).toBe('running');

    const [doneA, doneB] = await Promise.all([
      waitStatus(stack, a.taskId, ['completed'], 'task A completed'),
      waitStatus(stack, b.taskId, ['completed'], 'task B completed'),
    ]);
    expect(doneA.engine).toBe('agent:fake');
    expect(doneA.agentSessionId).not.toBeNull();
    expect(doneB.agentSessionId).not.toBeNull();
    expect(doneA.agentSessionId).not.toBe(doneB.agentSessionId);

    const observed = started[0]!.observed;
    expect(started).toHaveLength(1);
    expect(observed.sessions).toHaveLength(2);
    const promptOf = (marker: string) => observed.prompts.find((p) => p.text.includes(marker))!;
    expect(promptOf('TASK-A').sessionId).not.toBe(promptOf('TASK-B').sessionId);
    // Each session carries the full context (no reuse between sibling tasks).
    expect(promptOf('TASK-A').text).toContain('<task_brief');
    expect(promptOf('TASK-B').text).not.toContain('TASK-A');
    const tokens = observed.sessions.flatMap((session) => session.mcpServers.map(bearer));
    expect(tokens.filter((token) => token !== null)).toHaveLength(2);
    expect(new Set(tokens).size).toBe(2);

    // Both bridge calls went through, each attributed to its own task.
    expect(observed.mcp.filter((call) => call.method === 'tools/call').map((c) => c.ok)).toEqual([
      true,
      true,
    ]);
    const progress = domain(stack)
      .messages.listShared(conv.id, { limit: 50 })
      .filter((message) => message.senderType === 'bot')
      .map((message) => message.content as { origin?: string; taskId?: string });
    expect(progress.map((content) => content.origin)).toEqual(['task', 'task']);
    expect(progress.map((content) => content.taskId).sort()).toEqual([a.taskId, b.taskId].sort());
    for (const [taskId, run] of [
      [a.taskId, doneA],
      [b.taskId, doneB],
    ] as const) {
      const own = domain(stack)
        .messages.listShared(conv.id, { limit: 50 })
        .filter((message) => (message.content as { taskId?: string }).taskId === taskId);
      expect(own.map((message) => message.id)).toEqual(runOf(stack, run.id).outputMessageIds);
    }

    const rows = sessionRows(stack, conv.id);
    expect(rows.map((row) => row.task_id).sort()).toEqual([a.taskId, b.taskId].sort());
    expect(new Set(rows.map((row) => row.agent_session_id)).size).toBe(2);
  }, 60_000);

  it('an agent without parallel sessions runs one task at a time (agent:{id} clamped to 1)', async () => {
    // Not a testkit entry: the generic provider's parallelSessions=false holds.
    const serial = fakeAgentEntry('serial', { releaseGate: 'serial-test' });
    const { stack, started } = await start(
      {
        serial: { serialPrompts: true, turns: [agentTurn().sleep(500), agentTurn().sleep(500)] },
      },
      [serial],
    );
    await stack.core.rpc.call('settings.update', {
      providerConcurrency: { default: 4, 'agent:serial': 3 },
    });
    const bot = await agentBot(stack, 'serial');
    const conv = await openDirect(stack.core, bot.id);

    const a = startTask(stack, bot, conv.id, { title: '一', instruction: 'SERIAL-ONE' });
    const b = startTask(stack, bot, conv.id, { title: '二', instruction: 'SERIAL-TWO' });
    await waitFor(() => (started[0]?.observed.prompts.length === 1 ? true : null), {
      label: 'first prompt',
    });
    // The second task is launched but waits for the agent's only slot.
    const waiting = tasksOf(stack)
      .list(turnIdentity(bot.id, conv.id, 'run_list'))
      .filter((task) => task.state === 'submitted');
    expect(waiting).toHaveLength(1);
    expect(waiting[0]!.queueReason).toBe('等模型并发额度');

    const [doneA, doneB] = await Promise.all([
      waitStatus(stack, a.taskId, ['completed', 'failed'], 'task one settled'),
      waitStatus(stack, b.taskId, ['completed', 'failed'], 'task two settled'),
    ]);
    // A concurrent prompt would have been refused by the agent (serialPrompts).
    expect([doneA.status, doneB.status]).toEqual(['completed', 'completed']);
    expect(started[0]!.observed.prompts).toHaveLength(2);
    // Still one session per task.
    expect(new Set(started[0]!.observed.prompts.map((p) => p.sessionId)).size).toBe(2);
  }, 60_000);

  it('continues_task_id inherits the source task session; a fresh task gets a new one', async () => {
    const { stack, started } = await start({
      fake: {
        sessionClose: true,
        turns: [agentTurn().sleep(50), agentTurn().sleep(50), agentTurn().sleep(50)],
      },
    });
    const bot = await agentBot(stack, 'fake');
    const conv = await openDirect(stack.core, bot.id);

    const a = startTask(stack, bot, conv.id, { title: '初版', instruction: 'FIRST-PASS 做初版' });
    const doneA = await waitStatus(stack, a.taskId, ['completed'], 'task A completed');
    await waitIdle(stack, a.taskId);

    const b = startTask(stack, bot, conv.id, {
      title: '接着做',
      instruction: 'SECOND-PASS 在初版基础上继续',
      continuesTaskId: a.taskId,
    });
    const doneB = await waitStatus(stack, b.taskId, ['completed'], 'task B completed');
    expect(doneB.agentSessionId).toBe(doneA.agentSessionId);
    expect(doneB.continuedFromRunIds).toEqual([a.taskId]);
    const observed = started[0]!.observed;
    expect(observed.sessions).toHaveLength(1);
    const second = observed.prompts[1]!;
    expect(second.sessionId).toBe(observed.prompts[0]!.sessionId);
    // Reused: the session prompt and the first brief are not sent again.
    expect(second.text).toContain('SECOND-PASS');
    expect(second.text).not.toContain('<platform_rules');
    expect(second.text).not.toContain('FIRST-PASS');
    const steps = (await stack.core.rpc.call('runs.steps', { runId: b.taskId })) as {
      steps: Array<{ type: string; payload: { session?: string } }>;
    };
    expect(steps.steps.find((step) => step.type === 'request')!.payload.session).toBe('reused');
    // The row moved to the new task (one row, same id).
    const rows = sessionRows(stack, conv.id);
    expect(rows.map((row) => row.task_id)).toEqual([b.taskId]);

    await waitIdle(stack, b.taskId);
    const c = startTask(stack, bot, conv.id, { title: '另一件事', instruction: 'OTHER-WORK' });
    const doneC = await waitStatus(stack, c.taskId, ['completed'], 'task C completed');
    expect(doneC.agentSessionId).not.toBe(doneA.agentSessionId);
    expect(observed.sessions).toHaveLength(2);
    expect(
      sessionRows(stack, conv.id)
        .map((row) => row.task_id)
        .sort(),
    ).toEqual([b.taskId, c.taskId].sort());

    // Past the continuation window the reaper closes settled tasks' sessions.
    tasksOf(stack).sweep(Date.now() + CONTINUATION_WINDOW_MS + 60_000);
    expect(sessionRows(stack, conv.id)).toEqual([]);
    await waitFor(() => (observed.closedSessions.length === 2 ? true : null), {
      label: 'expired task sessions closed',
    });
    expect(observed.deletedSessions).toEqual([]);
  }, 60_000);

  it('a read-only task runs on the read_only tier: in-workdir writes are refused, a write task may write', async () => {
    const { stack, started } = await start({
      fake: {
        turns: [
          agentTurn().permission('ro', 'Edit notes.md', { kind: 'edit', locations: ['notes.md'] }),
          agentTurn().permission('rw', 'Edit notes.md', { kind: 'edit', locations: ['notes.md'] }),
        ],
      },
    });
    // The bot's own tier is workspace (in-workdir edits pass).
    const bot = await agentBot(stack, 'fake');
    const conv = await openDirect(stack.core, bot.id);

    const ro = startTask(stack, bot, conv.id, { title: '只读', instruction: 'READ-ONLY 看看' });
    await waitStatus(stack, ro.taskId, ['completed'], 'read-only task completed');
    await waitIdle(stack, ro.taskId);
    const rw = startTask(stack, bot, conv.id, {
      title: '改',
      instruction: 'WRITE 改一下',
      writes: true,
    });
    await waitStatus(stack, rw.taskId, ['completed'], 'write task completed');

    const outcomes = Object.fromEntries(
      started[0]!.observed.permissions.map((p) => [
        p.toolCallId,
        p.outcome.outcome === 'selected' ? p.outcome.optionId : p.outcome.outcome,
      ]),
    );
    expect(outcomes).toEqual({ ro: 'reject_once', rw: 'allow_once' });
    // One session per task.
    expect(new Set(started[0]!.observed.prompts.map((p) => p.sessionId)).size).toBe(2);
  }, 60_000);

  it('inject_task on an agent: async refusal → queued, injected → delivered, no steering → queued at once', async () => {
    const steerEntry = fakeAgentEntry('fake-steer', { provider: 'claude' });
    const okEntry = fakeAgentEntry('fake-ok', { provider: 'claude' });
    // Generic provider: no steering support (design 30 §8.2).
    const plainEntry = fakeAgentEntry('fake-plain');
    const { stack, started } = await start(
      {
        'fake-steer': {
          steering: true,
          steeringOutcome: 'promptRequired',
          modes: CLAUDE_MODES,
          turns: [agentTurn().sleep(800)],
        },
        'fake-ok': {
          steering: true,
          modes: CLAUDE_MODES,
          turns: [agentTurn().sleep(800)],
        },
        'fake-plain': { turns: [agentTurn().sleep(800)] },
      },
      [steerEntry, okEntry, plainEntry],
    );
    const inject = async (agentId: string, expected: 'delivered' | 'queued'): Promise<Message> => {
      const bot = await agentBot(stack, agentId);
      const conv = await openDirect(stack.core, bot.id);
      const task = startTask(stack, bot, conv.id, {
        title: '长活',
        instruction: `LONG-${agentId}`,
      });
      await waitFor(
        () =>
          started.find((handle) =>
            handle.observed.prompts.some((p) => p.text.includes(`LONG-${agentId}`)),
          ) ?? null,
        { label: `prompt of ${agentId}` },
      );
      const result = tasksOf(stack).inject(turnIdentity(bot.id, conv.id, 'run_turn_inject'), {
        taskId: task.taskId,
        text: `补充：${agentId}`,
      });
      // ACP steering is asynchronous: an agent with steering accepts it for now.
      expect(result.delivery).toBe(expected);
      await waitStatus(stack, task.taskId, ['completed'], `task on ${agentId} completed`);
      return domain(stack)
        .messages.taskEvents(task.taskId)
        .find((event) => (event.content as { phase: string }).phase === 'inject')!;
    };

    const refused = await inject('fake-steer', 'delivered');
    expect(refused.content).toMatchObject({ phase: 'inject', delivery: 'queued' });
    const taken = await inject('fake-ok', 'delivered');
    expect(taken.content).toMatchObject({ phase: 'inject', delivery: 'delivered' });
    const plain = await inject('fake-plain', 'queued');
    expect(plain.content).toMatchObject({ phase: 'inject', delivery: 'queued' });
    expect(started.flatMap((handle) => handle.observed.steerings)).toHaveLength(2);
  }, 60_000);
});
