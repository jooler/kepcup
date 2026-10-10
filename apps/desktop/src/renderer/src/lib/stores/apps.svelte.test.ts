import { flushSync } from 'svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 本机连接（设计 29 §17）在 `appsStore` 里的状态与事件：真实的 Svelte 响应式运行时
 * （`desktop-svelte` 项目），用与组件相同的 effect 写法。要点（沿用连接详情页修复的教训）：
 * 组件 effect 不追踪 store 内部的簿记状态 → 不会自己重跑；`apps.catalog_changed(removed)`
 * 立刻丢掉对条目的引用（本机列表行、目录条目、流程提示）；NOT_FOUND 的删除静默成功；
 * 并发点击删除只发一次。
 */

const calls: Array<{ method: string; params: unknown }> = [];
const handlers = new Map<string, (payload: unknown) => void>();
let localList: Array<Record<string, unknown>> = [];
let catalogList: Array<Record<string, unknown>> = [];
let removeError: unknown = null;
let removeGate: Promise<void> | null = null;

vi.mock('$lib/rpc/client.svelte', () => ({
  core: {
    coreStatus: null,
    onEvent: (event: string, handler: (payload: unknown) => void) => {
      handlers.set(event, handler);
      return () => undefined;
    },
    call: async (method: string, params?: unknown) => {
      calls.push({ method, params });
      switch (method) {
        case 'apps.connections.list':
          return { connections: [] };
        case 'apps.catalog.list':
          return { entries: catalogList };
        case 'apps.localConnectors.list':
          return { connectors: localList };
        case 'apps.localConnectors.confirm':
          return { connectorId: 'labc', title: 'Lab' };
        case 'apps.localConnectors.remove':
          if (removeGate !== null) await removeGate;
          if (removeError !== null) throw removeError;
          return { ok: true };
        default:
          return {};
      }
    },
  },
}));

const { appsStore } = await import('./apps.svelte');

const count = (method: string): number => calls.filter((entry) => entry.method === method).length;
const settle = async (ms = 60): Promise<void> => {
  const end = Date.now() + ms;
  while (Date.now() < end && calls.length < 300) {
    flushSync();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};
const view = (connectorId: string) => ({
  connectorId,
  title: connectorId,
  description: '',
  category: 'other',
  mcpUrl: `https://${connectorId}.example.com/mcp`,
  mcpHost: `${connectorId}.example.com`,
  addedAt: 1,
  connectedAccounts: 0,
  connectionIds: [],
});

beforeEach(() => {
  calls.length = 0;
  removeError = null;
  removeGate = null;
  localList = [view('labc')];
  catalogList = [{ connectorId: 'labc', origin: 'local' }];
});

describe('appsStore 本机连接', () => {
  it('start() 拉本机列表；组件式 effect 读取列表不会触发额外请求', async () => {
    const stop = $effect.root(() => {
      $effect(() => {
        appsStore.start();
        void appsStore.localConnectors.length;
      });
    });
    await settle();
    stop();
    expect(appsStore.localConnectors.map((item) => item.connectorId)).toEqual(['labc']);
    expect(count('apps.localConnectors.list')).toBe(1);
  });

  it('apps.catalog_changed(added)：重拉本机列表与目录', async () => {
    appsStore.start();
    await settle();
    calls.length = 0;
    localList = [view('labc'), view('lxyz')];
    handlers.get('apps.catalog_changed')!({ connectorId: 'lxyz', change: 'added' });
    await settle();
    expect(appsStore.localConnectors.map((item) => item.connectorId)).toEqual(['labc', 'lxyz']);
    expect(count('apps.localConnectors.list')).toBe(1);
    expect(count('apps.catalog.list')).toBeGreaterThanOrEqual(1);
  });

  it('apps.catalog_changed(removed)：立刻丢本机行 / 目录条目 / 流程提示，再对齐服务端', async () => {
    appsStore.start();
    await settle();
    // 单例 store 跨用例保留状态：显式摆好本用例的起点。
    appsStore.localConnectors = [view('labc')];
    appsStore.catalog = [{ connectorId: 'labc', origin: 'local' } as never];
    appsStore.flowIdByTarget = { 'catalog:labc': 'flow_1' };
    appsStore.flows = { flow_1: { flowId: 'flow_1', phase: 'failed' } as never };
    localList = [];
    catalogList = [];
    handlers.get('apps.catalog_changed')!({ connectorId: 'labc', change: 'removed' });
    // 同步段内就已丢弃（不等网络）
    expect(appsStore.localConnectors).toEqual([]);
    expect(appsStore.catalog.some((entry) => entry.connectorId === 'labc')).toBe(false);
    expect(appsStore.flowFor({ kind: 'catalog', connectorId: 'labc' })).toBeNull();
    await settle();
    expect(count('apps.connections.list')).toBeGreaterThanOrEqual(1);
  });

  it('confirmLocal：等目录与本机列表刷新后才返回', async () => {
    appsStore.start();
    await settle();
    calls.length = 0;
    const result = await appsStore.confirmLocal('lcp_1');
    expect(result).toEqual({ connectorId: 'labc', title: 'Lab' });
    expect(calls[0]).toEqual({
      method: 'apps.localConnectors.confirm',
      params: { proposalId: 'lcp_1' },
    });
    expect(count('apps.catalog.list')).toBe(1);
    expect(count('apps.localConnectors.list')).toBe(1);
  });

  it('removeLocal：NOT_FOUND 静默当作成功；并发点击只发一次；失败抛出且可重试', async () => {
    appsStore.start();
    await settle();
    calls.length = 0;
    removeError = Object.assign(new Error('gone'), { code: 'NOT_FOUND' });
    await expect(appsStore.removeLocal('labc')).resolves.toBeUndefined();

    let release!: () => void;
    removeGate = new Promise<void>((resolve) => (release = resolve));
    removeError = null;
    calls.length = 0;
    const first = appsStore.removeLocal('lxyz');
    const second = appsStore.removeLocal('lxyz');
    expect(appsStore.removingLocal['lxyz']).toBe(true);
    release();
    await Promise.all([first, second]);
    expect(count('apps.localConnectors.remove')).toBe(1);
    expect(appsStore.removingLocal['lxyz']).toBeUndefined();

    removeGate = null;
    removeError = Object.assign(new Error('boom'), { code: 'INTERNAL' });
    await expect(appsStore.removeLocal('lxyz')).rejects.toThrow('boom');
    expect(appsStore.removingLocal['lxyz']).toBeUndefined(); // 失败后可再点
  });
});
