import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TASK_SETTLE_SWEEP_MS,
  type Bot,
  type Message,
  type Run,
  type TaskEventContent,
} from '@kepcup/shared';
import {
  agentTurn,
  createTestStack,
  fakeAgentSpawner,
  makeBot,
  openDirect,
  waitFor,
  type FakeAcpAgentHandle,
  type FakeAgentScript,
  type TestStack,
} from '@kepcup/testkit';
import { TaskHost, type TaskRunControl, type TaskRunHandle } from '../../src/dispatch/tasks.js';
import { ExternalAgentEngine } from '../../src/agent/external/engine.js';
import type { RunHandle, RunIdentity, RunSpec } from '../../src/agent/types.js';

/**
 * D75 W4 + W2-D66 审查修复（批 C）：M3 外部 Agent 任务按 `agent:{id}` 名额
 * 启动（超出的留在 submitted、不取租约）、L4 steer 确认后剪除 / 被拒按 FIFO
 * 匹配、L5 被 reaper 驱逐但未结束的执行仍算「执行中」、L6 无 workdir 的任务
 * 在 workspace 执行（与租约一致）、L8 引擎启动后的崩溃先中止引擎、L10
 * workspace 工作目录的 Agent 任务不带 <project> 段。
 */

const stacks: TestStack[] = [];
const dirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const stack of stacks.splice(0)) await stack.cleanup();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function domain(stack: TestStack) {
  return stack.core.services.domain!;
}

function tasksOf(stack: TestStack) {
  return stack.core.services.orchestrator!.tasks;
}

function turnIdentity(botId: string, conversationId: string, runId = 'run_turn_c'): RunIdentity {
  return { runId, botId, conversationId, loopType: 'response' };
}

