import { untrack } from 'svelte';
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
/** 去抖的最长等待：事件持续不断时也至少每隔这么久刷新一次。 */
export const REFRESH_MAX_WAIT_MS = 1000;

export interface TodoPrefill {
  title?: string;
  notes?: string;
  memoId?: string;
  assignee?: TodoAssignee | null;
}

export type DrawerState = { kind: 'edit'; todoId: string } | { kind: 'new'; prefill: TodoPrefill };

export type LoadState = 'idle' | 'loading' | 'ready' | 'error';

type Fetcher = () => Promise<unknown>;
type Part = 'todos' | 'schedules' | 'memos';
type PartState = 'pending' | 'ok' | 'fail';

export class WorkbenchState {
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

  /**
   * 面板上常驻输入框的文本（备忘草稿 / 备忘搜索词 / 事项快速新建草稿）。宽屏主区
   * 在对话与工作台之间二选一（App.svelte），切到对话会把整棵工作台卸载，组件里的
   * `$state` 随之丢失——放 store 才能「切走再切回」后原样还在（与对话输入框的
   * composerDrafts 同一思路，区别是不落盘：随手写的东西重启后从空开始更干净）。
   * 与抽屉无关：抽屉是模态，仍按原设计在离开工作台时关闭（`#unsubscribe`）。
   */
  memoDraft = $state('');
  memoQuery = $state('');
  todoDraft = $state('');

  #attachCount = 0;
  #detach: Array<() => void> = [];
  #timers: Record<string, ReturnType<typeof setTimeout> | undefined> = {};
  #firstPending: Record<string, number | undefined> = {};
  #seq: Record<string, number> = {};
  /** 三份主数据各自最近一次拉取的结果；loadState 由它们重算（任一份成功后可自愈）。 */
  #parts: Record<Part, PartState> = { todos: 'pending', schedules: 'pending', memos: 'pending' };
  /** 至少完整加载成功过一次：之后的重拉不再回到「加载中」。普通字段——不进响应式。 */
  #everLoaded = false;

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
    this.#parts = { todos: 'pending', schedules: 'pending', memos: 'pending' };
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
    for (const timer of Object.values(this.#timers)) {
      if (timer !== undefined) clearTimeout(timer);
    }
    this.#timers = {};
    this.#firstPending = {};
    this.trashOpen = false;
    // 离开工作台：抽屉不留到下次进来（对话里的「在工作台查看」是先开抽屉再切视图，
    // 那条路径发生在挂载之前，不受影响）。
    this.drawer = null;
  }

  /** 去抖：安静 REFRESH_DEBOUNCE_MS 后执行，但自第一个事件起最多等 REFRESH_MAX_WAIT_MS。 */
  #soon(key: string, run: Fetcher): void {
    const now = Date.now();
    const pending = this.#timers[key];
    if (pending !== undefined) clearTimeout(pending);
    const first = this.#firstPending[key] ?? now;
    this.#firstPending[key] = first;
    const delay = Math.max(0, Math.min(REFRESH_DEBOUNCE_MS, first + REFRESH_MAX_WAIT_MS - now));
    this.#timers[key] = setTimeout(() => {
      this.#timers[key] = undefined;
      this.#firstPending[key] = undefined;
      void run();
    }, delay);
  }

  #recompute(): void {
    const states = Object.values(this.#parts);
    if (states.includes('fail')) this.loadState = 'error';
    else if (states.every((state) => state === 'ok')) {
      this.#everLoaded = true;
      this.loadState = 'ready';
    } else this.loadState = this.#everLoaded ? 'ready' : 'loading';
  }

  /** 迟到的旧响应不覆盖新响应：每类请求一个序号，只认最后发出的。 */
  async #fetch<T>(
    key: string,
    load: () => Promise<T>,
    apply: (value: T) => void,
  ): Promise<boolean> {
    const seq = (this.#seq[key] = (this.#seq[key] ?? 0) + 1);
    const current = (): boolean => this.#seq[key] === seq;
    try {
      const value = await load();
      if (current()) {
        apply(value);
        this.#settle(key, 'ok');
      }
      return true;
    } catch (error) {
      console.warn(`[kepcup] workbench ${key} refresh failed`, error);
      if (current()) this.#settle(key, 'fail');
      return false;
    }
  }

  #settle(key: string, state: PartState): void {
    if (key !== 'todos' && key !== 'schedules' && key !== 'memos') return;
    this.#parts[key] = state;
    this.#recompute();
  }

  async refreshAll(): Promise<void> {
    if (!this.#everLoaded) this.loadState = 'loading';
    await Promise.all([this.refreshTodos(), this.refreshSchedules(), this.refreshMemos()]);
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

/**
 * 组件里用：挂载期间保持数据与事件订阅。attach 里会读写 store 的响应式状态，必须放进
 * untrack——否则 effect 把 loadState 等收成依赖，状态一变就卸载重挂，出错时形成死循环。
 */
export function useWorkbenchData(): void {
  $effect(() => untrack(() => workbench.attach()));
}
