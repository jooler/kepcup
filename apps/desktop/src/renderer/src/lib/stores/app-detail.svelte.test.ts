import { flushSync } from 'svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 回归：连接详情页「授权失败后无限弹 toast」（D73 评审后用户实测）。
 *
 * 根因：`AppConnectionDetail` 的 `$effect` 里直接 `appDetailStore.load(id)`，而
 * `loadTools` / `loadGrants` 在**同步段**读了 `this.loadingTools` / `this.loadingGrants`（展开
 * 写回），effect 因此追踪了它们；`finally` 里再写这两个状态 → effect 重跑 → 再次拉取 → 失败
 * 再 toast → 再写……（健康的连接上则是静默地一直重复 `tools/list`）。
 *
 * 这里在真正的 Svelte 响应式运行时里（`desktop-svelte` 项目：vite-plugin-svelte + 客户端运行时）
 * 用与组件**完全相同**的 effect 写法跑 store，统计 RPC 调用次数。
 */

const calls: string[] = [];
const handlers = new Map<string, (payload: unknown) => void>();
let toolsFail = true;

vi.mock('$lib/rpc/client.svelte', () => ({
  core: {
    coreStatus: null,
    onEvent: (event: string, handler: (payload: unknown) => void) => {
      handlers.set(event, handler);
      return () => undefined;
    },
    call: async (method: string) => {
      calls.push(method);
      if (method === 'apps.connections.tools') {
        if (toolsFail) throw Object.assign(new Error('授权已失效'), { code: 'APP_AUTH_REQUIRED' });
        return { tools: [], pending: { added: 0, changed: 0 } };
      }
      if (method === 'apps.connections.grants') return { grants: [] };
      return {};
    },
  },
}));

const { appDetailStore } = await import('./app-detail.svelte');

const count = (method: string): number => calls.filter((entry) => entry === method).length;
const settle = async (ms = 250): Promise<void> => {
  const end = Date.now() + ms;
  // 循环失控时（修复前）调用数会无限涨：超过上限直接结束等待，让断言报出数字。
  while (Date.now() < end && calls.length < 400) {
    flushSync();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

beforeEach(() => {
  calls.length = 0;
  toolsFail = true;
  appDetailStore.forget('conn_1');
});

describe('appDetailStore.load 在 $effect 里（连接详情页的写法）', () => {
  it('工具清单读取失败：只拉一次、只报一次错，不会因自己的 loading 状态而重跑', async () => {
    const errors: unknown[] = [];
    const stop = $effect.root(() => {
      $effect(() => {
        const id = 'conn_1';
        void appDetailStore.load(id).catch((error: unknown) => errors.push(error));
      });
    });
    await settle();
    stop();
    expect(count('apps.connections.tools'), 'tools 调用次数').toBeLessThanOrEqual(2);
    expect(count('apps.connections.grants'), 'grants 调用次数').toBeLessThanOrEqual(2);
    expect(errors.length).toBeLessThanOrEqual(1);
  });

  it('健康的连接：同样只拉一次（不会静默地反复 tools/list）', async () => {
    toolsFail = false;
    const stop = $effect.root(() => {
      $effect(() => {
        const id = 'conn_1';
        void appDetailStore.load(id).catch(() => undefined);
      });
    });
    await settle();
    stop();
    expect(count('apps.connections.tools'), 'tools 调用次数').toBeLessThanOrEqual(2);
    expect(count('apps.connections.grants'), 'grants 调用次数').toBeLessThanOrEqual(2);
    expect(appDetailStore.toolsFor('conn_1')).not.toBeNull();
  });

  it('换连接 id 才会重新拉取（id 仍是依赖）', async () => {
    toolsFail = false;
    let id = $state('conn_1');
    const stop = $effect.root(() => {
      $effect(() => {
        const current = id;
        void appDetailStore.load(current).catch(() => undefined);
      });
    });
    await settle(100);
    const before = count('apps.connections.tools');
    id = 'conn_2';
    await settle(100);
    stop();
    expect(count('apps.connections.tools') - before).toBeGreaterThanOrEqual(1);
    expect(count('apps.connections.tools') - before).toBeLessThanOrEqual(2);
    appDetailStore.forget('conn_2');
  });
});

describe('appDetailStore 的连接状态事件', () => {
  it('行被删（removed）：丢缓存、不再请求；非可拉取状态不重拉；可拉取状态才重拉', async () => {
    toolsFail = false;
    appDetailStore.start();
    await appDetailStore.loadTools('conn_1');
    expect(appDetailStore.toolsFor('conn_1')).not.toBeNull();
    calls.length = 0;

    const emit = handlers.get('apps.connection_status')!;
    emit({ connectionId: 'conn_1', status: 'expired' });
    await settle(30);
    expect(count('apps.connections.tools')).toBe(0);

    emit({ connectionId: 'conn_1', status: 'connected' });
    await settle(30);
    expect(count('apps.connections.tools')).toBe(1);

    calls.length = 0;
    emit({ connectionId: 'conn_1', status: 'not_connected', removed: true });
    await settle(30);
    expect(appDetailStore.toolsFor('conn_1')).toBeNull();
    expect(calls).toEqual([]);
  });
});
