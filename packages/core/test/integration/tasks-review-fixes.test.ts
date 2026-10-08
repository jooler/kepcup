import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Bot, Message, Run, TaskEventContent } from '@kepcup/shared';
import {
  agentTurn,
  createTestStack,
  fakeAgentEntry,
  fakeAgentSpawner,
  makeBot,
  openDirect,
  sendBatch,
  step,
  waitFor,
  type FakeAcpAgentHandle,
  type MockChatRequest,
  type TestStack,
} from '@kepcup/testkit';
import { TaskHost, type TaskRunControl, type TaskRunHandle } from '../../src/dispatch/tasks.js';
import type { RunIdentity } from '../../src/agent/types.js';

/**
 * D75 W1 独立审查修复（批 A：任务层 / 调度器 / 编排）：H2 写租约与调度名额
 * 的持有并等待死锁、排队中取消立即释放租约、M1 终态条目写失败不丢结果、
 * M2 收尾期注入如实报 queued、LOW-1 取消条目在恢复时生效、LOW-2 被拒 steer
 * 不提前标记消费、LOW-4 原消息只收共享行、LOW-7 派出时报告真实状态、
 * LOW-8 失败任务可重试（设置卡自动继续）。
 */

const stacks: TestStack[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const stack of stacks.splice(0)) {
    stack.llm.releaseAll();
    await stack.cleanup();
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function start(options: Parameters<typeof createTestStack>[0] = {}): Promise<TestStack> {
  const stack = await createTestStack(options);
  stacks.push(stack);
  return stack;
}

function domain(stack: TestStack) {
  return stack.core.services.domain!;
}

function tasksOf(stack: TestStack) {
  return stack.core.services.orchestrator!.tasks;
}

function turnIdentity(botId: string, conversationId: string, runId = 'run_turn_1'): RunIdentity {
  return { runId, botId, conversationId, loopType: 'turn' };
}

function runOf(stack: TestStack, id: string): Run {
  return domain(stack).runs.getOrThrow(id);
}

function entries(stack: TestStack, taskId: string): TaskEventContent[] {
  return domain(stack)
    .messages.taskEvents(taskId)
    .map((m) => m.content as TaskEventContent);
}

function waitRun(stack: TestStack, id: string, statuses: Run['status'][], label: string) {
  return waitFor(
    () => {
      const run = domain(stack).runs.get(id);
      return run !== null && statuses.includes(run.status) ? run : null;
    },
    { label, timeoutMs: 20_000 },
  );
}

const isTaskRequest = (marker: string) => (req: MockChatRequest) =>
  req.lastUserText().includes('<task_brief') && req.lastUserText().includes(marker);
const isWakeRequest = (req: MockChatRequest) =>
  req.lastUserText().includes('<trigger reason="task"');

function makeProjectDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'tasks-review-project-'));
  dirs.push(dir);
  writeFileSync(path.join(dir, 'README.md'), '# p\n');
  return dir;
}

const quietLogger = { info() {}, warn() {}, error() {}, debug() {} } as never;

/**
 * A TaskHost over the test core's real domain services whose executions are
 * driven by hand (`controls`), and whose wakes are recorded.
 */
function handDrivenHost(stack: TestStack, execute?: (task: Run, control: TaskRunControl) => void) {
  const d = domain(stack);
  const controls = new Map<string, TaskRunControl>();
  const woken: Message[] = [];
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
      execute?.(task, control);
    },
    wake: (_botId, _conversationId, entry) => {
      woken.push(entry);
    },
    resolveWorkdir: () => path.join(tmpdir(), 'tasks-review-ws'),
    onSettled: () => {},
    releaseExecution: () => {},
    recordVisibleMessage: () => {},
  });
  return { host, controls, woken };
}

function fakeHandle(steerOk: boolean): TaskRunHandle & { steered: string[] } {
  const steered: string[] = [];
  return {
    steered,
    steer(text) {
      if (steerOk) steered.push(text);
      return steerOk;
    },
    abort() {},
    tokensSoFar: () => 0,
  };
}

