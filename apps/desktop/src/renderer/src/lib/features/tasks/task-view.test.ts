import { describe, expect, it } from 'vitest';
import type { Run, TaskView } from '@kepcup/shared';
import {
  activeRunsOf,
  applyFetchedViews,
  clipLine,
  effectBadge,
  isActiveTask,
  pruneTaskViews,
  taskCardModel,
  taskStatusSummary,
} from './task-view';

/** 任务卡 / 状态行的展示逻辑（D75 W3，design 30 §4.3 / §6.3）。 */

function view(overrides: Partial<TaskView> = {}): TaskView {
  return {
    taskId: 'run_t1',
    botId: 'bot_a',
    conversationId: 'conv',
    title: '补全测试',
    state: 'running',
    status: 'running',
    writes: true,
    workdirKind: 'project',
    queueReason: null,
    awaitingInput: false,
    questionMessageId: null,
    createdAt: 1,
    startedAt: 2,
    endedAt: null,
    error: null,
    cancelReason: null,
    injects: [],
    lastProgress: null,
    changes: null,
    setup: null,
    continuesTaskId: null,
    continuedByTaskId: null,
    ...overrides,
  };
}

describe('taskCardModel', () => {
  it('a submitted task shows its queue reason and can be cancelled', () => {
    const model = taskCardModel(
      view({ state: 'submitted', status: 'queued', queueReason: '等写入租约（任务 run_x 持有）' }),
    );
    expect(model.queueReason).toBe('等写入租约（任务 run_x 持有）');
    expect(model.canCancel).toBe(true);
    expect(model.canRetry).toBe(false);
    expect(model.changes).toBeNull();
    // No reason known yet → '' (the card says "即将开始").
    expect(taskCardModel(view({ state: 'submitted', status: 'queued' })).queueReason).toBe('');
  });

  it('a running task shows its latest progress; no change summary while it runs', () => {
    const model = taskCardModel(view({ lastProgress: '正在运行 pnpm test' }));
    expect(model.progress).toBe('正在运行 pnpm test');
    expect(model.queueReason).toBeNull();
    expect(model.changes).toBeNull();
    expect(model.canCancel).toBe(true);
  });

  it('a cancelled project write task offers the whole-run revert with its counts', () => {
    const model = taskCardModel(
      view({
        state: 'cancelled',
        status: 'cancelled',
        cancelReason: '用户改主意',
        changes: { kind: 'project', added: 1, modified: 2, deleted: 0, reverted: false },
      }),
    );
    expect(model.cancelReason).toBe('用户改主意');
    expect(model.changes).toEqual({
      kind: 'project',
      added: 1,
      modified: 2,
      deleted: 0,
      reverted: false,
    });
    expect(model.canRevert).toBe(true);
    expect(model.canCancel).toBe(false);
    // Already reverted → no second revert.
    expect(
      taskCardModel(
        view({
          state: 'cancelled',
          status: 'cancelled',
          changes: { kind: 'project', added: 1, modified: 0, deleted: 0, reverted: true },
        }),
      ).canRevert,
    ).toBe(false);
  });

  it('a cancelled workspace write task says plainly there is no revert, even without recorded files', () => {
    const withFiles = taskCardModel(
      view({
        state: 'cancelled',
        status: 'cancelled',
        workdirKind: 'workspace',
        changes: { kind: 'workspace', files: ['notes/a.txt'], more: 0 },
      }),
    );
    expect(withFiles.changes).toEqual({ kind: 'workspace', files: ['notes/a.txt'], more: 0 });
    expect(withFiles.canRevert).toBe(false);
    const none = taskCardModel(
      view({ state: 'cancelled', status: 'cancelled', workdirKind: 'workspace' }),
    );
    expect(none.changes).toEqual({ kind: 'workspace', files: [], more: 0 });
    // A project task without changes: "no file changes".
    expect(taskCardModel(view({ state: 'cancelled', status: 'cancelled' })).changes).toEqual({
      kind: 'none',
    });
    // Read-only tasks never show a change summary.
    expect(
      taskCardModel(view({ state: 'cancelled', status: 'cancelled', writes: false })).changes,
    ).toBeNull();
  });

  it('a failed task can be retried once; a setup failure defers to the setup card', () => {
    const failed = taskCardModel(
      view({ state: 'failed', status: 'failed', error: '模型认证失败' }),
    );
    expect(failed).toMatchObject({ tone: 'error', canRetry: true, errorLine: '模型认证失败' });
    expect(
      taskCardModel(view({ state: 'failed', status: 'failed', continuedByTaskId: 'run_t2' }))
        .canRetry,
    ).toBe(false);
    const setup = taskCardModel(
      view({ state: 'failed', status: 'failed', setup: { kind: 'main-model' } }),
    );
    expect(setup.canRetry).toBe(false);
    expect(setup.setupHint).toBe(true);
  });

  it('W3: an interrupted task can be retried; with external effects the retry needs a review', () => {
    // Old interrupted tasks (no ledger rows) → plain retry.
    const plain = taskCardModel(
      view({ state: 'interrupted', status: 'interrupted', error: '应用退出，任务中断' }),
    );
    expect(plain).toMatchObject({
      tone: 'error',
      canRetry: true,
      needsReview: false,
      revoked: false,
      errorLine: '应用退出，任务中断',
    });
    // External effects left behind → 检查后重试.
    const review = taskCardModel(
      view({ state: 'interrupted', status: 'interrupted', reviewRequired: true }),
    );
    expect(review).toMatchObject({ canRetry: true, needsReview: true });
    // Already retried / waiting on a setup → no retry at all.
    expect(
      taskCardModel(
        view({
          state: 'interrupted',
          status: 'interrupted',
          reviewRequired: true,
          continuedByTaskId: 'run_t2',
        }),
      ),
    ).toMatchObject({ canRetry: false, needsReview: false });
    // A failed task never needs the review (the gate is for interruptions).
    expect(
      taskCardModel(view({ state: 'failed', status: 'failed', reviewRequired: true })).needsReview,
    ).toBe(false);
  });

  it('W3: a task interrupted by a revoked permission shows the fixed reason', () => {
    const model = taskCardModel(
      view({
        state: 'interrupted',
        status: 'interrupted',
        error: '授权已被撤销，任务已中断。请检查已完成的操作后再重试',
        errorReason: 'permission_revoked',
      }),
    );
    expect(model.revoked).toBe(true);
    expect(model.errorLine).toBeNull();
    expect(model.canRetry).toBe(true);
  });

  it('W8: a task interrupted by a browser profile switch shows its own fixed reason', () => {
    const model = taskCardModel(
      view({
        state: 'interrupted',
        status: 'interrupted',
        error: '浏览器资料已切换，任务已中断。请检查已完成的操作后再重试',
        errorReason: 'browser_profile_changed',
      }),
    );
    expect(model.revoked).toBe(true);
    expect(model.interruptReason).toBe('browser_profile_changed');
    expect(model.errorLine).toBeNull();
    expect(model.canRetry).toBe(true);
  });

  it('W3 / W4: ledger statuses map to the review badges', () => {
    expect(effectBadge('completed')).toBe('completed');
    expect(effectBadge('uncertain')).toBe('uncertain');
    expect(effectBadge('executing')).toBe('uncertain');
    // W4: intended = waiting on its approval, never ran — not 结果未知.
    expect(effectBadge('intended')).toBe('pending');
    expect(effectBadge('failed')).toBe('failed');
    expect(effectBadge('denied')).toBe('denied');
  });

  it('a completed task has no change summary (its run-changes card covers project tasks)', () => {
    const model = taskCardModel(
      view({
        state: 'completed',
        status: 'completed',
        changes: { kind: 'project', added: 1, modified: 0, deleted: 0, reverted: false },
      }),
    );
    expect(model.changes).toBeNull();
    expect(model.canCancel || model.canRetry || model.canRevert).toBe(false);
  });
});

