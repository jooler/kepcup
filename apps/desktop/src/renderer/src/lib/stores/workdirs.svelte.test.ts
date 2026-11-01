import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workdir } from '@kepcup/shared';

/**
 * 右栏 Bot 详情的工作目录行：`workdirs.boundOf` 只查客户端缓存，缓存来源有两条——
 * `workdir.updated` 事件（绑定/更新时广播）与最近列表（`workdirs.list` 只取 10 条）。
 * 这里锁住：事件到达后立即可解析；事件错过或绑定落在最近列表窗口外时，`ensure`
 * 按 id 回源一次，行不再显示「未设置」，且失败/不存在不会反复请求。
 */

const { handlers, state } = vi.hoisted(() => ({
  handlers: new Map<string, (payload: unknown) => void>(),
  state: {
    calls: [] as Array<{ method: string; input: unknown }>,
    workdirs: [] as unknown[],
    byId: new Map<string, unknown>(),
  },
}));

vi.mock('$lib/rpc/client.svelte', () => ({
  core: {
    onEvent: (name: string, handler: (payload: unknown) => void) => {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
    call: async (method: string, input?: unknown) => {
      state.calls.push({ method, input });
      if (method === 'workdirs.list') return { workdirs: state.workdirs };
      if (method === 'workdirs.get') {
        const id = (input as { id: string }).id;
        return { workdir: state.byId.get(id) ?? null };
      }
      return { ok: true };
    },
  },
}));

const { workdirs } = await import('./workdirs.svelte');

function workdir(id: string, overrides: Partial<Workdir> = {}): Workdir {
  return {
    id,
    path: `/tmp/${id}`,
    name: id,
    protectRules: { patterns: [] },
    allowedPorts: null,
    status: 'available',
    createdAt: 1,
    lastUsedAt: 1,
    ...overrides,
  } as Workdir;
}

function callsOf(method: string): number {
  return state.calls.filter((call) => call.method === method).length;
}

beforeEach(() => {
  state.calls = [];
  state.workdirs = [];
  state.byId.clear();
  handlers.clear();
  workdirs.recent = [];
  // 每个用例重新挂监听（store 只 start 一次，事件表由上面的 mock 保管）。
  workdirs.start();
});

describe('workdirs bound lookup', () => {
  it('resolves a bound workdir as soon as workdir.updated arrives (bind event path)', async () => {
    expect(workdirs.boundOf('conv_1', 'wkd_1')).toBeNull();

    handlers.get('workdir.updated')!({ workdir: workdir('wkd_1', { name: 'kepcup' }) });

    // 右栏 BotMenu / WorkdirSelector 都走这一条解析。
    expect(workdirs.boundOf('conv_1', 'wkd_1')?.name).toBe('kepcup');
  });

  it('looks a bound workdir up by id when it is outside the recent window', async () => {
    state.byId.set('wkd_old', workdir('wkd_old', { name: 'old-repo', status: 'missing' }));

    workdirs.ensure('wkd_old');
    await vi.waitFor(() => expect(workdirs.boundOf('conv_1', 'wkd_old')).not.toBeNull());

    expect(workdirs.boundOf('conv_1', 'wkd_old')).toMatchObject({
      name: 'old-repo',
      // 回源走 workdirs.get，core 侧顺手刷新磁盘状态 → 缺失态也立刻正确。
      status: 'missing',
    });
    expect(state.calls).toContainEqual({ method: 'workdirs.get', input: { id: 'wkd_old' } });
  });

  it('dedupes concurrent asks and caches misses (no request loop)', async () => {
    workdirs.ensure('wkd_gone');
    workdirs.ensure('wkd_gone');
    await vi.waitFor(() => expect(callsOf('workdirs.get')).toBe(1));

    // 已判定不存在：不再回源，解析结果保持空态。
    workdirs.ensure('wkd_gone');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(callsOf('workdirs.get')).toBe(1);
    expect(workdirs.boundOf('conv_1', 'wkd_gone')).toBeNull();
  });

  it('skips the lookup when the workdir is already in the recent list', async () => {
    workdirs.recent = [workdir('wkd_1')];
    workdirs.ensure('wkd_1');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(callsOf('workdirs.get')).toBe(0);
  });
});