describe('H2: write lease × scheduler slot never deadlock', () => {
  for (const limit of [1, 2]) {
    it(`provider limit ${limit}: a response run waiting for the project lease held by a queued write task`, async () => {
      const stack = await start();
      const { core, llm } = stack;
      await core.rpc.call('settings.update', {
        providerConcurrency: { default: 4, 'custom:mock': limit },
      });
      const botA = await makeBot(core, '甲');
      const botB = await makeBot(core, '乙');
      const convA = await openDirect(core, botA.id);
      const convB = await openDirect(core, botB.id);
      const dir = makeProjectDir();
      const bound = (await core.rpc.call('projects.select', {
        conversationId: convA.id,
        path: dir,
      })) as { project: { path: string } };
      await core.rpc.call('projects.select', { conversationId: convB.id, path: dir });
      const projectPath = bound.project.path;

      const isR = (req: MockChatRequest) => req.lastUserText().includes('R-WRITE');
      const rHeld = step()
        .expect(isR)
        .hold()
        .replyToolCall('acquire_project_write', { reason: 'R 改项目' });
      const isBusy = (req: MockChatRequest) => req.lastUserText().includes('BUSY-H2');
      const busyHeld = step().expect(isBusy).hold().replyText('忙完了');
      llm.script('mock-main', [
        rHeld,
        busyHeld,
        step().expect(isTaskRequest('TASK-H2')).replyText('RESULT-H2 写好了'),
        step().expect(isR).replyText('R 完成'),
        step().expect(isWakeRequest).replyText('任务做完了'),
      ]);

      // R (conversation B) takes the provider slot; its model call is held.
      await sendBatch(core, convB.id, ['R-WRITE 请改一下项目']);
      await waitFor(() => (llm.requestsFor('mock-main').some(isR) ? true : null), {
        label: 'R holds a slot',
      });
      const rRun = await waitFor(
        () =>
          domain(stack)
            .runs.listByConversation(convB.id, 10)
            .find((run) => run.loopType === 'turn') ?? null,
        { label: 'R run' },
      );
      // Every other slot is taken too (a write task holding its lease starts
      // under the plain limit, 审查复核 #4).
      for (let i = 1; i < limit; i += 1) {
        const busy = await openDirect(core, (await makeBot(core, `忙${i}`)).id);
        await sendBatch(core, busy.id, ['BUSY-H2 占名额']);
      }
      await waitFor(
        () => (llm.requestsFor('mock-main').filter(isBusy).length === limit - 1 ? true : null),
        { label: 'all slots taken' },
      );

      // T (conversation A): write task on the same project — takes the lease,
      // then queues for a slot (none free).
      const t = tasksOf(stack).start(turnIdentity(botA.id, convA.id), {
        title: '改项目',
        instruction: 'TASK-H2 改 README',
        sourceMessageIds: [],
        writes: true,
        workdir: 'project',
      });
      expect(t.state).toBe('submitted');
      const tIdentity: RunIdentity = {
        runId: t.taskId,
        botId: botA.id,
        conversationId: convA.id,
        loopType: 'task',
      };
      const runtime = core.services.projectRuntime!;
      await waitFor(() => (runtime.holdsLease(tIdentity, projectPath) ? true : null), {
        label: 'T holds the project lease',
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(runOf(stack, t.taskId).status).toBe('queued'); // waiting for a slot
      expect(llm.requests().some(isTaskRequest('TASK-H2'))).toBe(false);

      // R now asks for the lease T holds: R must give its slot back to T.
      rHeld.release();
      // T runs in the slot R gave back (the other slots stay busy meanwhile).
      const tDone = await waitRun(stack, t.taskId, ['completed'], 'T completed');
      busyHeld.release();
      const rDone = await waitRun(stack, rRun.id, ['completed'], 'R completed');
      expect(entries(stack, t.taskId).at(-1)).toMatchObject({ phase: 'result' });
      // R got the lease only after T released it.
      expect(rDone.endedAt ?? 0).toBeGreaterThanOrEqual(tDone.endedAt ?? Infinity);
    }, 60_000);
  }

  it('a write task cancelled while queued for a slot releases its lease at once', async () => {
    const stack = await start();
    const { core, llm } = stack;
    await core.rpc.call('settings.update', {
      providerConcurrency: { default: 4, 'custom:mock': 1 },
    });
    const bot = await makeBot(core, '甲');
    const conv = await openDirect(core, bot.id);
    const other = await openDirect(core, (await makeBot(core, '乙')).id);
    const held = step()
      .expect((req) => req.lastUserText().includes('BUSY'))
      .hold()
      .replyText('忙完了');
    llm.script('mock-main', [held]);
    await sendBatch(core, other.id, ['BUSY 占住名额']);
    await waitFor(() => (llm.requests().length >= 1 ? true : null), { label: 'slot taken' });

    const t = tasksOf(stack).start(turnIdentity(bot.id, conv.id), {
      title: '写',
      instruction: 'TASK-CQ',
      sourceMessageIds: [],
      writes: true,
    });
    const workspaceKey = `ws:${bot.id}:${conv.id}`;
    const runtime = core.services.projectRuntime!;
    const identity: RunIdentity = {
      runId: t.taskId,
      botId: bot.id,
      conversationId: conv.id,
      loopType: 'task',
    };
    const reasonOf = (taskId: string) =>
      tasksOf(stack)
        .list(turnIdentity(bot.id, conv.id))
        .find((summary) => summary.taskId === taskId)?.queueReason ?? null;
    // Lease granted, now queued in the scheduler for the provider slot.
    await waitFor(() => (reasonOf(t.taskId) === '等模型并发额度' ? true : null), {
      label: 'T queued for a slot',
    });
    expect(runtime.holdsLease(identity, workspaceKey)).toBe(true);
    expect(core.services.scheduler!.pendingForKey(`task:${t.taskId}`)).toBe(1);

    tasksOf(stack).cancelById(t.taskId, '用户取消');
    expect(runOf(stack, t.taskId).status).toBe('cancelled');
    // Released at once — not when the job would have reached a slot.
    expect(runtime.holdsLease(identity, workspaceKey)).toBe(false);
    expect(core.services.scheduler!.pendingForKey(`task:${t.taskId}`)).toBe(0);
    await waitFor(() => (tasksOf(stack).launchedCount() === 0 ? true : null), {
      label: 'launch freed',
    });
    held.release();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(llm.requests().some(isTaskRequest('TASK-CQ'))).toBe(false);
  }, 60_000);
});

describe('M1: a failed terminal-entry write never loses the result', () => {
  it('keeps the task non-terminal and unconsumed, and the sweep settles it once the write works', async () => {
    const stack = await start();
    const bot = await makeBot(stack.core, '小艾');
    const conv = await openDirect(stack.core, bot.id);
    const { host, controls, woken } = handDrivenHost(stack);
    const started = host.start(turnIdentity(bot.id, conv.id), {
      title: '结果写失败',
      instruction: '做点事',
      sourceMessageIds: [],
      writes: false,
    });
    const control = controls.get(started.taskId)!;
    control.brief();
    control.attach(fakeHandle(true));

    const messages = domain(stack).messages;
    const original = messages.appendTaskEvent.bind(messages);
    let failing = true;
    messages.appendTaskEvent = (input) => {
      if (failing && input.phase === 'result') throw new Error('SQLITE_BUSY: database is locked');
      return original(input);
    };
    try {
      control.detach();
      host.settle(started.taskId, { status: 'completed', resultText: 'RESULT-M1 珍贵的结果' });
      control.finish();
      const pending = runOf(stack, started.taskId);
      expect(pending.status).not.toBe('completed');
      expect(pending.resultConsumedAt).toBeNull();
      expect(messages.terminalTaskEvent(started.taskId)).toBeNull();
      expect(woken).toHaveLength(0);
      // Still failing: the sweep retries and keeps it pending.
      host.sweep();
      expect(runOf(stack, started.taskId).status).not.toBe('completed');

      failing = false;
      host.sweep();
    } finally {
      messages.appendTaskEvent = original;
    }
    const settled = runOf(stack, started.taskId);
    expect(settled.status).toBe('completed');
    expect(entries(stack, started.taskId).at(-1)).toMatchObject({
      phase: 'result',
      text: 'RESULT-M1 珍贵的结果',
    });
    expect(woken.map((entry) => entry.taskId)).toEqual([started.taskId]);
    expect(settled.resultConsumedAt).toBeNull(); // awaits the consuming turn
  });
});

describe('M2: injects that cannot reach the execution report queued', () => {
  it('after the engine run ended (detach) inject returns queued, not a silent delivered', async () => {
    const stack = await start();
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
    const handle = fakeHandle(true);
    control.attach(handle);
    expect(host.inject(identity, { taskId: started.taskId, text: '早一点的指令' })).toEqual({
      delivery: 'delivered',
    });
    control.detach(); // engine run over; the executor is still releasing / settling
    expect(host.inject(identity, { taskId: started.taskId, text: '晚到的指令' })).toEqual({
      delivery: 'queued',
    });
    expect(handle.steered).toHaveLength(1);
    const injects = entries(stack, started.taskId).filter((e) => e.phase === 'inject');
    expect(injects.map((e) => e.delivery)).toEqual(['delivered', 'queued']);
    host.settle(started.taskId, { status: 'completed', resultText: '' });
    control.finish();
  });

  it('a buffered inject the engine refuses at attach is downgraded to queued on its entry', async () => {
    const stack = await start();
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
    control.brief(); // brief built: later injects are buffered until attach
    expect(host.inject(identity, { taskId: started.taskId, text: '缓冲的指令' })).toEqual({
      delivery: 'delivered',
    });
    control.attach(fakeHandle(false));
    const injects = entries(stack, started.taskId).filter((e) => e.phase === 'inject');
    expect(injects.map((e) => e.delivery)).toEqual(['queued']);
    control.detach();
    host.settle(started.taskId, { status: 'completed', resultText: '' });
    control.finish();
  });
});

describe('LOW-1: a recorded cancel wins over recovery', () => {
  it('a task with a cancel entry but no terminal entry recovers as cancelled, never re-launched or woken', async () => {
    const stack = await start();
    const bot = await makeBot(stack.core, '小艾');
    const conv = await openDirect(stack.core, bot.id);
    const { runs, messages } = domain(stack);
    const seed = (status: Run['status']) => {
      const task = runs.create({
        botId: bot.id,
        conversationId: conv.id,
        loopType: 'task',
        triggerReason: null,
        triggerMessageIds: [],
        taskTitle: `crash-${status}`,
        taskWrites: false,
        originRunId: 'run_turn_old',
      });
      const scope = { conversationId: conv.id, ownerBotId: bot.id, taskId: task.id };
      messages.appendTaskEvent({ ...scope, phase: 'brief', text: 'x', title: 'x', writes: false });
      // Crashed between the cancel entry and the settlement.
      messages.appendTaskEvent({ ...scope, phase: 'cancel', text: '用户改主意了' });
      return status === 'queued' ? task : runs.update(task.id, { status });
    };
    const queued = seed('queued');
    const running = seed('running');
    const { host, controls, woken } = handDrivenHost(stack);
    host.recover();
    host.resume();
    for (const task of [queued, running]) {
      const after = runOf(stack, task.id);
      expect(after.status).toBe('cancelled');
      expect(after.resultConsumedAt).not.toBeNull();
      expect(entries(stack, task.id).map((e) => e.phase)).toEqual(['brief', 'cancel', 'failure']);
      expect(entries(stack, task.id).at(-1)).toMatchObject({ status: 'cancelled' });
    }
    expect(controls.size).toBe(0); // nothing re-launched
    expect(woken).toHaveLength(0);
  });
});

describe('LOW-4 / LOW-7: source messages and the reported start state', () => {
  it('rejects a private task entry as a source message', async () => {
    const stack = await start();
    const bot = await makeBot(stack.core, '小艾');
    const conv = await openDirect(stack.core, bot.id);
    const { host } = handDrivenHost(stack);
    const identity = turnIdentity(bot.id, conv.id);
    const first = host.start(identity, {
      title: 't',
      instruction: 'i',
      sourceMessageIds: [],
      writes: false,
    });
    const brief = domain(stack).messages.taskEvents(first.taskId)[0]!;
    expect(brief.ownerBotId).toBe(bot.id);
    expect(() =>
      host.start(identity, {
        title: 't2',
        instruction: 'i2',
        sourceMessageIds: [brief.id],
        writes: false,
      }),
    ).toThrow(/私有条目/);
    expect(() =>
      host.inject(identity, { taskId: first.taskId, text: 'x', sourceMessageIds: [brief.id] }),
    ).toThrow(/私有条目/);
  });

  it('reports submitted with the wait reason while launched-but-waiting, and the terminal state when settled at once', async () => {
    const stack = await start();
    const bot = await makeBot(stack.core, '小艾');
    const conv = await openDirect(stack.core, bot.id);
    let failNext = false;
    const { host } = handDrivenHost(stack, (_task, control) => {
      if (failNext) throw new Error('engine unavailable');
      control.waiting('等写入租约');
    });
    const identity = turnIdentity(bot.id, conv.id);
    const waiting = host.start(identity, {
      title: 'w',
      instruction: 'i',
      sourceMessageIds: [],
      writes: true,
    });
    expect(waiting).toMatchObject({ state: 'submitted', queueReason: '等写入租约' });
    failNext = true;
    const failed = host.start(turnIdentity(bot.id, conv.id, 'run_turn_2'), {
      title: 'f',
      instruction: 'i',
      sourceMessageIds: [],
      writes: false,
    });
    expect(failed).toMatchObject({ state: 'failed', queueReason: null });
  });
});

describe('LOW-8: a failed task can be retried (setup card auto-continue, design 30 §7.5)', () => {
  it('runs.retry starts a task continuing the failed one with the same brief; a second retry returns it', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const bot = await makeBot(core, '小艾');
    const conv = await openDirect(core, bot.id);
    const source = domain(stack).messages.append({
      conversationId: conv.id,
      senderType: 'user',
      kind: 'text',
      text: 'SRC-RETRY 帮我画张图',
    });
    llm.script('mock-main', [
      step().expect(isTaskRequest('TASK-RETRY')).failWith(401, 'Incorrect API key provided'),
      step().expect(isWakeRequest).replyText('任务失败了，我设置好再试'),
      step().expect(isTaskRequest('OTHER-TASK')).replyToolCall('skip_reply', { reason: 'x' }),
      step().expect(isTaskRequest('TASK-RETRY')).replyText('RESULT-RETRY 画好了'),
      step().expect(isWakeRequest).replyText('画好了'),
    ]);
    const identity = turnIdentity(bot.id, conv.id, 'run_turn_origin');
    const tasks = tasksOf(stack);
    const first = tasks.start(identity, {
      title: '画图',
      instruction: 'TASK-RETRY 画一张猫',
      sourceMessageIds: [source.id],
      writes: false,
    });
    tasks.start(identity, {
      title: '另一个',
      instruction: 'OTHER-TASK',
      sourceMessageIds: [],
      writes: false,
    });
    await waitRun(stack, first.taskId, ['failed'], 'first attempt failed');

    // The per-turn cap (2) is reached for this turn; the retry is not a new dispatch.
    const retried = (await core.rpc.call('runs.retry', { runId: first.taskId })) as { run: Run };
    expect(retried.run.id).not.toBe(first.taskId);
    expect(retried.run).toMatchObject({
      loopType: 'task',
      originRunId: 'run_turn_origin',
      continuedFromRunIds: [first.taskId],
      taskTitle: '画图',
      triggerMessageIds: [source.id],
    });
    expect(entries(stack, retried.run.id)[0]).toMatchObject({
      phase: 'brief',
      text: 'TASK-RETRY 画一张猫',
      sourceMessageIds: [source.id],
      continuesTaskId: first.taskId,
    });
    const again = (await core.rpc.call('runs.retry', { runId: first.taskId })) as { run: Run };
    expect(again.run.id).toBe(retried.run.id);
    await waitRun(stack, retried.run.id, ['completed'], 'retried task completed');
    expect(entries(stack, retried.run.id).at(-1)).toMatchObject({
      phase: 'result',
      text: 'RESULT-RETRY 画好了',
    });
  }, 60_000);
});

describe('LOW-2: a refused steer carrying a task result is not consumed early', () => {
  it('the result counts as consumed only by the run that re-delivers it', async () => {
    const entry = fakeAgentEntry('fake-steer', { provider: 'claude' });
    const started: FakeAcpAgentHandle[] = [];
    const stack = await start({
      agentCatalog: [entry],
      agentLaunch: () => ({ command: 'in-process', args: [], env: {} }),
      agentSpawn: fakeAgentSpawner(
        {
          'fake-steer': {
            steering: true,
            steeringOutcome: 'promptRequired',
            modes: {
              currentModeId: 'default',
              availableModes: [
                { id: 'default', name: 'Default' },
                { id: 'acceptEdits', name: 'Accept Edits' },
              ],
            },
            turns: [agentTurn().sleep(800).text('先答第一条'), agentTurn().text('知道任务失败了')],
          },
        },
        started,
      ) as never,
    });
    const { core } = stack;
    await core.rpc.call('settings.update', {
      experimental: { externalAgents: true },
      agents: { 'fake-steer': { enabled: true } },
    });
    const plain = await makeBot(core, '外援');
    const profile = {
      ...plain.profile,
      runtime: { ...plain.profile.runtime, agent: { ...plain.profile.runtime.agent, id: 'fake-steer' } },
    };
    const bot = ((await core.rpc.call('bots.update', { id: plain.id, profile })) as { bot: Bot }).bot;
    const conv = await openDirect(core, bot.id);
    await sendBatch(core, conv.id, ['第一条']);
    await waitFor(() => (started[0]?.observed.prompts.length === 1 ? true : null), {
      label: 'first prompt',
    });
    // A task settled (failed) but unconsumed: the reconciliation wakes the bot
    // with its failure entry while the agent run is busy → steered into it →
    // the agent refuses the steer.
    const { runs, messages } = domain(stack);
    const task = runs.create({
      botId: bot.id,
      conversationId: conv.id,
      loopType: 'task',
      triggerReason: null,
      triggerMessageIds: [],
      taskTitle: '外部任务',
      taskWrites: false,
      originRunId: 'run_turn_old',
    });
    const scope = { conversationId: conv.id, ownerBotId: bot.id, taskId: task.id };
    messages.appendTaskEvent({ ...scope, phase: 'brief', text: 'x', title: 'x', writes: false });
    messages.appendTaskEvent({
      ...scope,
      phase: 'failure',
      text: '任务失败：TASK-EXT-FAILED',
      status: 'failed',
      error: 'TASK-EXT-FAILED',
    });
    runs.update(task.id, { status: 'failed', error: 'TASK-EXT-FAILED' });
    tasksOf(stack).sweep();
    await waitFor(() => (started[0]!.observed.steerings.length === 1 ? true : null), {
      label: 'steering attempted',
    });
    const responses = await waitFor(
      () => {
        const done = runs
          .listByConversation(conv.id, 20)
          .filter((run) => run.loopType === 'turn' && run.status === 'completed')
          .sort((a, b) => a.createdAt - b.createdAt);
        return done.length >= 2 ? done : null;
      },
      { label: 'two completed response runs', timeoutMs: 20_000 },
    );
    const consumedAt = await waitFor(() => runOf(stack, task.id).resultConsumedAt, {
      label: 'task result consumed',
    });
    const redelivery = responses[1]!;
    expect(started[0]!.observed.prompts[1]!.text).toContain('TASK-EXT-FAILED');
    // Consumed by the re-delivering run's release — not by the first run's.
    expect(consumedAt).toBeGreaterThanOrEqual(redelivery.endedAt ?? Infinity);
  }, 60_000);
});

describe('round 2 (审查复核)', () => {
  it('#1 two parallel write acquisitions of one run on a contested project both succeed after the holder releases', async () => {
    const stack = await start();
    const { core } = stack;
    const bot = await makeBot(core, '甲');
    const conv = await openDirect(core, bot.id);
    const otherBot = await makeBot(core, '乙');
    const other = await openDirect(core, otherBot.id);
    const dir = makeProjectDir();
    const bound = (await core.rpc.call('projects.select', { conversationId: conv.id, path: dir })) as {
      project: { path: string };
    };
    await core.rpc.call('projects.select', { conversationId: other.id, path: dir });
    const projectPath = bound.project.path;
    const { runs } = domain(stack);
    const runFor = (botId: string, conversationId: string): RunIdentity => {
      const run = runs.create({
        botId,
        conversationId,
        loopType: 'turn',
        triggerReason: 'direct',
        triggerMessageIds: [],
      });
      runs.update(run.id, { status: 'running' });
      return { runId: run.id, botId, conversationId, loopType: 'turn' };
    };
    const runtime = core.services.projectRuntime!;
    const holder = runFor(otherBot.id, other.id);
    await runtime.ensureWriteLease(holder, path.join(projectPath, 'h.txt'));
    const writer = runFor(bot.id, conv.id);
    // Two parallel write / edit tool calls of one run (gateway → ensureWriteLease).
    const first = runtime.ensureWriteLease(writer, path.join(projectPath, 'a.txt'));
    const second = runtime.ensureWriteLease(writer, path.join(projectPath, 'b.txt'));
    const settled = Promise.allSettled([first, second]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await runtime.releaseRun(holder.runId);
    const results = await settled;
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(runtime.holdsLease(writer, projectPath)).toBe(true);
    await runtime.releaseRun(writer.runId);
  }, 60_000);

  it('#2 a stopped queued task whose settlement is pending is never launched again', async () => {
    const stack = await start();
    const { core, llm } = stack;
    await core.rpc.call('settings.update', {
      providerConcurrency: { default: 4, 'custom:mock': 1 },
    });
    const bot = await makeBot(core, '甲');
    const conv = await openDirect(core, bot.id);
    const other = await openDirect(core, (await makeBot(core, '乙')).id);
    const held = step()
      .expect((req) => req.lastUserText().includes('BUSY'))
      .hold()
      .replyText('忙完了');
    llm.script('mock-main', [held]);
    await sendBatch(core, other.id, ['BUSY 占住名额']);
    await waitFor(() => (llm.requests().length >= 1 ? true : null), { label: 'slot taken' });

    const tasks = tasksOf(stack);
    const t = tasks.start(turnIdentity(bot.id, conv.id), {
      title: '只读',
      instruction: 'TASK-UNSETTLED',
      sourceMessageIds: [],
      writes: false,
    });
    expect(t).toMatchObject({ state: 'submitted', queueReason: '等模型并发额度' });

    const messages = domain(stack).messages;
    const original = messages.appendTaskEvent.bind(messages);
    let failing = true;
    messages.appendTaskEvent = (input) => {
      if (failing && input.phase === 'failure') throw new Error('SQLITE_BUSY: database is locked');
      return original(input);
    };
    try {
      tasks.cancelById(t.taskId, '用户取消');
      expect(runOf(stack, t.taskId).status).toBe('queued'); // settlement pending (M1)
      await waitFor(() => (tasks.launchedCount() === 0 ? true : null), { label: 'launch freed' });
      // The slot frees: nothing may start the stopped task.
      held.release();
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(llm.requests().some(isTaskRequest('TASK-UNSETTLED'))).toBe(false);
      expect(tasks.launchedCount()).toBe(0);
      expect(core.services.scheduler!.pendingForKey(`task:${t.taskId}`)).toBe(0);
      failing = false;
      tasks.sweep();
    } finally {
      messages.appendTaskEvent = original;
    }
    expect(runOf(stack, t.taskId).status).toBe('cancelled');
    expect(entries(stack, t.taskId).map((e) => e.phase)).toEqual(['brief', 'cancel', 'failure']);
  }, 60_000);

  it('#8 recovery writes the entry first: a failed entry write leaves the task pending, not terminal', async () => {
    const stack = await start();
    const bot = await makeBot(stack.core, '小艾');
    const conv = await openDirect(stack.core, bot.id);
    const { runs, messages } = domain(stack);
    const task = runs.create({
      botId: bot.id,
      conversationId: conv.id,
      loopType: 'task',
      triggerReason: null,
      triggerMessageIds: [],
      taskTitle: 'crash',
      taskWrites: false,
      originRunId: 'run_turn_old',
    });
    const scope = { conversationId: conv.id, ownerBotId: bot.id, taskId: task.id };
    messages.appendTaskEvent({ ...scope, phase: 'brief', text: 'x', title: 'x', writes: false });
    messages.appendTaskEvent({ ...scope, phase: 'cancel', text: '不要了' });
    const { host, controls, woken } = handDrivenHost(stack);
    const original = messages.appendTaskEvent.bind(messages);
    let failing = true;
    messages.appendTaskEvent = (input) => {
      if (failing && input.phase === 'failure') throw new Error('SQLITE_BUSY: database is locked');
      return original(input);
    };
    try {
      host.recover();
      host.resume();
      expect(runOf(stack, task.id).status).toBe('queued'); // no terminal without its entry
      expect(controls.size).toBe(0); // and not re-launched
      failing = false;
      host.sweep();
    } finally {
      messages.appendTaskEvent = original;
    }
    expect(runOf(stack, task.id).status).toBe('cancelled');
    expect(runOf(stack, task.id).resultConsumedAt).not.toBeNull();
    expect(entries(stack, task.id).map((e) => e.phase)).toEqual(['brief', 'cancel', 'failure']);
    expect(woken).toHaveLength(0);
  });
});
