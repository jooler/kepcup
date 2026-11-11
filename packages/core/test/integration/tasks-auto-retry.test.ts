import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  TASK_AUTO_RETRY_DELAYS_MS,
  TASK_SETTLE_SWEEP_MS,
  type Run,
  type TaskEventContent,
} from '@kepcup/shared';
import {
  createTestCore,
  createTestStack,
  makeBot,
  openDirect,
  startMockLlm,
  step,
  TestClock,
  waitFor,
  type CoreHarness,
  type MockChatRequest,
  type TestStack,
} from '@kepcup/testkit';
import { createMemoryKeystore } from '@kepcup/core';

/**
 * 任务失败自动重试（TASK_AUTO_RETRY_DELAYS_MS）：failed 且缺 setup 的任务回
 * `queued` 按档位退避重试（1/2/3/5/8/13/21/34 分钟，共 8 次重试 + 首跑 9 次
 * 执行），对用户静默；用尽档位才结算（failure 条目 + 唤醒）。缺 setup /
 * interrupted / cancelled 不重试；退避计划持久化在 runs 行上，重启后照常推进。
 * 失败驱动用 mock 模型的 length 截断（finish_reason=length 使 run 失败）。
 */

const stacks: TestStack[] = [];

function start(options: Parameters<typeof createTestStack>[0] = {}): Promise<TestStack> {
  return createTestStack(options).then((stack) => {
    stacks.push(stack);
    return stack;
  });
}

function domain(stack: { core: CoreHarness }) {
  return stack.core.services.domain!;
}

function tasksOf(stack: { core: CoreHarness }) {
  return stack.core.services.orchestrator!.tasks;
}

function runOf(stack: { core: CoreHarness }, id: string): Run {
  return domain(stack).runs.getOrThrow(id);
}

function entries(stack: { core: CoreHarness }, taskId: string): TaskEventContent[] {
  return domain(stack)
    .messages.taskEvents(taskId)
    .map((m) => m.content as TaskEventContent);
}

function wakeRuns(stack: { core: CoreHarness }, conversationId: string): Run[] {
  return domain(stack)
    .runs.listByConversation(conversationId, 50)
    .filter((r) => r.loopType === 'turn' && r.triggerReason === 'task');
}

function turnIdentity(botId: string, conversationId: string, runId = 'run_turn_1') {
  return { runId, botId, conversationId, loopType: 'turn' as const };
}

/** 等到任务完成第 N 次失败（task_retry_attempts === N，已进入退避）。 */
function waitAttempts(stack: { core: CoreHarness }, id: string, n: number) {
  return waitFor(
    () => {
      const run = domain(stack).runs.get(id);
      return run !== null && run.taskRetryAttempts === n ? run : null;
    },
    { label: `task retry attempt ${n}`, timeoutMs: 15_000 },
  );
}

const isTaskRequest = (marker: string) => (req: MockChatRequest) =>
  req.lastUserText().includes('<task_brief') && req.lastUserText().includes(marker);
const isWakeRequest = (req: MockChatRequest) =>
  req.lastUserText().includes('<trigger reason="task"');

afterEach(async () => {
  for (const stack of stacks.splice(0)) {
    stack.llm.releaseAll();
    await stack.cleanup();
  }
});

