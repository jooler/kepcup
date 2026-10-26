import type { AskUserValues, Run, TaskView } from '@kepcup/shared';
import { core } from '$lib/rpc/client.svelte';
import { applyFetchedViews, pruneTaskViewsMany } from '$lib/features/tasks/task-view';

/**
 * D75 任务（docs/design/30-supervisor-and-tasks.md §4.3 / §6.3）的渲染端缓存：
 * 任务卡、问题卡与状态行按 taskId 读任务视图，`task.updated` 推送实时重绘
 * （排队原因 → 执行中 → 追加 / 提问 → 结算）。懒启动：第一张任务卡或第一次
 * 打开会话时才订阅。
 */
class TasksState {
  byId = $state<Record<string, TaskView>>({});
  /** The task whose execution view replaces the conversation (design 42). */
  openTaskId = $state<string | null>(null);
  #started = false;
  #loading = new Set<string>();
  /** Counter of `task.updated` pushes, and the last one per task (newer-wins, 审查 L2). */
  #pushes = 0;
  // Plain Map: bookkeeping, not UI state.
  readonly #pushedAt = new Map<string, number>();
  #sawReady = false;
  /**
   * Conversations a session still has open, with a refcount so two sessions
   * can share one id. Settled views of a conversation are dropped only when
   * the count hits zero. `openTaskId` stays the main task page.
   */
  readonly #useCount = new Map<string, number>();
  /** Element to focus after an explicit return from the execution view. */
  #focusReturn: HTMLElement | null = null;

