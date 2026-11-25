import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createTestStack,
  makeBot,
  openDirect,
  step,
  waitFor,
  type TestStack,
} from '@kepcup/testkit';
import type { Run } from '@kepcup/shared';
import type { RunIdentity } from '../../src/agent/types.js';

/**
 * D140-1 W4: 写任务默认并行后的文件级互斥与 per-run 影子窗口——
 * 自动认领（先到先得）、WRITE_CLAIMED 跨对话、run_changes 归属与
 * interleaved 标记、共享租约的「停止写入」语义。
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

function runtime(stack: TestStack) {
  return stack.core.services.workdirRuntime!;
}

function turnIdentity(botId: string, conversationId: string, runId = 'run_turn_1'): RunIdentity {
  return { runId, botId, conversationId, loopType: 'turn' };
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

/** Binds a fresh workdir to the conversation, returning its (canonical) path. */
async function bindWorkdir(
  stack: TestStack,
  conversationId: string,
): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), 'd140-w4-'));
  dirs.push(dir);
  writeFileSync(path.join(dir, 'README.md'), '# p\n');
  const bound = (await stack.core.rpc.call('workdirs.select', {
    conversationId,
    path: dir,
  })) as { workdir: { path: string } };
  return bound.workdir.path;
}

describe('D140-1 parallel write tasks', () => {
  it('auto-claims the first write: a later task gets WRITE_CLAIMED on that path and passes on its own', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const bot = await makeBot(core, '先到先得');
    const conv = await openDirect(core, bot.id);
    const workdir = await bindWorkdir(stack, conv.id);

    // A writes a.ts and stays running (its second model turn is held); the
    // auto-claim is live while A runs.
    llm.script('mock-main', [
      step().inTask().replyToolCall('write', { path: 'a.ts', content: 'from A' }),
      step().inTask().replyText('A 完成').hold(),
      // B (parallel): writing a.ts fails with WRITE_CLAIMED (A's auto-claim);
      // b.ts works.
      step().inTask().replyToolCall('write', { path: 'a.ts', content: 'from B' }),
      step().inTask().replyToolCall('write', { path: 'b.ts', content: 'from B' }),
      step().inTask().replyText('B 完成'),
    ]);
    const turn = turnIdentity(bot.id, conv.id);
    const a = host(stack).start(turn, {
      title: 'A',
      instruction: 'TASK-A',
      sourceMessageIds: [],
      writes: true,
    });
    await waitFor(() => (existsSync(path.join(workdir, 'a.ts')) ? true : null), {
      label: 'A wrote a.ts',
      timeoutMs: 20_000,
    });

    const b = host(stack).start(turn, {
      title: 'B',
      instruction: 'TASK-B',
      sourceMessageIds: [],
      writes: true,
    });
    await waitStatus(stack, b.taskId, 'completed', 'B completed');
    llm.releaseAll();
    await waitStatus(stack, a.taskId, 'completed', 'A completed');

    expect(readFileSync(path.join(workdir, 'a.ts'), 'utf-8')).toBe('from A');
    expect(readFileSync(path.join(workdir, 'b.ts'), 'utf-8')).toBe('from B');
    // B's failed write surfaced WRITE_CLAIMED with the coordination hint.
    const bSteps = domain(stack)
      .runs.stepsFor(b.taskId)
      .map((step_) => JSON.stringify(step_));
    const claimError = bSteps.find((text) => text.includes('WRITE_CLAIMED'));
    expect(claimError).toContain('send_to_task');
    // Settled: both claims are gone.
    expect(host(stack).view(a.taskId)?.claims).toEqual([]);
  }, 45_000);

  it('claims cross conversations: a task of another conversation on the same workdir is blocked too', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const botA = await makeBot(core, '甲');
    const botB = await makeBot(core, '乙');
    const convA = await openDirect(core, botA.id);
    const convB = await openDirect(core, botB.id);
    const workdir = await bindWorkdir(stack, convA.id);
    await core.rpc.call('workdirs.select', { conversationId: convB.id, path: workdir });

    llm.script('mock-main', [
      step().inTask().replyToolCall('write', { path: 'shared.ts', content: 'from A' }),
      step().inTask().replyText('A 完成').hold(),
      step().inTask().replyToolCall('write', { path: 'shared.ts', content: 'from B' }),
      step().inTask().replyText('B 完成'),
    ]);
    const a = host(stack).start(turnIdentity(botA.id, convA.id), {
      title: 'A',
      instruction: 'TASK-A',
      sourceMessageIds: [],
      writes: true,
    });
    await waitFor(() => (existsSync(path.join(workdir, 'shared.ts')) ? true : null), {
      label: 'A wrote shared.ts',
      timeoutMs: 20_000,
    });

    const b = host(stack).start(turnIdentity(botB.id, convB.id, 'run_turn_b'), {
      title: 'B',
      instruction: 'TASK-B',
      sourceMessageIds: [],
      writes: true,
    });
    await waitStatus(stack, b.taskId, 'completed', 'B completed');
    llm.releaseAll();
    await waitStatus(stack, a.taskId, 'completed', 'A completed');

    expect(readFileSync(path.join(workdir, 'shared.ts'), 'utf-8')).toBe('from A');
    const bSteps = domain(stack)
      .runs.stepsFor(b.taskId)
      .map((step_) => JSON.stringify(step_));
    expect(bSteps.some((text) => text.includes('WRITE_CLAIMED'))).toBe(true);
  }, 45_000);

  it('per-run shadow windows: disjoint attribution per task, shared file marked interleaved', async () => {
    const stack = await start();
    const { core } = stack;
    const bot = await makeBot(core, '影子');
    const conv = await openDirect(core, bot.id);
    const workdir = await bindWorkdir(stack, conv.id);
    const runs = domain(stack).runs;

    const taskRow = (title: string): { id: string; identity: RunIdentity } => {
      const run = runs.create({
        botId: bot.id,
        conversationId: conv.id,
        loopType: 'task',
        triggerReason: 'task',
        triggerMessageIds: [],
        taskTitle: title,
        taskWrites: true,
        taskCwd: workdir,
        originRunId: null,
      });
      runs.update(run.id, { status: 'running' });
      return {
        id: run.id,
        identity: { runId: run.id, botId: bot.id, conversationId: conv.id, loopType: 'task' },
      };
    };
    const a = taskRow('A');
    const b = taskRow('B');
    const rt = runtime(stack);

    // Both hold the shared lease and open their windows.
    await rt.ensureWriteLease(a.identity, workdir, { pin: true, shared: true });
    await rt.ensureWriteLease(b.identity, workdir, { pin: true, shared: true });
    await rt.beginTaskWindow(runs.getOrThrow(a.id));
    await rt.beginTaskWindow(runs.getOrThrow(b.id));

    writeFileSync(path.join(workdir, 'a-only.ts'), 'A');
    writeFileSync(path.join(workdir, 'shared.ts'), 'A+B');
    writeFileSync(path.join(workdir, 'b-only.ts'), 'B');

    // A settles first: its own writes are a-only.ts + shared.ts. B's only
    // gateway-attributed write is b-only.ts — it lands in A's span (written
    // before A's after-snapshot) but is excluded as B's. shared.ts (B wrote it
    // too, via a channel A's attribution cannot see) stays unflagged for A.
    await rt.releaseRun(a.id, {
      own: [
        { path: path.join(workdir, 'a-only.ts'), change: 'created' },
        { path: path.join(workdir, 'shared.ts'), change: 'created' },
      ],
      others: new Set([path.join(workdir, 'b-only.ts')]),
    });
    const changeA = rt.changesOf(a.id);
    expect(changeA?.files.map((file) => [file.path, file.interleaved === true])).toEqual([
      ['a-only.ts', false],
      ['shared.ts', false],
    ]);

    // B settles: A's writes (a-only.ts, shared.ts) are the `others` set —
    // a-only.ts is excluded from B's files, shared.ts (both wrote it) is
    // interleaved; b-only.ts is clean.
    await rt.releaseRun(b.id, {
      own: [
        { path: path.join(workdir, 'shared.ts'), change: 'created' },
        { path: path.join(workdir, 'b-only.ts'), change: 'created' },
      ],
      others: new Set([
        path.join(workdir, 'a-only.ts'),
        path.join(workdir, 'shared.ts'),
      ]),
    });
    const changeB = rt.changesOf(b.id);
    expect(changeB?.files.map((file) => [file.path, file.interleaved === true])).toEqual([
      ['b-only.ts', false],
      ['shared.ts', true],
    ]);

    // A's row keeps its own view (A terminated before B's record: unchanged).
    expect(rt.changesOf(a.id)?.files).toHaveLength(2);
  }, 45_000);

  it('a finished parallel task\'s files are not attributed to the task still open (overlap hand-over)', async () => {
    const stack = await start();
    const { core } = stack;
    const bot = await makeBot(core, '交接');
    const conv = await openDirect(core, bot.id);
    const workdir = await bindWorkdir(stack, conv.id);
    const runs = domain(stack).runs;
    const rt = runtime(stack);

    const taskRow = (title: string) => {
      const run = runs.create({
        botId: bot.id,
        conversationId: conv.id,
        loopType: 'task',
        triggerReason: 'task',
        triggerMessageIds: [],
        taskTitle: title,
        taskWrites: true,
        taskCwd: workdir,
        originRunId: null,
      });
      runs.update(run.id, { status: 'running' });
      return {
        id: run.id,
        identity: { runId: run.id, botId: bot.id, conversationId: conv.id, loopType: 'task' },
      };
    };
    const a = taskRow('A');
    const b = taskRow('B');
    await rt.ensureWriteLease(a.identity, workdir, { pin: true, shared: true });
    await rt.ensureWriteLease(b.identity, workdir, { pin: true, shared: true });
    await rt.beginTaskWindow(runs.getOrThrow(a.id));
    await rt.beginTaskWindow(runs.getOrThrow(b.id));

    // B writes and settles while A stays open. B's window close hands its file
    // to A's still-open window.
    writeFileSync(path.join(workdir, 'b-only.ts'), 'B');
    await rt.releaseRun(b.id, {
      own: [{ path: path.join(workdir, 'b-only.ts'), change: 'created' }],
      others: new Set(),
    });
    expect(rt.changesOf(b.id)?.files.map((file) => file.path)).toEqual(['b-only.ts']);

    // A's span diff contains B's file (written after A's before snapshot) but
    // it must not be claimed by A: only A's own a-only.ts is recorded.
    writeFileSync(path.join(workdir, 'a-only.ts'), 'A');
    await rt.releaseRun(a.id, {
      own: [{ path: path.join(workdir, 'a-only.ts'), change: 'created' }],
      others: new Set(),
    });
    expect(rt.changesOf(a.id)?.files.map((file) => [file.path, file.interleaved === true])).toEqual([
      ['a-only.ts', false],
    ]);
    // B's row is untouched by A's close.
    expect(rt.changesOf(b.id)?.files.map((file) => file.path)).toEqual(['b-only.ts']);
  }, 45_000);

  it('a re-acquire during an in-flight release waits for it (no lease handed out that is about to be released)', async () => {
    const stack = await start();
    const { core } = stack;
    const bot = await makeBot(core, '重入');
    const conv = await openDirect(core, bot.id);
    const workdir = await bindWorkdir(stack, conv.id);
    const runs = domain(stack).runs;
    const rt = runtime(stack);
    const run = runs.create({
      botId: bot.id,
      conversationId: conv.id,
      loopType: 'task',
      triggerReason: 'task',
      triggerMessageIds: [],
      taskTitle: '重入',
      taskWrites: true,
      taskCwd: workdir,
      originRunId: null,
    });
    runs.update(run.id, { status: 'running' });
    const identity: RunIdentity = {
      runId: run.id,
      botId: bot.id,
      conversationId: conv.id,
      loopType: 'task',
    };

    // First attempt: lease + window, then a release that is NOT awaited (the
    // settle path is fire-and-forget).
    await rt.ensureWriteLease(identity, workdir, { pin: true, shared: true });
    await rt.beginTaskWindow(runs.getOrThrow(run.id));
    const releasing = rt.releaseRun(run.id);

    // The retried attempt re-acquires immediately: it must wait for the
    // release, or the release would close its fresh window and free the lease
    // under it.
    const target = await rt.ensureWriteLease(identity, workdir, { pin: true, shared: true });
    expect(target.key).toBe(workdir);
    await releasing;
    await rt.beginTaskWindow(runs.getOrThrow(run.id));
    expect(rt.holdsLease(identity, workdir)).toBe(true);
    expect(rt.openTaskWindows().some((window) => window.runId === run.id)).toBe(true);

    writeFileSync(path.join(workdir, 'retry.ts'), 'R');
    await rt.releaseRun(run.id, {
      own: [{ path: path.join(workdir, 'retry.ts'), change: 'created' }],
      others: new Set(),
    });
    expect(rt.changesOf(run.id)?.files.map((file) => file.path)).toEqual(['retry.ts']);
    expect(rt.holdsLease(identity, workdir)).toBe(false);
  }, 45_000);

  it('a retried run (same run id) merges its attempts\' files instead of replacing them', async () => {
    const stack = await start();
    const { core } = stack;
    const bot = await makeBot(core, '重试');
    const conv = await openDirect(core, bot.id);
    const workdir = await bindWorkdir(stack, conv.id);
    const runs = domain(stack).runs;
    const rt = runtime(stack);
    const run = runs.create({
      botId: bot.id,
      conversationId: conv.id,
      loopType: 'task',
      triggerReason: 'task',
      triggerMessageIds: [],
      taskTitle: '两次',
      taskWrites: true,
      taskCwd: workdir,
      originRunId: null,
    });
    runs.update(run.id, { status: 'running' });
    const identity: RunIdentity = {
      runId: run.id,
      botId: bot.id,
      conversationId: conv.id,
      loopType: 'task',
    };

    // First attempt: writes first.ts and records one file.
    await rt.ensureWriteLease(identity, workdir, { pin: true, shared: true });
    await rt.beginTaskWindow(runs.getOrThrow(run.id));
    writeFileSync(path.join(workdir, 'first.ts'), '1');
    await rt.releaseRun(run.id, {
      own: [{ path: path.join(workdir, 'first.ts'), change: 'created' }],
      others: new Set(),
    });
    const firstChange = rt.changesOf(run.id);
    expect(firstChange?.files.map((file) => file.path)).toEqual(['first.ts']);

    // Auto-retry re-runs the same run id with a fresh window: the second
    // attempt's file is added, the first attempt's file stays.
    await rt.ensureWriteLease(identity, workdir, { pin: true, shared: true });
    await rt.beginTaskWindow(runs.getOrThrow(run.id));
    writeFileSync(path.join(workdir, 'second.ts'), '2');
    await rt.releaseRun(run.id, {
      own: [{ path: path.join(workdir, 'second.ts'), change: 'created' }],
      others: new Set(),
    });
    const merged = rt.changesOf(run.id);
    expect(merged?.files.map((file) => file.path)).toEqual(['first.ts', 'second.ts']);
    expect(merged?.beforeOid).toBe(firstChange?.beforeOid);
    expect(merged?.afterOid).not.toBe(firstChange?.afterOid);
  }, 45_000);

  it('force-revoke never picks another conversation\'s shared task when nothing blocks this one', async () => {
    const stack = await start();
    const { core } = stack;
    const botA = await makeBot(core, '甲');
    const botB = await makeBot(core, '乙');
    const botC = await makeBot(core, '丙');
    const convA = await openDirect(core, botA.id);
    const convB = await openDirect(core, botB.id);
    const convC = await openDirect(core, botC.id);
    const workdir = await bindWorkdir(stack, convA.id);
    await core.rpc.call('workdirs.select', { conversationId: convB.id, path: workdir });
    await core.rpc.call('workdirs.select', { conversationId: convC.id, path: workdir });
    const runs = domain(stack).runs;
    const rt = runtime(stack);
    const taskRow = (botId: string, conversationId: string, title: string) => {
      const run = runs.create({
        botId,
        conversationId,
        loopType: 'task',
        triggerReason: 'task',
        triggerMessageIds: [],
        taskTitle: title,
        taskWrites: true,
        taskCwd: workdir,
        originRunId: null,
      });
      runs.update(run.id, { status: 'running' });
      return {
        id: run.id,
        identity: { runId: run.id, botId, conversationId, loopType: 'task' as const },
      };
    };
    const a = taskRow(botA.id, convA.id, 'A');
    const b = taskRow(botB.id, convB.id, 'B');
    await rt.ensureWriteLease(a.identity, workdir, { pin: true, shared: true });
    await rt.ensureWriteLease(b.identity, workdir, { pin: true, shared: true });

    // C has no holder and its shared waiter would not be blocked by A/B: the
    // revoke must report nothing to stop instead of stopping A's or B's task.
    expect(await rt.revokeLease(convC.id)).toBe(false);
    expect(rt.holdsLease(a.identity, workdir)).toBe(true);
    expect(rt.holdsLease(b.identity, workdir)).toBe(true);

    await rt.releaseRun(a.id);
    await rt.releaseRun(b.id);
  }, 45_000);

  it('force-revoke stops one shared write task; the sibling keeps writing', async () => {
    const stack = await start();
    const { core } = stack;
    const bot = await makeBot(core, '收回');
    const conv = await openDirect(core, bot.id);
    const workdir = await bindWorkdir(stack, conv.id);
    const runs = domain(stack).runs;
    const rt = runtime(stack);

    const taskRow = (title: string) => {
      const run = runs.create({
        botId: bot.id,
        conversationId: conv.id,
        loopType: 'task',
        triggerReason: 'task',
        triggerMessageIds: [],
        taskTitle: title,
        taskWrites: true,
        taskCwd: workdir,
        originRunId: null,
      });
      runs.update(run.id, { status: 'running' });
      return {
        id: run.id,
        identity: { runId: run.id, botId: bot.id, conversationId: conv.id, loopType: 'task' },
      };
    };
    const a = taskRow('A');
    const b = taskRow('B');
    await rt.ensureWriteLease(a.identity, workdir, { pin: true, shared: true });
    await rt.ensureWriteLease(b.identity, workdir, { pin: true, shared: true });

    // The user stops A's writes: only A loses the lease and permission.
    expect(await rt.revokeLease(conv.id)).toBe(true);
    expect(rt.writeDenial(a.identity)).toContain('收回');
    expect(rt.writeDenial(b.identity)).toBeNull();
    expect(rt.holdsLease(b.identity, workdir)).toBe(true);

    await rt.releaseRun(b.id);
  }, 45_000);
});
