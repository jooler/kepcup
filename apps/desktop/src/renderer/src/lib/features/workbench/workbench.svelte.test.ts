import { flushSync } from 'svelte';
import type { TodoEntry } from '@kepcup/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 工作台 store（D90）：挂载时拉全量并订阅三个 changed 事件，事件去抖后重拉；卸载后不再订阅；
 * focusTodo 切到工作台并打开抽屉；写操作的就地更新。真实的 Svelte 响应式运行时（desktop-svelte 项目）。
 */

const calls: Array<{ method: string; params: unknown }> = [];
const handlers = new Map<string, Set<(payload: unknown) => void>>();
let todosResult: unknown[] = [];
let failTodos = false;
let failMemos = false;

vi.mock('$lib/rpc/client.svelte', () => ({
  core: {
    coreStatus: null,
    onEvent: (event: string, handler: (payload: unknown) => void) => {
      const set = handlers.get(event) ?? new Set();
      set.add(handler);
      handlers.set(event, set);
      return () => set.delete(handler);
    },
    call: async (method: string, params?: unknown) => {
      calls.push({ method, params });
      switch (method) {
        case 'todos.list':
          if (failTodos) throw new Error('boom');
          return { todos: todosResult };
        case 'schedules.list':
          return { schedules: [] };
        case 'memos.list':
          if (failMemos) throw new Error('boom');
          return { memos: [] };
        default:
          return {};
      }
    },
  },
}));

const { workbench, WorkbenchState, REFRESH_DEBOUNCE_MS, REFRESH_MAX_WAIT_MS, useWorkbenchData } =
  await import('./workbench.svelte');
const { shell } = await import('$lib/stores/shell.svelte');

const count = (method: string, match?: (params: unknown) => boolean): number =>
  calls.filter((c) => c.method === method && (match === undefined || match(c.params))).length;
const emit = (event: string, payload: unknown = {}): void => {
  for (const handler of handlers.get(event) ?? []) handler(payload);
};
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const todo = (id: string) => ({ id, title: id, memoId: null }) as unknown as TodoEntry;

let detach: (() => void) | null = null;

beforeEach(() => {
  calls.length = 0;
  handlers.clear();
  todosResult = [];
  failTodos = false;
  failMemos = false;
  workbench.todos = [];
  workbench.drawer = null;
  shell.mainView = 'chats';
});
afterEach(() => {
  detach?.();
  detach = null;
});

describe('attach / 刷新', () => {
  it('挂载时拉三份数据并订阅事件；就绪后 loadState = ready', async () => {
    detach = workbench.attach();
    await wait(20);
    flushSync();
    expect(count('todos.list')).toBe(1);
    expect(count('schedules.list')).toBe(1);
    expect(count('memos.list', (p) => (p as { trashed?: boolean }).trashed === undefined)).toBe(1);
    expect(workbench.loadState).toBe('ready');
    expect([...handlers.keys()].sort()).toEqual([
      'memos.changed',
      'schedules.changed',
      'todos.changed',
    ]);
  });

  it('同类事件去抖：连发多次只重拉一次', async () => {
    detach = workbench.attach();
    await wait(20);
    calls.length = 0;
    emit('todos.changed', { todoId: 'a' });
    emit('todos.changed', { todoId: 'b' });
    emit('todos.changed', { todoId: 'c' });
    await wait(REFRESH_DEBOUNCE_MS + 60);
    expect(count('todos.list')).toBe(1);
    expect(count('memos.list')).toBe(0);
  });

  it('memos.changed 只重拉备忘；打开最近删除时同时重拉回收站；schedules.changed 重拉排期', async () => {
    detach = workbench.attach();
    await wait(20);
    await workbench.openTrash();
    calls.length = 0;
    emit('memos.changed', { memoId: 'm' });
    emit('schedules.changed', { conversationId: 'c', scheduleId: 's' });
    await wait(REFRESH_DEBOUNCE_MS + 60);
    expect(count('memos.list', (p) => (p as { trashed?: boolean }).trashed === undefined)).toBe(1);
    expect(count('memos.list', (p) => (p as { trashed?: boolean }).trashed === true)).toBe(1);
    expect(count('schedules.list')).toBe(1);
    expect(count('todos.list')).toBe(0);
  });

  it('卸载后取消订阅，挂起的去抖不再触发', async () => {
    detach = workbench.attach();
    await wait(20);
    calls.length = 0;
    emit('todos.changed');
    detach();
    detach = null;
    await wait(REFRESH_DEBOUNCE_MS + 60);
    expect(count('todos.list')).toBe(0);
    expect([...handlers.values()].every((set) => set.size === 0)).toBe(true);
  });

  it('拉取失败 → loadState = error，不抛', async () => {
    failTodos = true;
    detach = workbench.attach();
    await wait(20);
    expect(workbench.loadState).toBe('error');
  });

  it('todos.list 的结果上屏并推进 todosVersion', async () => {
    todosResult = [todo('t1')];
    const before = workbench.todosVersion;
    detach = workbench.attach();
    await wait(20);
    expect(workbench.todos.map((t) => t.id)).toEqual(['t1']);
    expect(workbench.todosVersion).toBeGreaterThan(before);
  });
});

