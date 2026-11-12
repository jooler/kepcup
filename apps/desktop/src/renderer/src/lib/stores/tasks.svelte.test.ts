import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskView } from '@kepcup/shared';

/**
 * 任务执行过程页的导航状态（docs/design/42-task-run-view.md）：打开时记下
 * taskId 并确保任务视图已加载，关闭时清空；空 id 不改变当前页面。
 */

const { calls, getResult, injectResult, eventHandlers, getDeferred } = vi.hoisted(() => ({
  calls: [] as Array<{ method: string; payload: Record<string, unknown> }>,
  getResult: { task: null as TaskView | null },
  injectResult: { delivery: 'delivered' as 'delivered' | 'queued' },
  eventHandlers: {} as Record<string, Array<(payload: unknown) => void>>,
  getDeferred: { promise: null as Promise<void> | null },
}));

vi.mock('$lib/rpc/client.svelte', () => ({
  core: {
    coreStatus: null,
    onEvent: (event: string, handler: (payload: unknown) => void) => {
      (eventHandlers[event] ??= []).push(handler);
      return () => {
        eventHandlers[event] = (eventHandlers[event] ?? []).filter((item) => item !== handler);
      };
    },
    call: async (method: string, payload: Record<string, unknown> = {}) => {
      calls.push({ method, payload });
      if (method === 'tasks.get') {
        if (getDeferred.promise !== null) await getDeferred.promise;
        return getResult;
      }
      if (method === 'tasks.active') return { tasks: [] };
      if (method === 'tasks.inject') return { delivery: injectResult.delivery };
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
    writeDomains: null,
    claims: [],
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
    getDeferred.promise = null;
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

  it('remembers the task page per conversation and restores it on return', () => {
    tasks.openDetail('task_a', null, 'conv_a');
    tasks.enterConversation('conv_b');
    expect(tasks.openTaskId).toBeNull();
    tasks.enterConversation('conv_a');
    expect(tasks.openTaskId).toBe('task_a');
    // Leaving the conversation (list / workbench) hides the page but keeps the memory.
    tasks.enterConversation(null);
    expect(tasks.openTaskId).toBeNull();
    tasks.enterConversation('conv_a');
    expect(tasks.openTaskId).toBe('task_a');
    // An explicit return forgets it: switching back lands on the message list.
    tasks.closeDetail();
    expect(tasks.openTaskId).toBeNull();
    tasks.enterConversation('conv_b');
    tasks.enterConversation('conv_a');
    expect(tasks.openTaskId).toBeNull();
    tasks.enterConversation(null);
  });

  it('forgets the page when its conversation is gone', () => {
    tasks.openDetail('task_gone', null, 'conv_gone');
    tasks.forgetConversation('conv_gone');
    expect(tasks.openTaskId).toBeNull();
    tasks.enterConversation('conv_other');
    tasks.enterConversation('conv_gone');
    expect(tasks.openTaskId).toBeNull();
    tasks.enterConversation(null);
  });
});

describe('tasks.inject（D115 任务直注，docs/design/56 §1）', () => {
  beforeEach(() => {
    calls.length = 0;
    injectResult.delivery = 'delivered';
  });

  it('sends tasks.inject and returns the delivery verdict', async () => {
    injectResult.delivery = 'queued';
    const delivery = await tasks.inject('task_1', '先看 README');
    expect(delivery).toBe('queued');
    expect(calls).toContainEqual({
      method: 'tasks.inject',
      payload: { taskId: 'task_1', text: '先看 README' },
    });
  });

  it('D115 附件直注：随注入携带 attachmentIds；纯附件允许空文本', async () => {
    await tasks.inject('task_1', '看看这张图', ['att_1']);
    expect(calls.at(-1)).toEqual({
      method: 'tasks.inject',
      payload: { taskId: 'task_1', text: '看看这张图', attachmentIds: ['att_1'] },
    });
    await tasks.inject('task_1', '', ['att_1']);
    expect(calls.at(-1)).toEqual({
      method: 'tasks.inject',
      payload: { taskId: 'task_1', text: '', attachmentIds: ['att_1'] },
    });
    // 无附件调用不携带 attachmentIds 字段（与既有契约兼容）。
    await tasks.inject('task_1', '纯文本');
    expect(calls.at(-1)).toEqual({
      method: 'tasks.inject',
      payload: { taskId: 'task_1', text: '纯文本' },
    });
  });
});

describe('终态 run.status 兜底刷新执行报告', () => {
  beforeEach(() => {
    calls.length = 0;
    getResult.task = null;
    getDeferred.promise = null;
    tasks.byId = {};
    tasks.closeDetail();
  });

  it('completed 的 run.status 会重拉任务视图（含 result），不长期停在进行中', async () => {
    const running = taskView('task_steer');
    tasks.byId = { task_steer: running };
    // 注册监听：open / ensure 会 start()。
    getResult.task = running;
    tasks.openDetail('task_steer');
    const completed: TaskView = {
      ...taskView('task_steer', 'completed'),
      result: { text: 'RESULT 直注完成', status: 'completed' },
    };
    getResult.task = completed;
    for (const handler of eventHandlers['run.status'] ?? []) {
      handler({ run: { id: 'task_steer', loopType: 'task', status: 'completed' } });
    }
    await vi.waitFor(() => {
      expect(tasks.byId['task_steer']?.state).toBe('completed');
      expect(tasks.byId['task_steer']?.result?.text).toBe('RESULT 直注完成');
    });
  });

  it('重拉得到的终态视图不会被在途的运行中 task.updated 丢掉', async () => {
    const running = taskView('task_steer');
    tasks.byId = { task_steer: running };
    getResult.task = running;
    tasks.openDetail('task_steer');
    const completed: TaskView = {
      ...taskView('task_steer', 'completed'),
      result: { text: 'RESULT 直注完成', status: 'completed' },
    };
    getResult.task = completed;
    let resume: () => void = () => undefined;
    getDeferred.promise = new Promise<void>((resolve) => {
      resume = resolve;
    });
    tasks.reload('task_steer');
    for (const handler of eventHandlers['task.updated'] ?? []) {
      handler({ task: running });
    }
    expect(tasks.byId['task_steer']?.state).toBe('running');
    resume();
    await vi.waitFor(() => {
      expect(tasks.byId['task_steer']?.state).toBe('completed');
      expect(tasks.byId['task_steer']?.result?.text).toBe('RESULT 直注完成');
    });
  });

  it('会话里来了新消息时，若任务视图仍是进行中则补拉终态报告', async () => {
    const running = taskView('task_steer');
    tasks.byId = { task_steer: running };
    getResult.task = running;
    tasks.openDetail('task_steer');
    const completed: TaskView = {
      ...taskView('task_steer', 'completed'),
      result: { text: 'RESULT 直注完成', status: 'completed' },
    };
    getResult.task = completed;
    for (const handler of eventHandlers['message.created'] ?? []) {
      handler({ conversationId: 'conv_1', message: { id: 'wake' } });
    }
    await vi.waitFor(() => {
      expect(tasks.byId['task_steer']?.state).toBe('completed');
      expect(tasks.byId['task_steer']?.result?.text).toBe('RESULT 直注完成');
    });
  });
});
