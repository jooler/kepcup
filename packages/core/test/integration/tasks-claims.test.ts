import { afterEach, describe, expect, it } from 'vitest';
import type { Run } from '@kepcup/shared';
import {
  createTestStack,
  makeBot,
  openDirect,
  step,
  waitFor,
  type MockChatRequest,
  type TestStack,
} from '@kepcup/testkit';
import type { RunIdentity } from '../../src/agent/types.js';

/** D123 W5: runtime path claims (docs/design/59 §5). */

const stacks: TestStack[] = [];
afterEach(async () => {
  for (const stack of stacks.splice(0)) {
    stack.llm.releaseAll();
    await stack.cleanup();
  }
});

async function start(): Promise<TestStack> {
  const stack = await createTestStack();
  stacks.push(stack);
  return stack;
}

function domain(stack: TestStack) {
  return stack.core.services.domain!;
}

function host(stack: TestStack) {
  return stack.core.services.orchestrator!.tasks;
}

const isTaskRequest = (marker: string) => (req: MockChatRequest) =>
  req.lastUserText().includes('<task_brief') && req.lastUserText().includes(marker);

function taskIdentity(taskId: string, botId: string, conversationId: string): RunIdentity {
  return { runId: taskId, botId, conversationId, loopType: 'task' };
}

function waitStatus(stack: TestStack, taskId: string, statuses: Run['status'][], label: string) {
  return waitFor(
    () => {
      const run = domain(stack).runs.get(taskId);
      return run !== null && statuses.includes(run.status) ? run : null;
    },
    { label, timeoutMs: 20_000 },
  );
}

async function startTask(
  stack: TestStack,
  botId: string,
  conversationId: string,
  marker: string,
  writes: boolean | string[],
) {
  const started = host(stack).start(
    { runId: 'run_turn_1', botId, conversationId, loopType: 'turn' },
    { title: 'peer', instruction: marker, sourceMessageIds: [], writes },
  );
  await waitStatus(stack, started.taskId, ['running'], `${marker} running`);
  return taskIdentity(started.taskId, botId, conversationId);
}

describe('D123 runtime claims', () => {
  it('claims inside the domain, is idempotent, and shows up on the TaskView', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const bot = await makeBot(core, '认领');
    const conv = await openDirect(core, bot.id);
    llm.script('mock-main', [step().expect(isTaskRequest('TASK-CLAIM')).hold().replyText('ok')]);
    const identity = await startTask(stack, bot.id, conv.id, 'TASK-CLAIM', ['apps/**']);

    const first = host(stack).claim(identity, {
      paths: ['./apps/shared/', 'apps/shared/**'],
      reason: '要改公共组件',
    });
    expect(first.paths).toEqual(['apps/shared', 'apps/shared/**']);
    expect(first.reason).toBe('要改公共组件');

    // A second claim merges into the existing set (design §5: re-claiming the
    // same path is idempotent, it must not silently drop the earlier paths).
    const again = host(stack).claim(identity, {
      paths: ['apps/shared'],
      reason: '再确认一下',
    });
    expect(again.paths).toEqual(['apps/shared', 'apps/shared/**']);

    const view = host(stack).view(identity.runId)!;
    expect(view.writeDomains).toEqual(['apps/**']);
    expect(view.claims).toEqual([
      {
        paths: ['apps/shared', 'apps/shared/**'],
        reason: '再确认一下',
        since: expect.any(Number),
      },
    ]);

    // Release one path, then everything.
    expect(host(stack).release(identity, { paths: ['apps/shared'] })).toEqual(['apps/shared']);
    expect(host(stack).view(identity.runId)!.claims).toEqual([
      { paths: ['apps/shared/**'], reason: '再确认一下', since: expect.any(Number) },
    ]);
    host(stack).claim(identity, { paths: ['apps/shared/**'], reason: 'x' });
    expect(host(stack).release(identity, {})).toEqual(['apps/shared/**']);
    expect(host(stack).view(identity.runId)!.claims).toEqual([]);
    llm.releaseAll();
  }, 30_000);

  it('refuses paths outside the write domain, absolute paths, and read-only tasks', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const bot = await makeBot(core, '越界');
    const conv = await openDirect(core, bot.id);
    llm.script('mock-main', [
      step().expect(isTaskRequest('TASK-A')).hold().replyText('A'),
      step().expect(isTaskRequest('TASK-R')).hold().replyText('R'),
    ]);
    const scoped = await startTask(stack, bot.id, conv.id, 'TASK-A', ['apps/**']);
    expect(() => host(stack).claim(scoped, { paths: ['lib/**'], reason: 'x' })).toThrow(
      /写域内/,
    );
    expect(() => host(stack).claim(scoped, { paths: ['/etc/passwd'], reason: 'x' })).toThrow(
      /绝对路径/,
    );
    expect(() => host(stack).claim(scoped, { paths: ['../outside/**'], reason: 'x' })).toThrow(
      /\.\./,
    );
    expect(host(stack).view(scoped.runId)!.claims).toEqual([]);

    const readOnly = await startTask(stack, bot.id, conv.id, 'TASK-R', false);
    expect(() => host(stack).claim(readOnly, { paths: ['apps/**'], reason: 'x' })).toThrow(
      /只读任务/,
    );
    llm.releaseAll();
  }, 30_000);

  it('clears the claim when the task settles', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const bot = await makeBot(core, '结算');
    const conv = await openDirect(core, bot.id);
    llm.script('mock-main', [step().expect(isTaskRequest('TASK-S')).hold().replyText('S')]);
    const identity = await startTask(stack, bot.id, conv.id, 'TASK-S', ['apps/**']);
    host(stack).claim(identity, { paths: ['apps/shared/**'], reason: 'x' });
    expect(host(stack).view(identity.runId)!.claims).toHaveLength(1);

    host(stack).cancel({ runId: 'run_turn_1', botId: bot.id, conversationId: conv.id, loopType: 'turn' }, {
      taskId: identity.runId,
      reason: '用户取消',
    });
    await waitStatus(stack, identity.runId, ['cancelled'], 'task cancelled');
    expect(host(stack).view(identity.runId)!.claims).toEqual([]);
  }, 30_000);
});