describe('抽屉与跳转', () => {
  it('focusTodo：切到工作台并打开该事项，不清其它状态', () => {
    workbench.focusTodo('todo_1');
    expect(shell.mainView).toBe('workbench');
    expect(workbench.drawer).toEqual({ kind: 'edit', todoId: 'todo_1' });
  });

  it('newTodo 带预填；closeDrawer 关闭', () => {
    workbench.newTodo({ title: 'x', memoId: 'memo_1' });
    expect(workbench.drawer).toEqual({ kind: 'new', prefill: { title: 'x', memoId: 'memo_1' } });
    workbench.closeDrawer();
    expect(workbench.drawer).toBeNull();
  });
});

describe('就地更新', () => {
  it('upsertTodo 新增置顶、已有则替换', () => {
    workbench.upsertTodo(todo('a'));
    workbench.upsertTodo(todo('b'));
    expect(workbench.todos.map((t) => t.id)).toEqual(['b', 'a']);
    workbench.upsertTodo({ ...todo('a'), title: 'A2' });
    expect(workbench.todos.map((t) => t.title)).toEqual(['b', 'A2']);
  });

  it('upsertMemo：软删移入回收站，恢复移回列表', () => {
    const base = { id: 'm1', body: 'x', pinned: false, source: 'user', createdAt: 1, updatedAt: 1 };
    const memo = { ...base, deletedAt: null } as never;
    workbench.upsertMemo(memo);
    expect(workbench.memos.map((m) => m.id)).toEqual(['m1']);
    workbench.upsertMemo({ ...base, deletedAt: 5 } as never);
    expect(workbench.memos).toEqual([]);
    expect(workbench.trashed.map((m) => m.id)).toEqual(['m1']);
    workbench.upsertMemo(memo);
    expect(workbench.trashed).toEqual([]);
    expect(workbench.memos.map((m) => m.id)).toEqual(['m1']);
  });
});

describe('经过真实 effect 挂载（WorkbenchView 的用法）', () => {
  const settle = async (ms = 150): Promise<void> => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      flushSync();
      await wait(5);
    }
  };
  const subscriptions = (): number => [...handlers.values()].reduce((n, set) => n + set.size, 0);
  let stop: (() => void) | null = null;
  const mount = (): void => {
    stop = $effect.root(() => {
      useWorkbenchData();
    });
    flushSync();
  };
  afterEach(() => {
    stop?.();
    stop = null;
  });

  it('正常打开：每份数据只拉一次、三个事件各订阅一次', async () => {
    mount();
    await settle();
    expect(count('todos.list')).toBe(1);
    expect(count('schedules.list')).toBe(1);
    expect(count('memos.list')).toBe(1);
    expect(subscriptions()).toBe(3);
    expect(workbench.loadState).toBe('ready');
  });

  it('RPC 报错：进入 error 后不循环重挂 / 重拉', async () => {
    failTodos = true;
    mount();
    await settle(300);
    expect(workbench.loadState).toBe('error');
    expect(count('todos.list')).toBe(1);
    expect(subscriptions()).toBe(3);
  });

  it('错误态自愈：失败的那份后来成功，loadState 回到 ready', async () => {
    failMemos = true;
    mount();
    await settle();
    expect(workbench.loadState).toBe('error');
    failMemos = false;
    emit('memos.changed', { memoId: 'm' });
    await settle(REFRESH_DEBOUNCE_MS + 100);
    expect(workbench.loadState).toBe('ready');
  });

  it('首次加载期间是 loading；加载过之后重拉不回到 loading', async () => {
    const fresh = new WorkbenchState();
    const off = fresh.attach();
    expect(fresh.loadState).toBe('loading');
    await settle();
    expect(fresh.loadState).toBe('ready');
    emit('todos.changed');
    await settle(REFRESH_DEBOUNCE_MS + 50);
    expect(fresh.loadState).toBe('ready');
    off();
  });

  it('卸载时关掉抽屉并取消订阅', async () => {
    mount();
    await settle();
    workbench.openTodo('todo_1');
    stop?.();
    stop = null;
    flushSync();
    expect(workbench.drawer).toBeNull();
    expect(subscriptions()).toBe(0);
  });

  it('对话里先开抽屉再切到工作台：挂载不清掉它', async () => {
    workbench.focusTodo('todo_1');
    mount();
    await settle();
    expect(workbench.drawer).toEqual({ kind: 'edit', todoId: 'todo_1' });
  });
});

describe('去抖最大等待', () => {
  it('事件持续不断时也会在最大等待内刷新', async () => {
    detach = workbench.attach();
    await wait(30);
    calls.length = 0;
    const end = Date.now() + REFRESH_MAX_WAIT_MS + 400;
    while (Date.now() < end) {
      emit('todos.changed');
      await wait(100);
    }
    expect(count('todos.list')).toBeGreaterThanOrEqual(1);
  });
});