  start(): void {
    if (this.#started) return;
    this.#started = true;
    // Started lazily: a ready core seen before counts as the first connection.
    this.#sawReady = core.coreStatus?.status === 'ready';
    core.onEvent('task.updated', (payload) => {
      const { task } = payload as { task: TaskView };
      this.#pushes += 1;
      this.#pushedAt.set(task.taskId, this.#pushes);
      this.byId = { ...this.byId, [task.taskId]: task };
    });
    // The core came back (restart / port rebind, 审查 L3): pushes sent while
    // disconnected are lost — reload the cached views.
    core.onEvent('core.status', (payload) => {
      if ((payload as { status?: string }).status !== 'ready') return;
      if (this.#sawReady) void this.refresh();
      this.#sawReady = true;
    });
  }

  /** Applies fetched views unless a push for the task arrived after `since`. */
  #apply(fetched: TaskView[], since: number): void {
    this.byId = applyFetchedViews(
      this.byId,
      fetched,
      (taskId) => (this.#pushedAt.get(taskId) ?? 0) > since,
    );
  }

  /** Opens the task execution view (task card click / its keyboard entry). */
  openDetail(taskId: string, trigger: HTMLElement | null = null): void {
    if (taskId.length === 0) return;
    this.#focusReturn = trigger ?? currentFocusElement();
    this.openTaskId = taskId;
    void this.ensure(taskId);
  }

  /**
   * Returns from the task execution view to the conversation. `restoreFocus`
   * is only for explicit returns (back / Esc): session switches close the view
   * without stealing focus back to a card that may be going away.
   */
  closeDetail(options: { restoreFocus?: boolean } = {}): void {
    if (this.openTaskId === null) return;
    this.openTaskId = null;
    const target = options.restoreFocus === true ? this.#focusReturn : null;
    this.#focusReturn = null;
    if (target === null) return;
    // A timer (not a microtask) runs after Svelte restored the conversation's
    // display, so the hidden trigger is focusable again.
    setTimeout(() => {
      if (target.isConnected) target.focus({ preventScroll: true });
    }, 0);
  }

  /** Loads a task view once (cards mount lazily while scrolling history). */
  async ensure(taskId: string): Promise<void> {
    this.start();
    if (taskId.length === 0 || this.byId[taskId] !== undefined || this.#loading.has(taskId)) return;
    this.#loading.add(taskId);
    const since = this.#pushes;
    try {
      const result = (await core.call('tasks.get', { taskId })) as { task: TaskView | null };
      // A task.updated that raced the call is newer: keep it.
      if (result.task !== null) this.#apply([result.task], since);
    } catch {
      // Card falls back to its placeholder.
    } finally {
      this.#loading.delete(taskId);
    }
  }

  /**
   * Seeds the conversation's in-flight tasks (status line on conversation
   * open) — same newer-wins rule as `ensure` (审查 L2) — and drops settled
   * views of other conversations (审查 L3).
   */
  /** Mark a conversation as still on screen. Idempotent per session, not per call. */
  retain(conversationId: string): void {
    this.#useCount.set(conversationId, (this.#useCount.get(conversationId) ?? 0) + 1);
  }

  /** A session left this conversation. Prunes its settled views when unused. */
  release(conversationId: string): void {
    const next = (this.#useCount.get(conversationId) ?? 0) - 1;
    if (next <= 0) this.#useCount.delete(conversationId);
    else this.#useCount.set(conversationId, next);
    this.byId = pruneTaskViewsMany(this.byId, new Set(this.#useCount.keys()));
  }

  async loadActive(conversationId: string): Promise<void> {
    this.start();
    // Plain Set: prune filter, not UI state.
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    const keep = new Set(this.#useCount.keys());
    keep.add(conversationId);
    this.byId = pruneTaskViewsMany(this.byId, keep);
    for (const taskId of [...this.#pushedAt.keys()]) {
      if (this.byId[taskId] === undefined) this.#pushedAt.delete(taskId);
    }
    const since = this.#pushes;
    try {
      const result = (await core.call('tasks.active', { conversationId })) as {
        tasks: TaskView[];
      };
      this.#apply(result.tasks, since);
    } catch {
      // The status line falls back to the run rows.
    }
  }

  /** Reloads every cached view (after a core reconnect, 审查 L3). */
  async refresh(): Promise<void> {
    const since = this.#pushes;
    const ids = Object.keys(this.byId);
    const fetched: TaskView[] = [];
    const gone: string[] = [];
    await Promise.all(
      ids.map(async (taskId) => {
        try {
          const result = (await core.call('tasks.get', { taskId })) as { task: TaskView | null };
          if (result.task !== null) fetched.push(result.task);
          else gone.push(taskId);
        } catch {
          // Keep the cached view; the next push updates it.
        }
      }),
    );
    let next = applyFetchedViews(
      this.byId,
      fetched,
      (taskId) => (this.#pushedAt.get(taskId) ?? 0) > since,
    );
    if (gone.length > 0) {
      next = { ...next };
      for (const taskId of gone) delete next[taskId];
    }
    this.byId = next;
    for (const conversationId of this.#useCount.keys()) await this.loadActive(conversationId);
  }

  /** Cancels a task from its card (the user's decision: no turn is woken, §3.3). */
  async cancel(taskId: string): Promise<void> {
    await core.call('runs.cancel', { runId: taskId });
  }

  /**
   * Retries a failed / interrupted task: a new task continuing it (§7.5);
   * returns the new task's id. `reviewed` (W3): the user ticked 我已核实 on the
   * review panel of an interrupted task with external effects.
   */
  async retry(taskId: string, reviewed = false): Promise<string | null> {
    const result = (await core.call('runs.retry', {
      runId: taskId,
      ...(reviewed ? { reviewed: true } : {}),
    })) as { run: Run | null };
    return result.run?.id ?? null;
  }

  /** The user picked an option on a task question card: straight into the task (§2.4.6). */
  async answer(messageId: string, answer: string, values?: AskUserValues): Promise<void> {
    await core.call('tasks.answer', {
      messageId,
      answer,
      ...(values !== undefined ? { values } : {}),
    });
  }
}

export const tasks = new TasksState();

/** `document.activeElement` when a DOM exists (store tests run without one). */
function currentFocusElement(): HTMLElement | null {
  if (typeof document === 'undefined' || typeof HTMLElement === 'undefined') return null;
  const active = document.activeElement;
  return active instanceof HTMLElement ? active : null;
}
