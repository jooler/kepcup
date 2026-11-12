import { describe, expect, it } from 'vitest';
import type { TaskEventContent } from '@kepcup/shared';
import { createTestStack, makeBot, openDirect, type TestStack } from '@kepcup/testkit';
import { TaskHost, type TaskRunControl } from '../../src/dispatch/tasks.js';
import type { RunIdentity } from '../../src/agent/types.js';

/**
 * D123 ③ 独立审查修复：任务读到的「启动前排队时长与原因」。上报的原因必须是
 * 排队时间里实际等得最久的那一个（执行器顺序报「等写入租约」→「等模型并发
 * 额度」，最后一条几乎总是通用额度），并且不能把任务自己算成阻塞者。
 */

const quietLogger = { info() {}, warn() {}, error() {}, debug() {} } as never;

function domain(stack: TestStack) {
  return stack.core.services.domain!;
}

function turnIdentity(botId: string, conversationId: string): RunIdentity {
  return { runId: 'run_turn_1', botId, conversationId, loopType: 'turn' };
}

/**
 * A TaskHost over the test core's real domain services whose executions are
 * driven by hand, on an injectable clock.
 */
function handDrivenHost(stack: TestStack) {
  const d = domain(stack);
  const clock = { t: 1_000_000, now: () => clock.t };
  const controls = new Map<string, TaskRunControl>();
  const host = new TaskHost({
    db: stack.core.services.mainDb!,
    runs: d.runs,
    messages: d.messages,
    conversations: d.conversations,
    bots: d.bots,
    clock,
    logger: quietLogger,
    timeZone: 'UTC',
    renderOptions: (selfBotId) => ({ selfBotId, timeZone: 'UTC', botNames: new Map() }),
    publishRunStatus: () => {},
    execute: (task, control) => {
      controls.set(task.id, control);
    },
    wake: () => {},
    resolveCwd: () => '/repo/project',
    onSettled: () => {},
    releaseExecution: () => {},
    recordVisibleMessage: () => {},
  });
  return { host, controls, clock, d };
}

const input = (writes: boolean | string[] = false) => ({
  title: 't',
  instruction: 'i',
  sourceMessageIds: [] as string[],
  ...(writes === false ? { writes: false } : { writes }),
});

/** A launched task's row leaves `queued` when its engine run attaches. */
function running(d: ReturnType<typeof domain>, taskId: string) {
  d.runs.update(taskId, { status: 'running' });
}

const taskEvents = (stack: TestStack, taskId: string) =>
  domain(stack)
    .messages.taskEvents(taskId)
    .map((message) => message.content as TaskEventContent);

describe('D123 ③: the startup queue a task reads about itself', () => {
  it('reports the reason it waited longest on, not the last one before the run', async () => {
    const stack = await createTestStack();
    try {
      const bot = await makeBot(stack.core, '小艾');
      const conv = await openDirect(stack.core, bot.id);
      const identity = turnIdentity(bot.id, conv.id);
      const { host, controls, clock, d } = handDrivenHost(stack);
      const started = host.start(identity, input(true));
      running(d, started.taskId);
      const control = controls.get(started.taskId)!;
      // The executor reports the lease first, then the provider slot.
      control.waiting('等写入租约');
      clock.t += 247_000;
      control.waiting('等模型并发额度');
      clock.t += 4_000;
      control.waiting(null);

      const self = host.list(identity).find((task) => task.taskId === started.taskId)!;
      expect(self.startupQueueMs).toBe(251_000);
      expect(self.startupQueueReason).toBe('等写入租约');
      // A task is never its own blocker: it must not name itself as the holder.
      expect(self.startupQueueReason).not.toContain(started.taskId);
    } finally {
      await stack.cleanup();
    }
  });

  it('keeps the submit-time reason (no publisher wired) and names the real holder', async () => {
    const stack = await createTestStack();
    try {
      const bot = await makeBot(stack.core, '小艾');
      const conv = await openDirect(stack.core, bot.id);
      const identity = turnIdentity(bot.id, conv.id);
      const { host, controls, clock, d } = handDrivenHost(stack);
      const first = host.start(identity, input(['apps/**']));
      running(d, first.taskId);
      const firstControl = controls.get(first.taskId)!;
      // The holder sits on its lease while the second write task queues...
      const queued = host.start(identity, input(['apps/**']));
      expect(queued.state).toBe('submitted');
      expect(queued.queueReason).toContain(first.taskId);
      expect(taskEvents(stack, queued.taskId).length).toBeGreaterThan(0);
      // ...for a minute, then the lease hands over.
      clock.t += 60_000;
      firstControl.finish();
      const secondControl = controls.get(queued.taskId)!;
      running(d, queued.taskId);
      // The lease hands over at once: the queue is the submit-time wait.
      secondControl.waiting('等写入租约');
      clock.t += 300;
      secondControl.waiting(null);

      const self = host.list(identity).find((task) => task.taskId === queued.taskId)!;
      expect(self.startupQueueMs).toBe(60_300);
      expect(self.startupQueueReason).toBe(`等写域（任务 ${first.taskId} 持有 apps/**）`);
    } finally {
      await stack.cleanup();
    }
  });

  it('stays silent for a handover under a second', async () => {
    const stack = await createTestStack();
    try {
      const bot = await makeBot(stack.core, '小艾');
      const conv = await openDirect(stack.core, bot.id);
      const identity = turnIdentity(bot.id, conv.id);
      const { host, controls, clock, d } = handDrivenHost(stack);
      const started = host.start(identity, input(true));
      running(d, started.taskId);
      const control = controls.get(started.taskId)!;
      control.waiting('等写入租约');
      clock.t += 400;
      control.waiting(null);

      const self = host.list(identity).find((task) => task.taskId === started.taskId)!;
      expect(self.startupQueueMs).toBeUndefined();
      expect(self.startupQueueReason).toBeUndefined();
    } finally {
      await stack.cleanup();
    }
  });

  it('drops the queue trace of a task cancelled while still queued', async () => {
    const stack = await createTestStack();
    try {
      const bot = await makeBot(stack.core, '小艾');
      const conv = await openDirect(stack.core, bot.id);
      const identity = turnIdentity(bot.id, conv.id);
      const { host, controls, clock, d } = handDrivenHost(stack);
      const first = host.start(identity, input(['apps/**']));
      running(d, first.taskId);
      clock.t += 1_000;
      const queued = host.start(identity, input(['apps/**']));
      expect(queued.state).toBe('submitted');
      host.cancel(identity, { taskId: queued.taskId, reason: 'user_cancelled' });
      expect(controls.has(queued.taskId)).toBe(false);

      // The holder finishes: the cancelled task must not be revived from a
      // stale queue trace.
      controls.get(first.taskId)!.finish();
      expect(controls.has(queued.taskId)).toBe(false);
      const cancelled = host.list(identity).find((task) => task.taskId === queued.taskId)!;
      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.startupQueueMs).toBeUndefined();
    } finally {
      await stack.cleanup();
    }
  });
});