function entries(stack: TestStack, taskId: string): TaskEventContent[] {
  return domain(stack)
    .messages.taskEvents(taskId)
    .map((m) => m.content as TaskEventContent);
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

const quietLogger = { info() {}, warn() {}, error() {}, debug() {} } as never;

/** A TaskHost over the test core's domain services, executions driven by hand. */
function handDrivenHost(
  stack: TestStack,
  extra: { launchSlot?: (task: Run) => { key: string; limit: number } | null } = {},
) {
  const d = domain(stack);
  const controls = new Map<string, TaskRunControl>();
  const host = new TaskHost({
    db: stack.core.services.mainDb!,
    runs: d.runs,
    messages: d.messages,
    conversations: d.conversations,
    bots: d.bots,
    clock: { now: () => Date.now() },
    logger: quietLogger,
    timeZone: 'UTC',
    renderOptions: (selfBotId) => ({ selfBotId, timeZone: 'UTC', botNames: new Map() }),
    publishRunStatus: () => {},
    execute: (task, control) => {
      controls.set(task.id, control);
    },
    wake: () => {},
    resolveWorkdir: (_botId, conversationId) =>
      path.join(tmpdir(), 'tasks-review-c-ws', conversationId),
    onSettled: () => {},
    releaseExecution: () => {},
    recordVisibleMessage: () => {},
    ...extra,
  });
  return { host, controls };
}

function fakeHandle(onSteer?: (text: string) => void): TaskRunHandle & { steered: string[] } {
  const steered: string[] = [];
  return {
    steered,
    steer(text) {
      steered.push(text);
      onSteer?.(text);
      return true;
    },
    abort() {},
    tokensSoFar: () => 0,
  };
}

async function coreStack(): Promise<TestStack> {
  const stack = await createTestStack();
  stacks.push(stack);
  return stack;
}

describe('M3: external-agent tasks launch only within agent:{id} concurrency', () => {
  it('tasks over the agent limit stay submitted (not launched, no lease) with a wait reason', async () => {
    const stack = await coreStack();
    const bot = await makeBot(stack.core, '外援');
    const convA = await openDirect(stack.core, bot.id);
    const other = await makeBot(stack.core, '外援二');
    const convB = await openDirect(stack.core, other.id);
    const { host, controls } = handDrivenHost(stack, {
      launchSlot: () => ({ key: 'agent:serial', limit: 1 }),
    });
    const write = (botId: string, conversationId: string, title: string) =>
      host.start(turnIdentity(botId, conversationId, `run_${title}`), {
        title,
        instruction: title,
        sourceMessageIds: [],
        writes: true,
      });
    const first = write(bot.id, convA.id, 'one');
    // Another conversation, another workdir: only the agent's slot is in the way.
    const second = write(other.id, convB.id, 'two');
    expect([...controls.keys()]).toEqual([first.taskId]);
    expect(host.launchedCount()).toBe(1);
    expect(host.isExecuting(second.taskId)).toBe(false);
    expect(second.state).toBe('submitted');
    expect(second.queueReason).toBe('等智能体并发额度（agent:serial 1/1）');

    // The first execution ends: the second launches now.
    const control = controls.get(first.taskId)!;
    host.settle(first.taskId, { status: 'completed', resultText: '' });
    control.finish();
    expect(controls.has(second.taskId)).toBe(true);
    host.settle(second.taskId, { status: 'completed', resultText: '' });
    controls.get(second.taskId)!.finish();
  });
});

describe('L4: steered injects are matched FIFO and pruned once confirmed', () => {
  it('a confirmed steer is never downgraded by a later refusal of the same text', async () => {
    const stack = await coreStack();
    const bot = await makeBot(stack.core, '小艾');
    const conv = await openDirect(stack.core, bot.id);
    const { host, controls } = handDrivenHost(stack);
    const identity = turnIdentity(bot.id, conv.id);
    const started = host.start(identity, {
      title: 't',
      instruction: 'i',
      sourceMessageIds: [],
      writes: false,
    });
    const control = controls.get(started.taskId)!;
    control.brief();
    const handle = fakeHandle();
    control.attach(handle);
    host.inject(identity, { taskId: started.taskId, text: '同一句补充' });
    // The engine took the first one in (its `steer` event).
    control.steerConfirmed(handle.steered[0]!);
    host.inject(identity, { taskId: started.taskId, text: '同一句补充' });
    // …and refused the second one asynchronously.
    control.steerRefused(handle.steered[1]!);
    const injects = entries(stack, started.taskId).filter((e) => e.phase === 'inject');
    expect(injects.map((e) => e.delivery)).toEqual(['delivered', 'queued']);
    // Nothing unconfirmed is left: a stray refusal changes nothing.
    control.steerRefused(handle.steered[0]!);
    expect(
      entries(stack, started.taskId)
        .filter((e) => e.phase === 'inject')
        .map((e) => e.delivery),
    ).toEqual(['delivered', 'queued']);
    control.detach();
    host.settle(started.taskId, { status: 'completed', resultText: '' });
    control.finish();
  });

  it('an engine confirming inside steer() (built-in) is pruned too', async () => {
    const stack = await coreStack();
    const bot = await makeBot(stack.core, '小艾');
    const conv = await openDirect(stack.core, bot.id);
    const { host, controls } = handDrivenHost(stack);
    const identity = turnIdentity(bot.id, conv.id);
    const started = host.start(identity, {
      title: 't',
      instruction: 'i',
      sourceMessageIds: [],
      writes: false,
    });
    const control = controls.get(started.taskId)!;
    control.brief();
    const handle = fakeHandle((text) => control.steerConfirmed(text));
    control.attach(handle);
    host.inject(identity, { taskId: started.taskId, text: '立即确认' });
    control.steerRefused(handle.steered[0]!);
    const injects = entries(stack, started.taskId).filter((e) => e.phase === 'inject');
    expect(injects.map((e) => e.delivery)).toEqual(['delivered']);
    control.detach();
    host.settle(started.taskId, { status: 'completed', resultText: '' });
    control.finish();
  });
});

describe('L5: an evicted execution that has not finished still counts as executing', () => {
  it('isExecuting stays true after the reaper eviction until finish()', async () => {
    const stack = await coreStack();
    const bot = await makeBot(stack.core, '小艾');
    const conv = await openDirect(stack.core, bot.id);
    const { host, controls } = handDrivenHost(stack);
    const started = host.start(turnIdentity(bot.id, conv.id), {
      title: 't',
      instruction: 'i',
      sourceMessageIds: [],
      writes: false,
    });
    const control = controls.get(started.taskId)!;
    control.attach(fakeHandle());
    host.settle(started.taskId, { status: 'cancelled', error: '取消' });
    // The execution never comes back: the reaper evicts it (slot / lease freed).
    host.sweep(Date.now() + TASK_SETTLE_SWEEP_MS + 1_000);
    expect(host.launchedCount()).toBe(0);
    // Its engine run (an agent session) may still be busy: never inherited yet.
    expect(host.isExecuting(started.taskId)).toBe(true);
    control.finish();
    expect(host.isExecuting(started.taskId)).toBe(false);
  });
});

// --- external agent paths (fake ACP agent) ------------------------------------

async function agentStack(scripts: Record<string, FakeAgentScript>) {
  const started: FakeAcpAgentHandle[] = [];
  const stack = await createTestStack({
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

async function bindProject(stack: TestStack, conversationId: string): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), 'tasks-review-c-project-'));
  dirs.push(dir);
  writeFileSync(path.join(dir, 'README.md'), '# p\n');
  const bound = (await stack.core.rpc.call('projects.select', { conversationId, path: dir })) as {
    project: { path: string };
  };
  return bound.project.path;
}

function workspaceOf(stack: TestStack, botId: string, conversationId: string): string {
  return path.join(stack.core.services.paths.home, 'bots', botId, 'workspaces', conversationId);
}

function userMessage(stack: TestStack, conversationId: string, text: string): Message {
  return domain(stack).messages.append({ conversationId, senderType: 'user', kind: 'text', text });
}

