import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createTestStack,
  makeBot,
  openDirect,
  step,
  waitFor,
  type MockChatRequest,
  type TestStack,
} from '@kepcup/testkit';
import type { Run } from '@kepcup/shared';
import type { RunIdentity } from '../../src/agent/types.js';

/**
 * D123 W2: write-domain scheduling (docs/design/59 §3.3–3.5). Two write tasks
 * on one cwd run in parallel when their declared domains do not intersect and
 * queue behind each other otherwise; `writes: true` stays the whole cwd.
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

function runOf(stack: TestStack, id: string): Run {
  return domain(stack).runs.getOrThrow(id);
}

function turnIdentity(botId: string, conversationId: string, runId = 'run_turn_1'): RunIdentity {
  return { runId, botId, conversationId, loopType: 'turn' };
}

const isTaskRequest = (marker: string) => (req: MockChatRequest) =>
  req.lastUserText().includes('<task_brief') && req.lastUserText().includes(marker);

function waitRunning(stack: TestStack, taskId: string, label: string): Promise<Run> {
  return waitFor(
    () => {
      const run = domain(stack).runs.get(taskId);
      return run !== null && run.status === 'running' ? run : null;
    },
    { label, timeoutMs: 20_000 },
  );
}

function waitStatus(stack: TestStack, taskId: string, status: Run['status'], label: string) {
  return waitFor(
    () => {
      const run = domain(stack).runs.get(taskId);
      return run !== null && run.status === status ? run : null;
    },
    { label, timeoutMs: 20_000 },
  );
}

describe('D123 write-domain scheduling', () => {
  it('disjoint domains run in parallel on the same cwd', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const bot = await makeBot(core, '并行');
    const conv = await openDirect(core, bot.id);
    const heldA = step().expect(isTaskRequest('TASK-A')).hold().replyText('A 完成');
    const heldB = step().expect(isTaskRequest('TASK-B')).hold().replyText('B 完成');
    llm.script('mock-main', [heldA, heldB]);
    const turn = turnIdentity(bot.id, conv.id);
    const a = host(stack).start(turn, {
      title: '前端',
      instruction: 'TASK-A',
      sourceMessageIds: [],
      writes: ['apps/renderer/**'],
    });
    const b = host(stack).start(turn, {
      title: '后端',
      instruction: 'TASK-B',
      sourceMessageIds: [],
      writes: ['packages/core/**'],
    });

    await waitFor(() => (heldA.consumed && heldB.consumed ? true : null), {
      label: 'both task requests held',
      timeoutMs: 20_000,
    });
    expect(runOf(stack, a.taskId).status).toBe('running');
    expect(runOf(stack, b.taskId).status).toBe('running');
    expect(runOf(stack, a.taskId).taskWriteDomains).toEqual(['apps/renderer/**']);
    expect(runOf(stack, b.taskId).taskWriteDomains).toEqual(['packages/core/**']);

    heldA.release();
    heldB.release();
    await waitStatus(stack, a.taskId, 'completed', 'A completed');
    await waitStatus(stack, b.taskId, 'completed', 'B completed');
  }, 30_000);

  it('intersecting domains queue the later task and start it when the holder settles', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const bot = await makeBot(core, '串行');
    const conv = await openDirect(core, bot.id);
    const heldA = step().expect(isTaskRequest('TASK-C')).hold().replyText('C 完成');
    const heldB = step().expect(isTaskRequest('TASK-D')).hold().replyText('D 完成');
    llm.script('mock-main', [heldA, heldB]);
    const turn = turnIdentity(bot.id, conv.id);
    const a = host(stack).start(turn, {
      title: '渲染层',
      instruction: 'TASK-C',
      sourceMessageIds: [],
      writes: ['apps/**'],
    });
    const b = host(stack).start(turn, {
      title: '前端细节',
      instruction: 'TASK-D',
      sourceMessageIds: [],
      writes: ['apps/renderer/**'],
    });

    expect(b.state).toBe('submitted');
    expect(b.queueReason).toContain(`等写域（任务 ${a.taskId} 持有 apps/`);
    expect(b.queueReason).toContain('apps/**');
    await waitRunning(stack, a.taskId, 'A running');
    expect(runOf(stack, b.taskId).status).toBe('queued');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(llm.requests().some(isTaskRequest('TASK-D'))).toBe(false);

    heldA.release();
    await waitRunning(stack, b.taskId, 'B starts after A settles');
    heldB.release();
    await waitStatus(stack, b.taskId, 'completed', 'B completed');
    expect(runOf(stack, a.taskId).status).toBe('completed');
  }, 30_000);

  it('writes: true (whole cwd) conflicts with any declared domain', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const bot = await makeBot(core, '全域');
    const conv = await openDirect(core, bot.id);
    llm.script('mock-main', [
      step().expect(isTaskRequest('TASK-WHOLE')).hold().replyText('全域完成'),
      step().expect(isTaskRequest('TASK-SCOPED')).replyText('分域完成'),
    ]);
    const turn = turnIdentity(bot.id, conv.id);
    const whole = host(stack).start(turn, {
      title: '整目录',
      instruction: 'TASK-WHOLE',
      sourceMessageIds: [],
      writes: true,
    });
    const scoped = host(stack).start(turn, {
      title: '分域',
      instruction: 'TASK-SCOPED',
      sourceMessageIds: [],
      writes: ['docs/**'],
    });
    expect(scoped.state).toBe('submitted');
    expect(scoped.queueReason).toContain(`等写域（任务 ${whole.taskId} 持有 整目录）`);
    expect(runOf(stack, whole.taskId).taskWriteDomains).toBeNull();
  }, 30_000);

  it('cross-conversation tasks on one workdir: disjoint domains parallel, intersecting queue', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const botA = await makeBot(core, '甲');
    const botB = await makeBot(core, '乙');
    const convA = await openDirect(core, botA.id);
    const convB = await openDirect(core, botB.id);
    const dir = mkdtempSync(path.join(tmpdir(), 'd123-wd-'));
    dirs.push(dir);
    await core.rpc.call('workdirs.select', { conversationId: convA.id, path: dir });
    await core.rpc.call('workdirs.select', { conversationId: convB.id, path: dir });

    const heldA = step().expect(isTaskRequest('TASK-X')).hold().replyText('X 完成');
    const heldB = step().expect(isTaskRequest('TASK-Y')).hold().replyText('Y 完成');
    llm.script('mock-main', [heldA, heldB]);
    const a = host(stack).start(turnIdentity(botA.id, convA.id, 'run_a'), {
      title: '前端',
      instruction: 'TASK-X',
      sourceMessageIds: [],
      writes: ['apps/**'],
    });
    const b = host(stack).start(turnIdentity(botB.id, convB.id, 'run_b'), {
      title: '后端',
      instruction: 'TASK-Y',
      sourceMessageIds: [],
      writes: ['packages/**'],
    });
    await waitFor(() => (heldA.consumed && heldB.consumed ? true : null), {
      label: 'both cross-conversation requests held',
      timeoutMs: 20_000,
    });
    expect(runOf(stack, a.taskId).taskCwd).toBe(runOf(stack, b.taskId).taskCwd);
    expect(runOf(stack, a.taskId).status).toBe('running');
    expect(runOf(stack, b.taskId).status).toBe('running');
    heldA.release();
    heldB.release();
    await waitStatus(stack, a.taskId, 'completed', 'A completed');
    await waitStatus(stack, b.taskId, 'completed', 'B completed');

    // Intersecting domains on the same workdir queue even across conversations.
    const heldC = step().expect(isTaskRequest('TASK-Z')).hold().replyText('Z 完成');
    llm.script('mock-main', [heldC]);
    const c = host(stack).start(turnIdentity(botA.id, convA.id, 'run_c'), {
      title: '共享区',
      instruction: 'TASK-Z',
      sourceMessageIds: [],
      writes: ['apps/**'],
    });
    const d = host(stack).start(turnIdentity(botB.id, convB.id, 'run_d'), {
      title: '同区',
      instruction: 'TASK-Z2',
      sourceMessageIds: [],
      writes: ['apps/renderer/**'],
    });
    expect(d.state).toBe('submitted');
    expect(d.queueReason).toContain(`等写域（任务 ${c.taskId} 持有 apps/**）`);
    heldC.release();
    await waitStatus(stack, c.taskId, 'completed', 'C completed');
  }, 45_000);
});