describe('任务失败自动重试（TASK_AUTO_RETRY_DELAYS_MS）', () => {
  it('首次失败回 queued 退避（无 failure 条目、不唤醒），逐档重试，第 9 次执行失败才结算唤醒', async () => {
    const clock = new TestClock();
    const stack = await start({
      clock,
      timers: clock,
      taskAutoRetryDelaysMs: TASK_AUTO_RETRY_DELAYS_MS,
    });
    const { core, llm } = stack;
    const bot = await makeBot(core, '小艾');
    const conv = await openDirect(core, bot.id);
    // 首跑 + 8 次重试全部 length 截断失败；最后一次失败唤醒 Bot 播报。
    llm.script('mock-main', [
      ...Array.from({ length: 9 }, () =>
        step().expect(isTaskRequest('TASK-RETRY')).replyFinish('length', '写到一半'),
      ),
      step().expect(isWakeRequest).replyText('重试了 8 次仍然失败'),
      step().replyText('收到'),
    ]);

    const started = tasksOf(stack).start(turnIdentity(bot.id, conv.id), {
      title: '总失败',
      instruction: 'TASK-RETRY',
      sourceMessageIds: [],
      writes: false,
    });

    // 首次失败：不结算——状态回 queued，attempts=1，下一档 1 分钟后。
    const first = await waitAttempts(stack, started.taskId, 1);
    expect(first.status).toBe('queued');
    expect(first.taskRetryAt).toBe(clock.now() + TASK_AUTO_RETRY_DELAYS_MS[0]);
    // 对用户静默：只有 brief 条目，没有任何唤醒轮。
    expect(entries(stack, started.taskId).map((e) => e.phase)).toEqual(['brief']);
    expect(wakeRuns(stack, conv.id)).toEqual([]);
    // 任务卡状态行走「排队中：{queueReason}」展示重试中（无新前端契约）。
    expect(tasksOf(stack).view(started.taskId)?.queueReason).toContain('自动重试');

    // 逐档推进（sweep 的 #pump 读持久化的 task_retry_at 到点启动）。
    for (let attempt = 2; attempt <= 8; attempt += 1) {
      clock.advance(TASK_AUTO_RETRY_DELAYS_MS[attempt - 2]! + 1_000);
      tasksOf(stack).sweep();
      const retried = await waitAttempts(stack, started.taskId, attempt);
      expect(retried.status).toBe('queued');
      expect(retried.taskRetryAt).toBe(clock.now() + TASK_AUTO_RETRY_DELAYS_MS[attempt - 1]);
    }
    // 中间全程静默。
    expect(entries(stack, started.taskId).map((e) => e.phase)).toEqual(['brief']);
    expect(wakeRuns(stack, conv.id)).toEqual([]);

    // 第 8 次重试（第 9 次执行）仍失败：最终结算 + 唤醒。
    clock.advance(TASK_AUTO_RETRY_DELAYS_MS[7]! + 1_000);
    tasksOf(stack).sweep();
    const settled = await waitFor(
      () => {
        const run = domain(stack).runs.get(started.taskId);
        return run !== null && run.status === 'failed' ? run : null;
      },
      { label: 'final failure settled', timeoutMs: 15_000 },
    );
    expect(settled.taskRetryAttempts).toBe(8);
    expect(entries(stack, started.taskId).map((e) => e.phase)).toEqual(['brief', 'failure']);
    const failureEntry = domain(stack).messages.terminalTaskEvent(started.taskId)!;
    expect(failureEntry.content).toMatchObject({ status: 'failed' });
    expect((failureEntry.content as TaskEventContent).text).toContain('已自动重试 8 次');
    const wake = await waitFor(
      () =>
        wakeRuns(stack, conv.id).find(
          (r) => r.triggerMessageIds[0] === failureEntry.id && r.status === 'completed',
        ) ?? null,
      { label: 'final failure wake run', timeoutMs: 15_000 },
    );
    expect(wake.triggerMessageIds).toEqual([failureEntry.id]);
  }, 30_000);

  it('缺 setup 的失败与 interrupted 不自动重试，立即结算', async () => {
    const clock = new TestClock();
    const stack = await start({
      clock,
      timers: clock,
      taskAutoRetryDelaysMs: TASK_AUTO_RETRY_DELAYS_MS,
    });
    const { core, llm } = stack;
    const bot = await makeBot(core, '小设');
    const conv = await openDirect(core, bot.id);
    llm.script('mock-main', [
      step().expect(isTaskRequest('TASK-SETUP')).hold().replyText('不会到达'),
      step().expect(isTaskRequest('TASK-STOP')).hold().replyText('不会到达'),
    ]);

    const setupTask = tasksOf(stack)
      .start(turnIdentity(bot.id, conv.id, 'run_turn_1'), {
        title: '缺设置',
        instruction: 'TASK-SETUP',
        sourceMessageIds: [],
        writes: false,
      })
      .taskId!;
    const stopTask = tasksOf(stack)
      .start(turnIdentity(bot.id, conv.id, 'run_turn_1'), {
        title: '被中断',
        instruction: 'TASK-STOP',
        sourceMessageIds: [],
        writes: false,
      })
      .taskId!;
    await waitFor(() => (llm.requestsFor('mock-main').length >= 2 ? true : null), {
      label: 'both tasks held',
    });

    // 缺 setup 的失败：正常结算（设置卡接管续跑），不进重试。
    tasksOf(stack).settle(setupTask, {
      status: 'failed',
      error: '需要先绑定邮箱',
      setup: { kind: 'mail-account', reason: '需要绑定邮箱' },
    });
    const afterSetup = runOf(stack, setupTask);
    expect(afterSetup.status).toBe('failed');
    expect(afterSetup.taskRetryAttempts ?? 0).toBe(0);
    expect(entries(stack, setupTask).map((e) => e.phase)).toEqual(['brief', 'failure']);

    // interrupted（应用退出 / 授权撤销等）：永不自动重试。
    tasksOf(stack).settle(stopTask, { status: 'interrupted', error: '应用退出，任务中断' });
    const afterStop = runOf(stack, stopTask);
    expect(afterStop.status).toBe('interrupted');
    expect(afterStop.taskRetryAttempts ?? 0).toBe(0);
    // 退避时段过去后两者保持终态，不被重新拉起。
    clock.advance(60 * 60_000);
    tasksOf(stack).sweep();
    expect(runOf(stack, setupTask).status).toBe('failed');
    expect(runOf(stack, stopTask).status).toBe('interrupted');
    llm.releaseAll();
  }, 30_000);

  it('退避等待期取消任务 → cancelled，不再重试', async () => {
    const clock = new TestClock();
    const stack = await start({
      clock,
      timers: clock,
      taskAutoRetryDelaysMs: TASK_AUTO_RETRY_DELAYS_MS,
    });
    const { core, llm } = stack;
    const bot = await makeBot(core, '小取');
    const conv = await openDirect(core, bot.id);
    llm.script('mock-main', [
      step().expect(isTaskRequest('TASK-CANCEL')).replyFinish('length', '写到一半'),
      step().expect(isWakeRequest).replyText('好的，已取消'),
    ]);

    const started = tasksOf(stack).start(turnIdentity(bot.id, conv.id), {
      title: '要取消',
      instruction: 'TASK-CANCEL',
      sourceMessageIds: [],
      writes: false,
    });
    await waitAttempts(stack, started.taskId, 1);

    tasksOf(stack).cancelById(started.taskId, '用户从任务卡取消', { userInitiated: true });
    expect(runOf(stack, started.taskId).status).toBe('cancelled');
    // 退避到点也不再启动：终态任务不在 queued 列表里。
    clock.advance(TASK_AUTO_RETRY_DELAYS_MS[0]! + 60_000);
    tasksOf(stack).sweep();
    const run = runOf(stack, started.taskId);
    expect(run.status).toBe('cancelled');
    expect(run.taskRetryAttempts).toBe(1);
  }, 30_000);

  it('宿主强制失败（stall）也入重试：unwind 的 cancelled 报告被吞，退避照常推进', async () => {
    const clock = new TestClock();
    const stack = await start({
      clock,
      timers: clock,
      taskAutoRetryDelaysMs: TASK_AUTO_RETRY_DELAYS_MS,
    });
    const { core, llm } = stack;
    const bot = await makeBot(core, '小僵');
    const conv = await openDirect(core, bot.id);
    llm.script('mock-main', [
      step().expect(isTaskRequest('TASK-STALL-RETRY')).hold().replyText('不会到达'),
      step().expect(isTaskRequest('TASK-STALL-RETRY')).replyFinish('length', '又失败'),
    ]);
    // D93：把无活动看门狗降到合法最小档（10 分钟；schema 对 <10 静默回退默认
    // 20 分钟）、关闭总时长上限（只测 stall 强制失败路径）。
    const current = domain(stack).settings.get();
    domain(stack).settings.update({
      taskLoop: { ...current.taskLoop, stallTimeoutMinutes: 10, maxWallMinutes: 0 },
    });
    const started = tasksOf(stack).start(turnIdentity(bot.id, conv.id), {
      title: '卡住后重试',
      instruction: 'TASK-STALL-RETRY',
      sourceMessageIds: [],
      writes: false,
    });
    await waitFor(() => (llm.requestsFor('mock-main').length >= 1 ? true : null), {
      label: 'task request held',
    });

    // reaper 越过 stall 超时强制失败：宿主决定重试（入账，行保持 running——
    // 与既有 wall-timeout 用例一致，挂死的执行不会自己 unwind）。
    tasksOf(stack).sweep(clock.now() + 11 * 60_000);
    expect(runOf(stack, started.taskId).status).toBe('running');
    // 驱逐挂死执行体（settledAt + 60s）→ 同一轮 sweep 的兜底兑现退避 requeue。
    clock.advance(TASK_SETTLE_SWEEP_MS + 1_000);
    tasksOf(stack).sweep();
    const requeued = await waitAttempts(stack, started.taskId, 1);
    expect(requeued.status).toBe('queued');
    expect(requeued.taskRetryAt).toBe(clock.now() + TASK_AUTO_RETRY_DELAYS_MS[0]);
    expect(requeued.errorReason).toBe('stalled');
    expect(entries(stack, started.taskId).map((e) => e.phase)).toEqual(['brief']);
    expect(wakeRuns(stack, conv.id)).toEqual([]);
    // 释放挂死的模型请求：迟到的 unwind cancelled 报告被 queued + task_retry_at
    // 闸吞掉，不破坏退避计划。
    llm.releaseAll();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // 退避到点重跑：再次失败继续入账（第 2 档），依旧静默。
    clock.advance(TASK_AUTO_RETRY_DELAYS_MS[0]! + 60_000);
    tasksOf(stack).sweep();
    const second = await waitAttempts(stack, started.taskId, 2);
    expect(second.status).toBe('queued');
    expect(entries(stack, started.taskId).map((e) => e.phase)).toEqual(['brief']);
  }, 30_000);

  it('重启恢复：退避中的任务按持久化的 task_retry_at 推进，到点重试', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'kepcup-tasks-retry-'));
    const keystore = createMemoryKeystore();
    try {
      const clock = new TestClock();
      const firstLlm = await startMockLlm();
      const first = await createTestCore({
        home,
        keystore,
        clock,
        timers: clock,
        env: { KEPCUP_MOCK_LLM_URL: firstLlm.url },
        taskAutoRetryDelaysMs: TASK_AUTO_RETRY_DELAYS_MS,
      });
      let taskId: string;
      let convId: string;
      let retryAt: number;
      try {
        const bot = await makeBot(first, '小启');
        const conv = await openDirect(first, bot.id);
        convId = conv.id;
        firstLlm.script('mock-main', [
          step().expect(isTaskRequest('TASK-RESTART')).replyFinish('length', '写到一半'),
        ]);
        const started = first.services.orchestrator!.tasks.start(turnIdentity(bot.id, conv.id), {
          title: '跨重启',
          instruction: 'TASK-RESTART',
          sourceMessageIds: [],
          writes: false,
        });
        const requeued = await waitAttempts({ core: first }, started.taskId!, 1);
        taskId = started.taskId!;
        retryAt = requeued.taskRetryAt!;
      } finally {
        firstLlm.releaseAll();
        await first.close();
        await firstLlm.stop();
      }

      // 重启：时钟已过 retry_at —— resume 的 #pump 按持久化计划直接重试。
      const secondClock = new TestClock(retryAt + 60_000);
      const secondLlm = await startMockLlm();
      secondLlm.script('mock-main', [
        step().expect(isTaskRequest('TASK-RESTART')).replyFinish('length', '又失败'),
      ]);
      const second = await createTestCore({
        home,
        keystore,
        clock: secondClock,
        timers: secondClock,
        env: { KEPCUP_MOCK_LLM_URL: secondLlm.url },
        taskAutoRetryDelaysMs: TASK_AUTO_RETRY_DELAYS_MS,
      });
      try {
        const retried = await waitAttempts({ core: second }, taskId, 2);
        expect(retried.status).toBe('queued');
        expect(retried.taskRetryAt).toBe(secondClock.now() + TASK_AUTO_RETRY_DELAYS_MS[1]);
        // 重试失败继续退避，没有提前唤醒。
        expect(wakeRuns({ core: second }, convId)).toEqual([]);
      } finally {
        secondLlm.releaseAll();
        await second.close();
        secondLlm.stop();
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 60_000);
});