describe('L6 / L10: an agent task works where it is leased, and is told so', () => {
  it('a write task without a recorded workdir runs in the workspace, not the unleased project', async () => {
    const { stack, started } = await agentStack({ fake: { turns: [agentTurn().sleep(20)] } });
    const bot = await agentBot(stack, 'fake');
    const conv = await openDirect(stack.core, bot.id);
    const projectPath = await bindProject(stack, conv.id);
    const { runs, messages } = domain(stack);
    // A task row from before workdirs were recorded (task_workdir null).
    const task = runs.create({
      botId: bot.id,
      conversationId: conv.id,
      loopType: 'task',
      triggerReason: null,
      triggerMessageIds: [],
      taskTitle: '旧任务',
      taskWrites: true,
      taskWorkdir: null,
      originRunId: 'run_turn_old',
    });
    messages.appendTaskEvent({
      conversationId: conv.id,
      ownerBotId: bot.id,
      taskId: task.id,
      phase: 'brief',
      text: 'NULL-WORKDIR 改一下',
      sourceMessageIds: [],
      title: '旧任务',
      writes: true,
    });
    tasksOf(stack).resume();
    await waitStatus(stack, task.id, ['completed'], 'null-workdir task completed');
    const cwd = started[0]!.observed.sessions[0]!.cwd;
    expect(cwd).not.toBe(projectPath);
    expect(cwd).toBe(workspaceOf(stack, bot.id, conv.id));
  }, 60_000);

  it('a workspace-workdir task in a project conversation gets no <project> section', async () => {
    const { stack, started } = await agentStack({ fake: { turns: [agentTurn().sleep(20)] } });
    const bot = await agentBot(stack, 'fake');
    const conv = await openDirect(stack.core, bot.id);
    await bindProject(stack, conv.id);
    const source = userMessage(stack, conv.id, '在 workspace 里整理一下');
    const t = tasksOf(stack).start(turnIdentity(bot.id, conv.id), {
      title: '整理',
      instruction: 'WS-TASK 整理',
      sourceMessageIds: [source.id],
      writes: true,
      workdir: 'workspace',
    });
    await waitStatus(stack, t.taskId, ['completed'], 'workspace task completed');
    const prompt = started[0]!.observed.prompts[0]!.text;
    expect(started[0]!.observed.sessions[0]!.cwd).toBe(workspaceOf(stack, bot.id, conv.id));
    expect(prompt).toContain('WS-TASK');
    expect(prompt).not.toContain('<project>');
    expect(prompt).toContain('你的工作目录就是这个 workspace');
  }, 60_000);
});

describe('L8: a crash after the engine run started aborts it first', () => {
  it('the engine handle is aborted before the task settles failed', async () => {
    const { stack } = await agentStack({ fake: { turns: [agentTurn().sleep(3_000)] } });
    const bot = await agentBot(stack, 'fake');
    const conv = await openDirect(stack.core, bot.id);
    const aborted: string[] = [];
    const original = ExternalAgentEngine.prototype.startRun;
    vi.spyOn(ExternalAgentEngine.prototype, 'startRun').mockImplementation(function (
      this: ExternalAgentEngine,
      spec: RunSpec,
    ): RunHandle {
      const handle = original.call(this, spec);
      // Only the task (its failure then wakes a reply run on the same agent).
      if (spec.identity.loopType !== 'task') return handle;
      const abort = handle.abort.bind(handle);
      handle.abort = (reason: string) => {
        aborted.push(reason);
        abort(reason);
      };
      // Wiring the run up fails right after it started.
      handle.onEvent = () => {
        throw new Error('WIRING-FAILED');
      };
      return handle;
    });
    const source = userMessage(stack, conv.id, '查一下');
    const t = tasksOf(stack).start(turnIdentity(bot.id, conv.id), {
      title: '查',
      instruction: 'CRASH-TASK 查',
      sourceMessageIds: [source.id],
      writes: false,
    });
    const failed = await waitStatus(stack, t.taskId, ['failed'], 'crashed task failed');
    expect(failed.error).toContain('WIRING-FAILED');
    expect(aborted).toEqual(['run crashed']);
    await waitFor(() => (tasksOf(stack).isExecuting(t.taskId) ? null : true), {
      label: 'execution released',
    });
  }, 60_000);
});

describe('L1: runs.cancel on a sub run whose parent facade is gone', () => {
  it('never takes the "queued, not started" path (the closing parent settles it)', async () => {
    const stack = await coreStack();
    const bot = await makeBot(stack.core, '小艾');
    const conv = await openDirect(stack.core, bot.id);
    const { runs } = domain(stack);
    // The parent run is closing: its facade left the registry, the sub run unwinds.
    const sub = runs.create({
      botId: bot.id,
      conversationId: conv.id,
      loopType: 'subagent',
      triggerReason: null,
      triggerMessageIds: [],
      parentRunId: 'run_parent_closing',
    });
    runs.update(sub.id, { status: 'running' });
    await stack.core.rpc.call('runs.cancel', { runId: sub.id });
    // Not settled behind the sub run's own unwind (no #settleRun on a sub run).
    expect(runs.getOrThrow(sub.id).status).toBe('running');
  });
});