describe('status line helpers', () => {
  it('isActiveTask covers submitted and running only', () => {
    expect(isActiveTask({ state: 'submitted' })).toBe(true);
    expect(isActiveTask({ state: 'running' })).toBe(true);
    expect(isActiveTask({ state: 'completed' })).toBe(false);
    expect(isActiveTask({ state: 'cancelled' })).toBe(false);
  });

  it('summarizes several tasks by count and the most recent activity', () => {
    const summary = taskStatusSummary([
      { taskId: 'a', title: 'A', activity: '正在读取文件…', queued: false, at: 10 },
      { taskId: 'b', title: 'B', activity: '正在执行命令…', queued: false, at: 30 },
      { taskId: 'c', title: 'C', activity: '排队中', queued: true, at: 20 },
    ]);
    expect(summary.count).toBe(3);
    expect(summary.latest?.taskId).toBe('b');
    expect(taskStatusSummary([])).toEqual({ count: 0, latest: null });
  });

  it('clips long inject / progress lines to one line', () => {
    expect(clipLine('  a\n b  ')).toBe('a b');
    expect(clipLine('x'.repeat(200), 10)).toBe(`${'x'.repeat(10)}…`);
  });
});

describe('task view cache (审查 L2 / L3)', () => {
  it('a fetched view does not overwrite a newer task.updated push', () => {
    const pushed = view({ taskId: 'run_a', state: 'completed', status: 'completed' });
    const other = view({ taskId: 'run_b' });
    const byId = { run_a: pushed };
    // tasks.active answered with a stale running view of run_a (pushed meanwhile)
    // and a view of run_b nobody pushed.
    const next = applyFetchedViews(
      byId,
      [view({ taskId: 'run_a' }), other],
      (taskId) => taskId === 'run_a',
    );
    expect(next['run_a']).toBe(pushed);
    expect(next['run_b']).toBe(other);
    // Without a newer push the fetched view replaces the cached one.
    const fresh = view({ taskId: 'run_a', lastProgress: '新进度' });
    expect(applyFetchedViews(byId, [fresh], () => false)['run_a']).toBe(fresh);
    // Nothing applicable: the same object (no reactive churn).
    expect(applyFetchedViews(byId, [view({ taskId: 'run_a' })], () => true)).toBe(byId);
  });

  it('pruning keeps the open conversation and in-flight tasks only', () => {
    const byId = {
      here: view({ taskId: 'here', conversationId: 'c1', state: 'completed', status: 'completed' }),
      live: view({ taskId: 'live', conversationId: 'c2' }),
      old: view({ taskId: 'old', conversationId: 'c2', state: 'failed', status: 'failed' }),
    };
    expect(Object.keys(pruneTaskViews(byId, 'c1')).sort()).toEqual(['here', 'live']);
    const kept = { here: byId.here };
    expect(pruneTaskViews(kept, 'c1')).toBe(kept);
  });

  it('the status line seed includes active runs older than the latest page', () => {
    const run = (id: string, status: Run['status']) => ({ id, status }) as unknown as Run;
    const active = (r: Run) => r.status === 'running' || r.status === 'queued';
    const latest = [run('turn_new', 'completed'), run('task_new', 'running')];
    const all = [run('task_old', 'running'), run('task_new', 'running')];
    expect(activeRunsOf(latest, all, active).map((r) => r.id)).toEqual(['task_new', 'task_old']);
  });
});
