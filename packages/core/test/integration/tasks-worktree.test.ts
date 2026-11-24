import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Approval, Bot, Run, TaskView } from '@kepcup/shared';
import {
  createTestHome,
  createTestStack,
  fakeAgentEntry,
  makeBot,
  openDirect,
  step,
  waitFor,
  type MockChatRequest,
  type TestStack,
} from '@kepcup/testkit';
import type { RunIdentity } from '../../src/agent/types.js';

/**
 * D140-4 worktree isolation end to end (real git repositories, real core):
 * creation from the working state, execution root, parallel main-workdir
 * tasks, the「应用到工作目录」card (approve / conflict / deny / unattended),
 * retry vs continuation, and the refused combinations.
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

async function start(
  options: Parameters<typeof createTestStack>[0] = {},
): Promise<TestStack> {
  const stack = await createTestStack(options);
  stacks.push(stack);
  return stack;
}

function domain(stack: TestStack) {
  return stack.core.services.domain!;
}

function host(stack: TestStack) {
  return stack.core.services.orchestrator!.tasks;
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

/** A real git workdir (its own parent, so `.worktree/` is per-test). */
function makeRepo(files: Record<string, string> = { 'README.md': '# base\n' }): string {
  const root = mkdtempSync(path.join(tmpdir(), 'd140-wt-it-root-'));
  dirs.push(root);
  const dir = path.join(root, 'workdir');
  mkdirSync(dir);
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(dir, rel);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.name', 'fixture']);
  git(dir, ['config', 'user.email', 'fixture@localhost']);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

async function bindWorkdir(stack: TestStack, conversationId: string, dir: string): Promise<string> {
  const bound = (await stack.core.rpc.call('workdirs.select', {
    conversationId,
    path: dir,
  })) as { workdir: { path: string } };
  return bound.workdir.path;
}

function turnIdentity(botId: string, conversationId: string): RunIdentity {
  return { runId: 'run_turn_worktree', botId, conversationId, loopType: 'turn' };
}

const isTaskRequest = (marker: string) => (req: MockChatRequest) =>
  req.lastUserText().includes('<task_brief') && req.lastUserText().includes(marker);

function runOf(stack: TestStack, id: string): Run {
  return domain(stack).runs.getOrThrow(id);
}

function viewOf(stack: TestStack, id: string): TaskView | null {
  return host(stack).view(id);
}

function waitStatus(stack: TestStack, id: string, status: Run['status'], label: string) {
  return waitFor(
    () => {
      const run = domain(stack).runs.get(id);
      return run !== null && run.status === status ? run : null;
    },
    { label, timeoutMs: 30_000 },
  );
}

async function waitWorktreeApply(
  stack: TestStack,
  conversationId: string,
  runId: string,
): Promise<Approval> {
  return waitFor(
    async () => {
      const result = (await stack.core.rpc.call('approvals.list', { conversationId })) as {
        approvals: Approval[];
      };
      return (
        result.approvals.find(
          (approval) =>
            approval.kind === 'worktree_apply' &&
            approval.status === 'pending' &&
            approval.runId === runId,
        ) ?? null
      );
    },
    { label: 'worktree_apply card', timeoutMs: 30_000 },
  );
}

// Worktree isolation is srt-only; Windows desktop uses the WSL sandbox
// backend, which refuses isolation with WORKTREE_NOT_AVAILABLE. The happy-path
// suite below is skipped there; a dedicated case covers the refusal.
const worktreeIsolationSupported = process.platform !== 'win32';
const describeIsolation = worktreeIsolationSupported ? describe : describe.skip;

describeIsolation('D140-4 worktree isolation', () => {
  it('start_task isolation creates a sibling tree from the working state and executes there', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const bot = await makeBot(core, '隔离工');
    const conv = await openDirect(core, bot.id);
    const repo = makeRepo({ 'README.md': '# base\n' });
    // An uncommitted *tracked* change must be carried into the tree.
    writeFileSync(path.join(repo, 'README.md'), '# pending work\n');
    const workdir = await bindWorkdir(stack, conv.id, repo);
    llm.script('mock-main', [
      step().expect(isTaskRequest('TASK-WT')).replyToolCall('write', {
        path: 'tree-only.ts',
        content: 'export const isolated = true;\n',
      }),
      step().expect(isTaskRequest('TASK-WT')).replyText('隔离目录里写好了'),
      step().inTurn().replyText('收到'),
    ]);

    const started = host(stack).start(turnIdentity(bot.id, conv.id), {
      title: '隔离',
      instruction: 'TASK-WT',
      sourceMessageIds: [],
      writes: true,
      isolation: 'worktree',
    });
    const run = await waitStatus(stack, started.taskId, 'completed', 'worktree task completed');

    expect(run.isolation).toBe('worktree');
    expect(run.worktreePath).not.toBeNull();
    expect(path.dirname(run.worktreePath!)).toBe(path.join(path.dirname(workdir), '.worktree'));
    expect(path.basename(run.worktreePath!)).toMatch(/-[A-Za-z0-9]{8}$/);
    expect(run.taskCwd).toBe(run.worktreePath);
    expect(run.worktreeBase).not.toBeNull();
    // Detached HEAD, based on the user's working state.
    expect(git(run.worktreePath!, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('HEAD');
    expect(readFileSync(path.join(run.worktreePath!, 'README.md'), 'utf8')).toBe(
      '# pending work\n',
    );
    expect(run.worktreeBase).not.toBe(
      git(repo, ['rev-parse', 'HEAD']).trim(),
    );
    // The write landed only in the tree; the workdir is untouched.
    expect(readFileSync(path.join(run.worktreePath!, 'tree-only.ts'), 'utf8')).toContain('isolated');
    expect(existsSync(path.join(workdir, 'tree-only.ts'))).toBe(false);
    // The view projects the tree.
    const view = viewOf(stack, started.taskId)!;
    expect(view.cwdKind).toBe('worktree');
    expect(view.worktreePath).toBe(run.worktreePath);
    // The changes produce the apply card; the state settles on `pending`.
    await waitFor(() => (viewOf(stack, started.taskId)?.applyState === 'pending' ? true : null), {
      label: 'apply state pending',
    });
    expect(view.taskId).toBe(started.taskId);

    // The runtime projects the two roots: commands run in the tree, the
    // workdir stays the (unleased) reference.
    const runtime = stack.core.services.workdirRuntime!;
    const taskIdentity: RunIdentity = {
      runId: run.id,
      botId: bot.id,
      conversationId: conv.id,
      loopType: 'task',
    };
    const info = runtime.policyInfo(taskIdentity)!;
    expect(info.cwd).toBe(run.worktreePath);
    expect(info.worktree?.path).toBe(run.worktreePath);
    expect(info.worktree?.gitObjectsDir).toBe(path.join(workdir, '.git', 'objects'));
    expect(info.worktree?.gitWorktreeMeta.startsWith(path.join(workdir, '.git', 'worktrees'))).toBe(
      true,
    );
    expect(info.hasLease).toBe(false);
    expect(runtime.taskWorktreePath(taskIdentity)).toBe(run.worktreePath);
    // git_remote is refused for a worktree task (detached HEAD).
    await expect(
      runtime.gitRemote(
        taskIdentity,
        { operation: 'push', args: [], reason: 'test' },
        {
          requestApproval: async () => {
            throw new Error('must not ask for approval');
          },
        },
      ),
    ).rejects.toThrow(/worktree 任务不支持远程操作/);
  }, 60_000);

  it('runs in parallel with a main-workdir task (the tree root never queues behind the workdir)', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const bot = await makeBot(core, '并行');
    const conv = await openDirect(core, bot.id);
    const workdir = await bindWorkdir(stack, conv.id, makeRepo());
    llm.script('mock-main', [
      // The isolated task is held after its write: it keeps its exclusive lease
      // on the tree while the main-workdir task finishes.
      step().expect(isTaskRequest('TASK-ISO')).replyToolCall('write', {
        path: 'iso.ts',
        content: 'iso\n',
      }),
      step().expect(isTaskRequest('TASK-ISO')).replyText('隔离完成').hold(),
      step().expect(isTaskRequest('TASK-MAIN')).replyToolCall('write', {
        path: 'main.ts',
        content: 'main\n',
      }),
      step().expect(isTaskRequest('TASK-MAIN')).replyText('主目录完成'),
      step().inTurn().replyText('收到'),
      step().inTurn().replyText('收到'),
    ]);
    const isolated = host(stack).start(turnIdentity(bot.id, conv.id), {
      title: '隔离',
      instruction: 'TASK-ISO',
      sourceMessageIds: [],
      writes: true,
      isolation: 'worktree',
    });
    const isoRun = await waitFor(
      () => {
        const run = runOf(stack, isolated.taskId);
        return run.status === 'running' && run.worktreePath !== null ? run : null;
      },
      { label: 'isolated task running', timeoutMs: 30_000 },
    );
    await waitFor(() => (existsSync(path.join(isoRun.worktreePath!, 'iso.ts')) ? true : null), {
      label: 'isolated write landed',
      timeoutMs: 30_000,
    });

    const main = host(stack).start(turnIdentity(bot.id, conv.id), {
      title: '主目录',
      instruction: 'TASK-MAIN',
      sourceMessageIds: [],
      writes: true,
    });
    // It completes while the isolated task is still held → no lease queueing.
    await waitStatus(stack, main.taskId, 'completed', 'main task completed in parallel');
    expect(readFileSync(path.join(workdir, 'main.ts'), 'utf8')).toBe('main\n');
    expect(runOf(stack, isolated.taskId).status).toBe('running');
    llm.releaseAll();
    await waitStatus(stack, isolated.taskId, 'completed', 'isolated task completed');
  }, 90_000);

  it('submits a worktree_apply card at settlement; approving merges the workdir and removes the tree', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const bot = await makeBot(core, '应用');
    const conv = await openDirect(core, bot.id);
    const workdir = await bindWorkdir(stack, conv.id, makeRepo());
    llm.script('mock-main', [
      step().expect(isTaskRequest('TASK-APPLY')).replyToolCall('write', {
        path: 'applied.ts',
        content: 'export const applied = 1;\n',
      }),
      step().expect(isTaskRequest('TASK-APPLY')).replyText('完成'),
      step().inTurn().replyText('收到'),
    ]);
    const started = host(stack).start(turnIdentity(bot.id, conv.id), {
      title: '应用',
      instruction: 'TASK-APPLY',
      sourceMessageIds: [],
      writes: true,
      isolation: 'worktree',
    });
    await waitStatus(stack, started.taskId, 'completed', 'task completed');
    const card = await waitWorktreeApply(stack, conv.id, started.taskId);
    const payload = card.payload as {
      worktreePath: string;
      workdirPath: string;
      files: string[];
      fileCount: number;
      insertions: number;
    };
    expect(payload.workdirPath).toBe(workdir);
    expect(payload.worktreePath).toBe(runOf(stack, started.taskId).worktreePath);
    expect(payload.files).toEqual(['applied.ts']);
    expect(payload.fileCount).toBe(1);
    expect(payload.insertions).toBe(1);
    await waitFor(() => (viewOf(stack, started.taskId)?.applyState === 'pending' ? true : null), {
      label: 'apply state pending',
    });

    await core.rpc.call('approvals.decide', { id: card.id, approve: true });
    await waitFor(
      () => (viewOf(stack, started.taskId)?.applyState === 'applied' ? true : null),
      { label: 'apply state applied', timeoutMs: 30_000 },
    );
    expect(readFileSync(path.join(workdir, 'applied.ts'), 'utf8')).toContain('applied');
    expect(existsSync(payload.worktreePath)).toBe(false);
    expect(git(workdir, ['worktree', 'list'])).not.toContain(payload.worktreePath);
  }, 90_000);

  it('keeps the workdir untouched on a conflict, names the files and keeps the tree', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const bot = await makeBot(core, '冲突');
    const conv = await openDirect(core, bot.id);
    const workdir = await bindWorkdir(stack, conv.id, makeRepo());
    llm.script('mock-main', [
      step().expect(isTaskRequest('TASK-CONFLICT')).replyToolCall('write', {
        path: 'README.md',
        content: '# base\ntask edit\n',
      }),
      step().expect(isTaskRequest('TASK-CONFLICT')).replyText('完成'),
      step().inTurn().replyText('收到'),
    ]);
    const started = host(stack).start(turnIdentity(bot.id, conv.id), {
      title: '冲突',
      instruction: 'TASK-CONFLICT',
      sourceMessageIds: [],
      writes: true,
      isolation: 'worktree',
    });
    await waitStatus(stack, started.taskId, 'completed', 'task completed');
    const card = await waitWorktreeApply(stack, conv.id, started.taskId);
    const payload = card.payload as { worktreePath: string };
    // The user edits the same line after the task started.
    writeFileSync(path.join(workdir, 'README.md'), '# base\nuser edit\n');

    await core.rpc.call('approvals.decide', { id: card.id, approve: true });
    await waitFor(
      () => (viewOf(stack, started.taskId)?.applyState === 'conflict' ? true : null),
      { label: 'apply state conflict', timeoutMs: 30_000 },
    );
    expect(readFileSync(path.join(workdir, 'README.md'), 'utf8')).toBe('# base\nuser edit\n');
    expect(existsSync(payload.worktreePath)).toBe(true);
    const listed = (await core.rpc.call('approvals.list', { conversationId: conv.id })) as {
      approvals: Approval[];
    };
    const failed = listed.approvals.find((approval) => approval.id === card.id)!;
    expect(failed.status).toBe('failed');
    expect(JSON.stringify(failed.decision ?? {})).toContain('README.md');
  }, 90_000);

  it('denying the card keeps the tree (kept), and unattended mode never auto-applies', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const bot = await makeBot(core, '拒绝');
    const conv = await openDirect(core, bot.id);
    const workdir = await bindWorkdir(stack, conv.id, makeRepo());
    llm.script('mock-main', [
      step().expect(isTaskRequest('TASK-DENY')).replyToolCall('write', {
        path: 'denied.ts',
        content: 'nope\n',
      }),
      step().expect(isTaskRequest('TASK-DENY')).replyText('完成'),
      step().inTurn().replyText('收到'),
    ]);
    const started = host(stack).start(turnIdentity(bot.id, conv.id), {
      title: '拒绝',
      instruction: 'TASK-DENY',
      sourceMessageIds: [],
      writes: true,
      isolation: 'worktree',
    });
    await waitStatus(stack, started.taskId, 'completed', 'task completed');
    const card = await waitWorktreeApply(stack, conv.id, started.taskId);
    const worktreePath = (card.payload as { worktreePath: string }).worktreePath;
    await core.rpc.call('approvals.decide', { id: card.id, approve: false });
    await waitFor(() => (viewOf(stack, started.taskId)?.applyState === 'kept' ? true : null), {
      label: 'apply state kept',
    });
    expect(existsSync(worktreePath)).toBe(true);
    expect(existsSync(path.join(workdir, 'denied.ts'))).toBe(false);

    // Unattended: the card stays pending, nothing is merged.
    domain(stack).unattended.enable({ hours: null, acknowledgeRisk: true });
    llm.script('mock-main', [
      step().expect(isTaskRequest('TASK-UNATTENDED')).replyToolCall('write', {
        path: 'unattended.ts',
        content: 'never auto applied\n',
      }),
      step().expect(isTaskRequest('TASK-UNATTENDED')).replyText('完成'),
      step().inTurn().replyText('收到'),
    ]);
    const second = host(stack).start(turnIdentity(bot.id, conv.id), {
      title: '无人值守',
      instruction: 'TASK-UNATTENDED',
      sourceMessageIds: [],
      writes: true,
      isolation: 'worktree',
    });
    await waitStatus(stack, second.taskId, 'completed', 'unattended task completed');
    const unattendedCard = await waitWorktreeApply(stack, conv.id, second.taskId);
    expect(unattendedCard.autoApproved).toBe(false);
    await waitFor(
      () =>
        (viewOf(stack, second.taskId)?.applyState === 'pending' && !existsSync(path.join(workdir, 'unattended.ts'))
          ? true
          : null),
      { label: 'unattended card left pending', timeoutMs: 30_000 },
    );
    domain(stack).unattended.disable('测试结束');
  }, 90_000);

  it('refuses to apply while a task writes the workdir: card failed, tree kept, task untouched', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const bot = await makeBot(core, '占用');
    const conv = await openDirect(core, bot.id);
    const workdir = await bindWorkdir(stack, conv.id, makeRepo());
    llm.script('mock-main', [
      // A main-workdir task grabs the shared write lease and stays there.
      step().expect(isTaskRequest('TASK-BUSY-MAIN')).replyToolCall('write', {
        path: 'main.ts',
        content: 'main\n',
      }),
      step().expect(isTaskRequest('TASK-BUSY-MAIN')).replyText('主目录完成').hold(),
      // The isolated task completes while the workdir is leased.
      step().expect(isTaskRequest('TASK-BUSY-WT')).replyToolCall('write', {
        path: 'wt.ts',
        content: 'wt\n',
      }),
      step().expect(isTaskRequest('TASK-BUSY-WT')).replyText('隔离完成'),
      step().inTurn().replyText('收到'),
      step().inTurn().replyText('收到'),
    ]);
    const main = host(stack).start(turnIdentity(bot.id, conv.id), {
      title: '主目录占用',
      instruction: 'TASK-BUSY-MAIN',
      sourceMessageIds: [],
      writes: true,
    });
    await waitFor(() => (runOf(stack, main.taskId).status === 'running' ? true : null), {
      label: 'main workdir task running',
      timeoutMs: 30_000,
    });
    await waitFor(() => (existsSync(path.join(workdir, 'main.ts')) ? true : null), {
      label: 'main workdir write landed',
      timeoutMs: 30_000,
    });

    const isolated = host(stack).start(turnIdentity(bot.id, conv.id), {
      title: '隔离',
      instruction: 'TASK-BUSY-WT',
      sourceMessageIds: [],
      writes: true,
      isolation: 'worktree',
    });
    await waitStatus(stack, isolated.taskId, 'completed', 'isolated task completed');
    const card = await waitWorktreeApply(stack, conv.id, isolated.taskId);
    const payload = card.payload as { worktreePath: string };
    expect(runOf(stack, main.taskId).status).toBe('running');

    await core.rpc.call('approvals.decide', { id: card.id, approve: true });
    const failed = await waitFor(
      async () => {
        const listed = (await core.rpc.call('approvals.list', { conversationId: conv.id })) as {
          approvals: Approval[];
        };
        const current = listed.approvals.find((approval) => approval.id === card.id);
        return current !== undefined && current.status === 'failed' ? current : null;
      },
      { label: 'apply refused while the workdir is leased', timeoutMs: 30_000 },
    );
    expect(String(failed.decision?.error ?? '')).toContain('稍后重试');
    // Nothing landed, the tree keeps the work, and the writing task was never
    // interrupted.
    expect(existsSync(path.join(workdir, 'wt.ts'))).toBe(false);
    expect(readFileSync(path.join(payload.worktreePath, 'wt.ts'), 'utf8')).toBe('wt\n');
    expect(runOf(stack, main.taskId).status).toBe('running');
    await waitFor(() => (viewOf(stack, isolated.taskId)?.applyState === 'kept' ? true : null), {
      label: 'apply state kept after the refusal',
    });

    llm.releaseAll();
    await waitStatus(stack, main.taskId, 'completed', 'main task completed');
  }, 90_000);

  it('retry creates a new tree; a continuation returns to the main workdir', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const bot = await makeBot(core, '重试');
    const conv = await openDirect(core, bot.id);
    const workdir = await bindWorkdir(stack, conv.id, makeRepo());
    llm.script('mock-main', [
      step().expect(isTaskRequest('TASK-RETRY')).replyText('先占住').hold(),
      step().expect(isTaskRequest('TASK-RETRY')).replyText('第二次完成'),
      step().inTurn().replyText('收到'),
      step().inTurn().replyText('收到'),
    ]);
    const first = host(stack).start(turnIdentity(bot.id, conv.id), {
      title: '重试',
      instruction: 'TASK-RETRY',
      sourceMessageIds: [],
      writes: true,
      isolation: 'worktree',
    });
    const firstRun = await waitFor(
      () => {
        const run = runOf(stack, first.taskId);
        return run.status === 'running' && run.worktreePath !== null ? run : null;
      },
      { label: 'first worktree task running', timeoutMs: 30_000 },
    );
    // Force a failure (no changes in the tree → no apply card). The held model
    // call is released so its provider slot does not delay the retry.
    host(stack).settle(first.taskId, { status: 'failed', error: 'boom' });
    llm.releaseAll();
    await waitFor(() => (runOf(stack, first.taskId).status === 'failed' ? true : null), {
      label: 'first task failed',
    });
    // The user commits in the meantime: the retry must start from the NEW HEAD.
    writeFileSync(path.join(workdir, 'README.md'), '# base\nuser commit\n');
    git(workdir, ['add', '-A']);
    git(workdir, ['commit', '-q', '-m', 'user work between attempts']);
    const headBeforeRetry = git(workdir, ['rev-parse', 'HEAD']).trim();
    expect(headBeforeRetry).not.toBe(firstRun.worktreeBase);
    const retried = host(stack).retry(first.taskId);
    expect(retried.isolation).toBe('worktree');
    // The row names the MAIN workdir until the new tree exists — never the
    // previous attempt's tree.
    expect(retried.taskCwd).toBe(workdir);
    expect(retried.worktreePath).toBeNull();
    // The retry can finish before the first poll sees `running`: accept the
    // terminal state too (the tree path is what this case checks). A failed
    // create leaves worktreePath null — still return so the assertion below
    // can surface `run.error` instead of timing out.
    let lastRetryState = 'not polled';
    let retriedRun: Run;
    try {
      retriedRun = await waitFor(
        () => {
          const run = runOf(stack, retried.id);
          lastRetryState = `status=${run.status} path=${run.worktreePath} error=${run.error ?? ''} cwd=${run.taskCwd}`;
          if (
            run.worktreePath !== null &&
            (run.status === 'running' ||
              run.status === 'completed' ||
              run.status === 'failed' ||
              run.status === 'interrupted' ||
              run.status === 'cancelled')
          ) {
            return run;
          }
          if (
            run.status === 'failed' ||
            run.status === 'interrupted' ||
            run.status === 'cancelled'
          ) {
            return run;
          }
          return null;
        },
        { label: 'retried worktree task started', timeoutMs: 30_000 },
      );
    } catch (error) {
      throw new Error(`retried worktree task started (${lastRetryState})`, { cause: error });
    }
    expect(
      retriedRun.worktreePath,
      `retry did not create a tree (status=${retriedRun.status}, error=${retriedRun.error ?? ''}, cwd=${retriedRun.taskCwd})`,
    ).not.toBeNull();
    expect(retriedRun.worktreePath).not.toBe(firstRun.worktreePath);
    expect(path.dirname(retriedRun.worktreePath!)).toBe(path.dirname(firstRun.worktreePath!));
    expect(existsSync(firstRun.worktreePath!)).toBe(true);
    // The new tree is based on the then-current HEAD, not the old base.
    expect(retriedRun.worktreeBase).toBe(headBeforeRetry);

    // Continuation: no isolation inherited, cwd is the main workdir.
    llm.releaseAll();
    await waitStatus(stack, retried.id, 'completed', 'retried task completed');
    const continued = host(stack).start(turnIdentity(bot.id, conv.id), {
      title: '接续',
      instruction: 'TASK-RETRY',
      sourceMessageIds: [],
      writes: true,
      continuesTaskId: retried.id,
    });
    expect(runOf(stack, continued.taskId).taskCwd).toBe(workdir);
    expect(runOf(stack, continued.taskId).isolation).toBeNull();
  }, 90_000);

  it('refuses the merge when the conversation rebound its workdir after settlement', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const bot = await makeBot(core, '换目录');
    const conv = await openDirect(core, bot.id);
    const firstRepo = await bindWorkdir(stack, conv.id, makeRepo());
    llm.script('mock-main', [
      step().expect(isTaskRequest('TASK-REBIND')).replyToolCall('write', {
        path: 'rebound.ts',
        content: 'rebound\n',
      }),
      step().expect(isTaskRequest('TASK-REBIND')).replyText('完成'),
      step().inTurn().replyText('收到'),
    ]);
    const started = host(stack).start(turnIdentity(bot.id, conv.id), {
      title: '换目录',
      instruction: 'TASK-REBIND',
      sourceMessageIds: [],
      writes: true,
      isolation: 'worktree',
    });
    await waitStatus(stack, started.taskId, 'completed', 'task completed');
    const card = await waitWorktreeApply(stack, conv.id, started.taskId);
    const payload = card.payload as { worktreePath: string };
    // The task is terminal, so the user may switch workdirs before deciding.
    const secondRepo = await bindWorkdir(stack, conv.id, makeRepo());
    expect(secondRepo).not.toBe(firstRepo);

    await core.rpc.call('approvals.decide', { id: card.id, approve: true });
    const failed = await waitFor(
      async () => {
        const listed = (await core.rpc.call('approvals.list', { conversationId: conv.id })) as {
          approvals: Approval[];
        };
        const current = listed.approvals.find((approval) => approval.id === card.id);
        return current !== undefined && current.status === 'failed' ? current : null;
      },
      { label: 'apply refused after a rebind', timeoutMs: 30_000 },
    );
    expect(String(failed.decision?.error ?? '')).toContain('工作目录已变更');
    expect(existsSync(path.join(secondRepo, 'rebound.ts'))).toBe(false);
    expect(existsSync(path.join(firstRepo, 'rebound.ts'))).toBe(false);
    expect(existsSync(path.join(payload.worktreePath, 'rebound.ts'))).toBe(true);
    await waitFor(() => (viewOf(stack, started.taskId)?.applyState === 'kept' ? true : null), {
      label: 'apply state kept after a rebind',
    });
  }, 90_000);

  it('startup recovery keeps a crashed task tree (no card); the startup reaper collects aged orphans and audits it', async () => {
    const home = await createTestHome('d140-wt-restart-');
    dirs.push(home.home);
    // The file keystore keeps the master key in the (shared) test home, so the
    // restarted core can open the same encrypted databases.
    const env = { KEPCUP_KEYSTORE: 'file' };
    const first = await createTestStack({ home: home.home, env });
    const { core } = first;
    const bot = await makeBot(core, '崩溃');
    const conv = await openDirect(core, bot.id);
    const workdir = await bindWorkdir(first, conv.id, makeRepo());
    const worktrees = core.services.worktrees!;
    expect(worktrees).not.toBeNull();
    // The crashed task's tree (it never settles in this process).
    const crashedTree = await worktrees.create({ workdirPath: workdir, runId: 'run_crashed_w5' });
    writeFileSync(path.join(crashedTree.path, 'partial.ts'), 'partial work\n');
    const crashed = domain(first).runs.create({
      botId: bot.id,
      conversationId: conv.id,
      loopType: 'task',
      triggerReason: null,
      triggerMessageIds: [],
      taskTitle: '崩溃前',
      taskWrites: true,
      taskCwd: crashedTree.path,
      isolation: 'worktree',
      worktreePath: crashedTree.path,
      worktreeBase: crashedTree.baseOid,
    });
    domain(first).runs.update(crashed.id, { status: 'running' });
    // An aged orphan: no task row at all.
    const orphan = await worktrees.create({ workdirPath: workdir, runId: 'run_orphan_w5' });
    writeFileSync(path.join(orphan.path, 'old.ts'), 'old\n');
    const old = Date.now() - 30 * 24 * 60 * 60_000;
    utimesSync(orphan.path, new Date(old), new Date(old));

    await first.cleanup();

    // Restart on the same home: recovery marks the crashed task interrupted
    // (its tree kept, no apply card) and the startup sweep reaps the orphan.
    const second = await createTestStack({ home: home.home, env });
    stacks.push(second);
    const interrupted = await waitFor(
      () => {
        const run = runOf(second, crashed.id);
        return run.status === 'interrupted' ? run : null;
      },
      { label: 'crashed worktree task interrupted', timeoutMs: 30_000 },
    );
    expect(interrupted.worktreePath).toBe(crashedTree.path);
    await waitFor(() => (viewOf(second, crashed.id)?.applyState === 'kept' ? true : null), {
      label: 'recovered tree kept',
    });
    const listed = (await second.core.rpc.call('approvals.list', { conversationId: conv.id })) as {
      approvals: Approval[];
    };
    expect(listed.approvals.some((approval) => approval.kind === 'worktree_apply')).toBe(false);
    expect(existsSync(path.join(crashedTree.path, 'partial.ts'))).toBe(true);

    await waitFor(() => (existsSync(orphan.path) ? null : true), {
      label: 'aged orphan reaped at startup',
      timeoutMs: 30_000,
    });
    expect(existsSync(crashedTree.path)).toBe(true);
    expect(git(workdir, ['worktree', 'list'])).not.toContain(orphan.path);
    const auditRows = await waitFor(
      () => {
        const rows = second.core.services.mainDb!
          .prepare("select detail_json from audit_log where action = 'worktree_reaped'")
          .all() as Array<{ detail_json: string }>;
        return rows.length > 0 ? rows : null;
      },
      { label: 'worktree_reaped audit', timeoutMs: 30_000 },
    );
    expect(auditRows.map((row) => row.detail_json).join('')).toContain(orphan.path);
  }, 120_000);

  it('refuses isolation for cwd:workspace, read-only tasks and external engines; a non-git workdir fails the task', async () => {
    const stack = await start({ agentCatalog: [fakeAgentEntry('claude')] });
    const { core } = stack;
    const bot = await makeBot(core, '校验');
    const conv = await openDirect(core, bot.id);
    const workdir = await bindWorkdir(stack, conv.id, makeRepo());

    expect(() =>
      host(stack).start(turnIdentity(bot.id, conv.id), {
        title: '工作区',
        instruction: 'x',
        sourceMessageIds: [],
        writes: true,
        cwd: 'workspace',
        isolation: 'worktree',
      }),
    ).toThrow(/cwd 为绑定的工作目录/);
    expect(() =>
      host(stack).start(turnIdentity(bot.id, conv.id), {
        title: '只读',
        instruction: 'x',
        sourceMessageIds: [],
        writes: false,
        isolation: 'worktree',
      }),
    ).toThrow(/只用于写任务/);

    // External engine bot.
    const agentBot: Bot = await makeBot(core, '外援');
    const profile = {
      ...agentBot.profile,
      runtime: { ...agentBot.profile.runtime, agent: { ...agentBot.profile.runtime.agent, id: 'claude' } },
    };
    await core.rpc.call('bots.update', { id: agentBot.id, profile });
    const agentConv = await openDirect(core, agentBot.id);
    await bindWorkdir(stack, agentConv.id, workdir);
    expect(() =>
      host(stack).start(turnIdentity(agentBot.id, agentConv.id), {
        title: '外援',
        instruction: 'x',
        sourceMessageIds: [],
        writes: true,
        isolation: 'worktree',
      }),
    ).toThrow(/只支持内置引擎/);

    // Non-git workdir: the task is created, then fails with the code.
    const plain = mkdtempSync(path.join(tmpdir(), 'd140-wt-plain-'));
    dirs.push(plain);
    const plainConv = await openDirect(core, bot.id);
    await bindWorkdir(stack, plainConv.id, plain);
    const failed = host(stack).start(turnIdentity(bot.id, plainConv.id), {
      title: '非 git',
      instruction: 'TASK-NON-GIT',
      sourceMessageIds: [],
      writes: true,
      isolation: 'worktree',
    });
    const run = await waitFor(
      () => {
        const current = runOf(stack, failed.taskId);
        return current.status === 'failed' ? current : null;
      },
      { label: 'non-git task failed', timeoutMs: 30_000 },
    );
    expect(run.error ?? '').toContain('WORKTREE_CREATE_FAILED');
    expect(run.isolation).toBe('worktree');
    expect(run.worktreePath).toBeNull();
    // No half-created tree is left next to the plain directory.
    const home = path.join(path.dirname(plain), '.worktree');
    expect(existsSync(home) ? existsSync(`${home}/${path.basename(plain)}`) : false).toBe(false);
  }, 60_000);
});

const describeNonSrt = process.platform === 'win32' ? describe : describe.skip;

describeNonSrt('D140-4 worktree isolation (non-srt backend)', () => {
  it('refuses isolation when the sandbox backend is not srt', async () => {
    const stack = await start();
    const { core } = stack;
    const bot = await makeBot(core, '校验');
    const conv = await openDirect(core, bot.id);
    await bindWorkdir(stack, conv.id, makeRepo());
    const failed = host(stack).start(turnIdentity(bot.id, conv.id), {
      title: '隔离',
      instruction: 'TASK-WT-WIN',
      sourceMessageIds: [],
      writes: true,
      isolation: 'worktree',
    });
    const run = await waitFor(
      () => {
        const current = runOf(stack, failed.taskId);
        return current.status === 'failed' ? current : null;
      },
      { label: 'non-srt worktree task failed', timeoutMs: 30_000 },
    );
    expect(run.error ?? '').toContain('WORKTREE_NOT_AVAILABLE');
    expect(run.worktreePath).toBeNull();
  }, 60_000);
});
