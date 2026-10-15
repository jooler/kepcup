import type { Memo, ScheduleEntry, TodoAssignee, TodoEntry } from '@kepcup/shared';
import { core } from '$lib/rpc/client.svelte';
import { shell } from '$lib/stores/shell.svelte';

/**
 * 工作台数据与抽屉状态（D90）。数据源是 `todos.list` / `schedules.list` / `memos.list`；
 * 刷新由 `todos.changed` / `memos.changed` / `schedules.changed` 事件驱动，去抖后整体重拉
 * （量级在千条以内，整体重拉最简单也不会漂移）。事件只在工作台挂载期间订阅，
 * 未打开时不做任何后台请求。
 *
 * 抽屉状态放这里而不是组件内：对话里的派发卡 / 回复标签「在工作台查看」要在切到工作台
 * 之前就指定好要打开哪个事项（`focusTodo`）。
 */

/** 事件到刷新之间的去抖（管家连续改多条时合并成一次拉取）。 */
export const REFRESH_DEBOUNCE_MS = 200;

export interface TodoPrefill {
  title?: string;
  notes?: string;
  memoId?: string;
  assignee?: TodoAssignee | null;
}

export type DrawerState = { kind: 'edit'; todoId: string } | { kind: 'new'; prefill: TodoPrefill };

export type LoadState = 'idle' | 'loading' | 'ready' | 'error';

type Fetcher = () => Promise<unknown>;

class WorkbenchState {
  todos = $state<TodoEntry[]>([]);
  /** `schedules.list` 全量（工作台只用其中非 workbench 来源的自排行）。 */
  schedules = $state<ScheduleEntry[]>([]);
  memos = $state<Memo[]>([]);
  /** 最近删除；只在打开该视图时拉取。 */
  trashed = $state<Memo[]>([]);
  trashOpen = $state(false);
  loadState = $state<LoadState>('idle');
  drawer = $state<DrawerState | null>(null);
  /** 每次 todos 重拉后 +1：抽屉据此重读自己打开的事项。 */
  todosVersion = $state(0);

  #attachCount = 0;
  #detach: Array<() => void> = [];
  #timers = new Map<string, ReturnType<typeof setTimeout>>();
  #seq: Record<string, number> = {};

  /** 工作台挂载时调用，返回卸载函数；首次挂载拉全量并订阅事件。 */
  attach(): () => void {
    this.#attachCount += 1;
    if (this.#attachCount === 1) this.#subscribe();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#attachCount -= 1;
      if (this.#attachCount === 0) this.#unsubscribe();
    };
  }

  #subscribe(): void {
    this.#detach = [
      core.onEvent('todos.changed', () => this.#soon('todos', () => this.refreshTodos())),
      core.onEvent('memos.changed', () => {
        this.#soon('memos', () => this.refreshMemos());
        if (this.trashOpen) this.#soon('trash', () => this.refreshTrash());
      }),
      core.onEvent('schedules.changed', () =>
        this.#soon('schedules', () => this.refreshSchedules()),
      ),
    ];
    void this.refreshAll();
  }

  #unsubscribe(): void {
    for (const off of this.#detach) off();
    this.#detach = [];
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    this.trashOpen = false;
  }

  #soon(key: string, run: Fetcher): void {
    const pending = this.#timers.get(key);
    if (pending !== undefined) clearTimeout(pending);
    this.#timers.set(
      key,
      setTimeout(() => {
        this.#timers.delete(key);
        void run();
      }, REFRESH_DEBOUNCE_MS),
    );
  }

  /** 迟到的旧响应不覆盖新响应：每类请求一个序号，只认最后发出的。 */
  async #fetch<T>(
    key: string,
    load: () => Promise<T>,
    apply: (value: T) => void,
  ): Promise<boolean> {
    const seq = (this.#seq[key] = (this.#seq[key] ?? 0) + 1);
    try {
      const value = await load();
      if (this.#seq[key] === seq) apply(value);
      return true;
    } catch (error) {
      console.warn(`[kepcup] workbench ${key} refresh failed`, error);
      return false;
    }
  }

  async refreshAll(): Promise<void> {
    if (this.loadState !== 'ready') this.loadState = 'loading';
    const results = await Promise.all([
      this.refreshTodos(),
      this.refreshSchedules(),
      this.refreshMemos(),
    ]);
    this.loadState = results.every(Boolean) ? 'ready' : 'error';
  }

  refreshTodos(): Promise<boolean> {
    return this.#fetch(
      'todos',
      async () => ((await core.call('todos.list', {})) as { todos: TodoEntry[] }).todos,
      (todos) => {
        this.todos = todos;
        this.todosVersion += 1;
      },
    );
  }

  refreshSchedules(): Promise<boolean> {
    return this.#fetch(
      'schedules',
      async () =>
        ((await core.call('schedules.list', {})) as { schedules: ScheduleEntry[] }).schedules,
      (schedules) => {
        this.schedules = schedules;
      },
    );
  }

  refreshMemos(): Promise<boolean> {
    return this.#fetch(
      'memos',
      async () => ((await core.call('memos.list', {})) as { memos: Memo[] }).memos,
      (memos) => {
        this.memos = memos;
      },
    );
  }

  refreshTrash(): Promise<boolean> {
    return this.#fetch(
      'trash',
      async () => ((await core.call('memos.list', { trashed: true })) as { memos: Memo[] }).memos,
      (memos) => {
        this.trashed = memos;
      },
    );
  }

  async openTrash(): Promise<void> {
    this.trashOpen = true;
    await this.refreshTrash();
  }

  closeTrash(): void {
    this.trashOpen = false;
  }

  // --- 抽屉 -----------------------------------------------------------------

  openTodo(todoId: string): void {
    this.drawer = { kind: 'edit', todoId };
  }

  newTodo(prefill: TodoPrefill = {}): void {
    this.drawer = { kind: 'new', prefill };
  }

  closeDrawer(): void {
    this.drawer = null;
  }

  /** 对话里的「在工作台查看」：切到工作台并打开该事项（不清当前会话，见 shell.mainView）。 */
  focusTodo(todoId: string): void {
    this.openTodo(todoId);
    shell.openWorkbench();
  }

  // --- 本地缓存的就地更新（写操作返回后立即上屏，事件随后校正） ------------------

  upsertTodo(todo: TodoEntry): void {
    const index = this.todos.findIndex((item) => item.id === todo.id);
    if (index < 0) this.todos = [todo, ...this.todos];
    else this.todos = this.todos.map((item) => (item.id === todo.id ? todo : item));
    this.todosVersion += 1;
  }

  upsertMemo(memo: Memo): void {
    if (memo.deletedAt !== null) {
      this.memos = this.memos.filter((item) => item.id !== memo.id);
      if (!this.trashed.some((item) => item.id === memo.id)) this.trashed = [memo, ...this.trashed];
      return;
    }
    this.trashed = this.trashed.filter((item) => item.id !== memo.id);
    const index = this.memos.findIndex((item) => item.id === memo.id);
    if (index < 0) this.memos = [memo, ...this.memos];
    else this.memos = this.memos.map((item) => (item.id === memo.id ? memo : item));
  }
}

export const workbench = new WorkbenchState();
