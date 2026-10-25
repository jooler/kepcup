import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskView } from '@kepcup/shared';

/**
 * 任务执行过程页的导航状态（docs/design/42-task-run-view.md）：打开时记下
 * taskId 并确保任务视图已加载，关闭时清空；空 id 不改变当前页面。
 */

const { calls, getResult } = vi.hoisted(() => ({
  calls: [] as Array<{ method: string; payload: Record<string, unknown> }>,
  getResult: { task: null as TaskView | null },
}));

vi.mock('$lib/rpc/client.svelte', () => ({
  core: {
    coreStatus: null,
    onEvent: () => () => undefined,
    call: async (method: string, payload: Record<string, unknown> = {}) => {
      calls.push({ method, payload });
      if (method === 'tasks.get') return getResult;
      if (method === 'tasks.active') return { tasks: [] };
      return {};
    },
  },
}));

const { tasks } = await import('./tasks.svelte');

function taskView(taskId: string, state: TaskView['state'] = 'running'): TaskView {
  return {
    taskId,
    botId: 'bot_1',
    conversationId: 'conv_1',
    title: `任务 ${taskId}`,
    state,
    status: state === 'completed' ? 'completed' : 'running',
    writes: false,
    cwdKind: 'workspace',
    queueReason: null,
    awaitingInput: false,
    questionMessageId: null,
    createdAt: 1,
    startedAt: 2,
    endedAt: state === 'completed' ? 3 : null,
    error: null,
    cancelReason: null,
    injects: [],
    lastProgress: null,
    changes: null,
    setup: null,
    continuesTaskId: null,
    continuedByTaskId: null,
    capabilities: [],
  };
}

describe('tasks.openDetail / closeDetail', () => {
  beforeEach(() => {
    calls.length = 0;
    getResult.task = null;
    tasks.byId = {};
    tasks.closeDetail();
  });

  it('opens the task and loads its view', async () => {
    const view = taskView('task_1');
    getResult.task = view;
    tasks.openDetail('task_1');
    expect(tasks.openTaskId).toBe('task_1');
    expect(calls).toContainEqual({ method: 'tasks.get', payload: { taskId: 'task_1' } });
    await vi.waitFor(() => expect(tasks.byId['task_1']).toEqual(view));
  });

  it('switches to another task', () => {
    tasks.openDetail('task_1');
    tasks.openDetail('task_2');
    expect(tasks.openTaskId).toBe('task_2');
  });

  it('keeps settled views for every conversation a session still holds', async () => {
    const settled = { ...taskView('done_a', 'completed'), conversationId: 'conv_a' };
    const other = { ...taskView('done_b', 'completed'), conversationId: 'conv_b' };
    const running = { ...taskView('run_c', 'running'), conversationId: 'conv_c' };
    tasks.byId = { done_a: settled, done_b: other, run_c: running };
    tasks.retain('conv_a');
    tasks.retain('conv_b');
    await tasks.loadActive('conv_a');
    expect(tasks.byId['done_a']).toEqual(settled);
    expect(tasks.byId['done_b']).toEqual(other);
    expect(tasks.byId['run_c']).toEqual(running);

    tasks.release('conv_b');
    expect(tasks.byId['done_b']).toBeUndefined();
    expect(tasks.byId['done_a']).toEqual(settled);
    expect(tasks.byId['run_c']).toEqual(running);
    tasks.release('conv_a');
  });

  it('ignores an empty id', () => {
    tasks.openDetail('task_1');
    tasks.openDetail('');
    expect(tasks.openTaskId).toBe('task_1');
  });

  it('closes the execution view', () => {
    tasks.openDetail('task_1');
    tasks.closeDetail();
    expect(tasks.openTaskId).toBeNull();
  });
});
