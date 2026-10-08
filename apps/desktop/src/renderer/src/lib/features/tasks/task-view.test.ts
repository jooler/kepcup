import { describe, expect, it } from 'vitest';
import type { TaskView } from '@kepcup/shared';
import { clipLine, isActiveTask, taskCardModel, taskStatusSummary } from './task-view';

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
