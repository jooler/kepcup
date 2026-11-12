import type { AskUserValues, Run, TaskView } from '@kepcup/shared';
import { core } from '$lib/rpc/client.svelte';
import { applyFetchedViews, isActiveTask, pruneTaskViewsMany } from '$lib/features/tasks/task-view';

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
  /**
   * 每个会话离开时停在哪个任务页。切会话只换可见页、不丢记忆，切回来
   * 原地恢复；只有显式返回（返回键 / Esc）或会话消失才忘掉。
   * 普通 Map（刻意非响应式）：台账，界面只从 `openTaskId` 派生。
   */
  readonly #openByConversation = new Map<string, string>();
  /** 可见任务页归属的会话（显式关闭时按它忘掉记忆）。 */
  #openConversationId: string | null = null;
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
      const current = this.byId[task.taskId];
      // 终态不可逆：忽略把已结算视图打回进行中的过期推送。
      if (current !== undefined && !isActiveTask(current) && isActiveTask(task)) return;
      this.#pushes += 1;
      this.#pushedAt.set(task.taskId, this.#pushes);
      this.byId = { ...this.byId, [task.taskId]: task };
    });
    // 终态 run.status 的兜底：结算视图（含执行报告）再拉一次。正常路径
    // 已由 task.updated 覆盖；详情页开着时若那次推送没落到缓存，卡片会
    // 一直停在「进行中」、报告出不来（v0.5.12 注入坞 e2e）。
    core.onEvent('run.status', (payload) => {
      const run = (payload as { run?: { id?: string; loopType?: string; status?: string } }).run;
      if (run?.loopType !== 'task' || typeof run.id !== 'string') return;
      if (
        run.status !== 'completed' &&
        run.status !== 'failed' &&
        run.status !== 'cancelled' &&
        run.status !== 'interrupted'
      ) {
        return;
      }
      void this.#reload(run.id);
    });
    // 结算同栈里的 task.updated / run.status 可能到不了渲染端，但随后的
    // 唤醒回复会推 message.created / conversation.updated（侧栏已有
    // 「任务做完了」）。此时再拉一次。
    const reloadActiveIn = (conversationId: string | undefined): void => {
      if (typeof conversationId !== 'string') return;
      for (const [taskId, view] of Object.entries(this.byId)) {
        if (
          (view.conversationId === conversationId || view.userConversationId === conversationId) &&
          isActiveTask(view)
        ) {
          void this.#reload(taskId);
        }
      }
    };
    core.onEvent('message.created', (payload) => {
      const data = payload as { conversationId?: string; message?: { conversationId?: string } };
      reloadActiveIn(data.conversationId ?? data.message?.conversationId);
    });
    core.onEvent('conversation.updated', (payload) => {
      reloadActiveIn((payload as { conversation?: { id?: string } }).conversation?.id);
    });
    // The core came back (restart / port rebind, 审查 L3): pushes sent while
    // disconnected are lost — reload the cached views.
    core.onEvent('core.status', (payload) => {
      if ((payload as { status?: string }).status !== 'ready') return;
      if (this.#sawReady) void this.refresh();
      this.#sawReady = true;
    });
  }

  /**
   * 按 id 重拉一张任务视图。详情页在仍显示「进行中」时也会轮询调用：
   * `ensure` 对已缓存的视图是空操作，不能用来接结算后的报告。
   */
  reload(taskId: string): void {
    if (taskId.length === 0) return;
    this.start();
    void this.#reload(taskId);
  }

  /**
   * 详情页已看到唤醒回复、但 tasks.get 仍返回进行中时的兜底：用时间线上的
   * 终态原文补一份结算视图，让报告卡出现、注入坞收起（v0.5.12 e2e）。
   * 若正在进行中的任务随后真的结算，正常 push / reload 会覆盖。
   */
  noteTerminalFromTranscript(taskId: string, text: string): void {
    const trimmed = text.trim();
    if (taskId.length === 0 || trimmed.length === 0) return;
    this.start();
    void this.#reload(taskId).then(() => {
      const current = this.byId[taskId];
      if (current === undefined || !isActiveTask(current)) return;
      this.byId = {
        ...this.byId,
        [taskId]: {
          ...current,
          state: 'completed',
          status: 'completed',
          result: { text: trimmed, status: 'completed' },
          queueReason: null,
        },
      };
    });
  }

  /** 终态 run.status / 详情页轮询的兜底重拉；有更新的 push 则不覆盖，除非拉到的是终态而缓存仍是进行中。 */
  async #reload(taskId: string): Promise<void> {
    const since = this.#pushes;
    try {
      const result = (await core.call('tasks.get', { taskId })) as { task: TaskView | null };
      if (result.task === null) return;
      const cached = this.byId[taskId];
      // 结算后仍可能有在途的运行中 task.updated 把 completed 的 fetch 按
      // newer-wins 丢掉，详情页会一直停在「进行中」、报告出不来（v0.5.12 e2e）。
      if (cached !== undefined && isActiveTask(cached) && !isActiveTask(result.task)) {
        this.byId = { ...this.byId, [taskId]: result.task };
        return;
      }
      // 缓存已是终态时，不要被仍返回进行中的 tasks.get（或随后的轮询）打回去。
      if (cached !== undefined && !isActiveTask(cached) && isActiveTask(result.task)) {
        return;
      }
      this.#apply([result.task], since);
    } catch {
      // The next task.updated push updates it.
    }
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
  openDetail(
    taskId: string,
    trigger: HTMLElement | null = null,
    conversationId: string | null = null,
  ): void {
    if (taskId.length === 0) return;
    this.#focusReturn = trigger ?? currentFocusElement();
    this.openTaskId = taskId;
    this.#openConversationId = conversationId;
    if (conversationId !== null) this.#openByConversation.set(conversationId, taskId);
    void this.ensure(taskId);
  }

  /**
   * The main area switched to `conversationId` (null when leaving it): show
   * the task page that conversation was left on. Switching bots does not
   * discard the other conversation's page, so coming back restores it.
   */
  enterConversation(conversationId: string | null): void {
    const next =
      conversationId === null ? null : (this.#openByConversation.get(conversationId) ?? null);
    if (next !== this.openTaskId) this.#focusReturn = null;
    this.#openConversationId = conversationId;
    this.openTaskId = next;
    if (next !== null) void this.ensure(next);
  }

  /** The conversation is gone (deleted conversation / removed bot): forget its task page. */
  forgetConversation(conversationId: string): void {
    this.#openByConversation.delete(conversationId);
    if (this.#openConversationId !== conversationId) return;
    this.#openConversationId = null;
    this.openTaskId = null;
  }

  /**
   * Returns from the task execution view to the conversation. The explicit
   * close also forgets the page, so a later switch back does not reopen it.
   * `restoreFocus` is only for explicit returns (back / Esc).
   */
  closeDetail(options: { restoreFocus?: boolean } = {}): void {
    if (this.#openConversationId !== null) {
      this.#openByConversation.delete(this.#openConversationId);
      this.#openConversationId = null;
    }
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

  /**
   * D115 任务直注（docs/design/56 §1）：用户在任务详情页注入坞追加指令（可直带
   * 附件），直达 `TaskHost.injectById`（复用 inject_task 语义）。返回 `delivery`：
   * `delivered`（时间线出现 steer 气泡 / 未启动并入简报）或 `queued`（外部
   * Agent 不支持中途插入，任务结束后生效）。
   */
  async inject(
    taskId: string,
    text: string,
    attachmentIds?: string[],
  ): Promise<'delivered' | 'queued'> {
    const result = (await core.call('tasks.inject', {
      taskId,
      text,
      ...(attachmentIds !== undefined && attachmentIds.length > 0 ? { attachmentIds } : {}),
    })) as {
      delivery: 'delivered' | 'queued';
    };
    return result.delivery;
  }
}

export const tasks = new TasksState();

/** `document.activeElement` when a DOM exists (store tests run without one). */
function currentFocusElement(): HTMLElement | null {
  if (typeof document === 'undefined' || typeof HTMLElement === 'undefined') return null;
  const active = document.activeElement;
  return active instanceof HTMLElement ? active : null;
}
