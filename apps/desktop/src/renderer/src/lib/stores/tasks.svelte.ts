import type { Run, TaskView } from '@kepcup/shared';
import { core } from '$lib/rpc/client.svelte';

/**
 * D75 任务（docs/design/30-supervisor-and-tasks.md §4.3 / §6.3）的渲染端缓存：
 * 任务卡、问题卡与状态行按 taskId 读任务视图，`task.updated` 推送实时重绘
 * （排队原因 → 执行中 → 追加 / 提问 → 结算）。懒启动：第一张任务卡或第一次
 * 打开会话时才订阅。
 */
class TasksState {
  byId = $state<Record<string, TaskView>>({});
  #started = false;
  #loading = new Set<string>();

  start(): void {
    if (this.#started) return;
    this.#started = true;
    core.onEvent('task.updated', (payload) => {
      const { task } = payload as { task: TaskView };
      this.byId = { ...this.byId, [task.taskId]: task };
    });
  }

  /** Loads a task view once (cards mount lazily while scrolling history). */
  async ensure(taskId: string): Promise<void> {
    this.start();
    if (taskId.length === 0 || this.byId[taskId] !== undefined || this.#loading.has(taskId)) return;
    this.#loading.add(taskId);
    try {
      const result = (await core.call('tasks.get', { taskId })) as { task: TaskView | null };
      // A task.updated that raced the call is newer: keep it.
      if (result.task !== null && this.byId[taskId] === undefined) {
        this.byId = { ...this.byId, [taskId]: result.task };
      }
    } catch {
      // Card falls back to its placeholder.
    } finally {
      this.#loading.delete(taskId);
    }
  }

  /** Seeds the conversation's in-flight tasks (status line on conversation open). */
  async loadActive(conversationId: string): Promise<void> {
    this.start();
    try {
      const result = (await core.call('tasks.active', { conversationId })) as {
        tasks: TaskView[];
      };
      if (result.tasks.length === 0) return;
      const next = { ...this.byId };
      for (const task of result.tasks) next[task.taskId] = task;
      this.byId = next;
    } catch {
      // The status line falls back to the run rows.
    }
  }

  /** Cancels a task from its card (the user's decision: no turn is woken, §3.3). */
  async cancel(taskId: string): Promise<void> {
    await core.call('runs.cancel', { runId: taskId });
  }

  /** Retries a failed task: a new task continuing it (§7.5); returns the new task's id. */
  async retry(taskId: string): Promise<string | null> {
    const result = (await core.call('runs.retry', { runId: taskId })) as { run: Run | null };
    return result.run?.id ?? null;
  }

  /** The user picked an option on a task question card: straight into the task (§2.4.6). */
  async answer(messageId: string, answer: string): Promise<void> {
    await core.call('tasks.answer', { messageId, answer });
  }
}

export const tasks = new TasksState();
