import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskView } from '@kepcup/shared';

/**
 * D116 每 Bot 任务列表 store（docs/design/56 §2）：`tasks.listByBot` 拉取 +
 * `task.updated` 按 botId 过滤续期——已有行原位替换（不打破倒序），新任务插到
 * 最前，别的 Bot 的推送忽略。RightPanel 的 tab 徽标与 BotTasksPanel 共用。
 */

const { calls, listResult, handlers } = vi.hoisted(() => ({
  calls: [] as Array<{ method: string; payload: Record<string, unknown> }>,
  listResult: { tasks: [] as TaskView[] },
  handlers: {} as Record<string, (payload: unknown) => void>,
}));

vi.mock('$lib/rpc/client.svelte', () => ({
  core: {
    coreStatus: null,
    onEvent: (event: string, handler: (payload: unknown) => void) => {
      handlers[event] = handler;
      return () => undefined;
    },
    call: async (method: string, payload: Record<string, unknown> = {}) => {
      calls.push({ method, payload });
      if (method === 'tasks.listByBot') return listResult;
      return {};
    },
  },
}));

const { botTasks } = await import('./bot-tasks.svelte');

function taskView(taskId: string, overrides: Partial<TaskView> = {}): TaskView {
  return {
    taskId,
    botId: 'bot_1',
    conversationId: 'conv_1',
    title: `任务 ${taskId}`,
    state: 'running',
    status: 'running',
    writes: false,
    cwdKind: 'workspace',
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
    capabilities: [],
    ...overrides,
  };
}

describe('botTasks（D116 每 Bot 任务列表）', () => {
  beforeEach(() => {
    calls.length = 0;
    listResult.tasks = [];
    botTasks.botId = null;
    botTasks.items = [];
    botTasks.loading = false;
  });

  it('loads the bot task list and re-loads on bot switch', async () => {
    listResult.tasks = [taskView('task_1')];
    await botTasks.load('bot_1');
    expect(calls).toContainEqual({ method: 'tasks.listByBot', payload: { botId: 'bot_1' } });
    expect(botTasks.items.map((entry) => entry.taskId)).toEqual(['task_1']);

    listResult.tasks = [taskView('task_x', { botId: 'bot_2' })];
    await botTasks.load('bot_2');
    expect(botTasks.botId).toBe('bot_2');
    expect(botTasks.items.map((entry) => entry.taskId)).toEqual(['task_x']);
  });

  it('applies task.updated for the current bot: existing rows in place, new rows on top', async () => {
    listResult.tasks = [taskView('task_2', { createdAt: 2 }), taskView('task_1', { createdAt: 1 })];
    await botTasks.load('bot_1');
    expect(botTasks.items.map((entry) => entry.taskId)).toEqual(['task_2', 'task_1']);

    // 已有行原位替换：终态更新不打破 created_at 倒序。
    handlers['task.updated']?.({
      task: taskView('task_1', { state: 'completed', status: 'completed', endedAt: 9 }),
    });
    expect(botTasks.items.map((entry) => entry.taskId)).toEqual(['task_2', 'task_1']);
    expect(botTasks.items[1]!.state).toBe('completed');

    // 新派的任务是最新的：插到最前。
    handlers['task.updated']?.({ task: taskView('task_3', { createdAt: 3 }) });
    expect(botTasks.items.map((entry) => entry.taskId)).toEqual(['task_3', 'task_2', 'task_1']);

    // 其它 Bot 的推送忽略。
    handlers['task.updated']?.({ task: taskView('task_other', { botId: 'bot_9' }) });
    expect(botTasks.items.map((entry) => entry.taskId)).toEqual(['task_3', 'task_2', 'task_1']);
  });

  it('ignores pushes after switching bots until the next load lands', async () => {
    listResult.tasks = [taskView('task_1')];
    await botTasks.load('bot_1');
    handlers['task.updated']?.({ task: taskView('task_stale', { botId: 'bot_2' }) });
    expect(botTasks.items.map((entry) => entry.taskId)).toEqual(['task_1']);
  });
});
