import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `pluginRuntime` store（D125 P3）：`plugins.runtime.list` 初始快照 +
 * `plugin.runtime` 事件增量；非执行型插件不在快照里（零变化断言）；restart 后重拉。
 */

const calls: Array<{ method: string; params: unknown }> = [];
const handlers = new Map<string, (payload: unknown) => void>();
let rows: Array<Record<string, unknown>> = [];
let callError: unknown = null;
/** 延迟响应模式：测试并发拉取时手工 resolve。 */
let deferList = false;
const deferredLists: Array<{ resolve: (value: unknown) => void; reject: (error: unknown) => void }> =
  [];

vi.mock('$lib/rpc/client.svelte', () => ({
  core: {
    onEvent: (event: string, handler: (payload: unknown) => void) => {
      handlers.set(event, handler);
      return () => undefined;
    },
    call: async (method: string, params?: unknown) => {
      calls.push({ method, params });
      if (callError !== null) throw callError;
      if (method === 'plugins.runtime.list') {
        if (deferList) {
          return await new Promise((resolve, reject) => {
            deferredLists.push({ resolve, reject });
          });
        }
        return { plugins: rows };
      }
      if (method === 'plugins.runtime.restart') return { ok: true };
      return {};
    },
  },
}));

const { pluginRuntime } = await import('./plugin-runtime.svelte');

const row = (
  pluginId: string,
  status: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  pluginId,
  status,
  detail: null,
  lastError: null,
  recent: [],
  ...overrides,
});

const count = (method: string): number => calls.filter((entry) => entry.method === method).length;

beforeEach(() => {
  calls.length = 0;
  rows = [];
  callError = null;
  deferList = false;
  deferredLists.length = 0;
  // handlers 不清空：store 是单例，start() 只注册一次（reset() 只清数据）。
  pluginRuntime.reset();
});

describe('pluginRuntime store', () => {
  it('start() 幂等；初始 list 只含执行型插件；非执行型插件 stateOf = null', async () => {
    rows = [row('io.test/runtime', 'stopped')];
    pluginRuntime.start();
    pluginRuntime.start();
    await vi.waitFor(() => expect(count('plugins.runtime.list')).toBe(1));
    expect(pluginRuntime.stateOf('io.test/runtime')?.status).toBe('stopped');
    // 非执行型插件（无 runtime 段）在快照里没有行：徽标 / 活动入口不渲染。
    expect(pluginRuntime.stateOf('io.test/data-only')).toBeNull();
    expect(pluginRuntime.isExecuting('io.test/data-only')).toBe(false);
    expect(pluginRuntime.isExecuting('io.test/runtime')).toBe(true);
  });

  it('plugin.runtime 事件更新状态并保留历史；error 事件把 detail 记为 lastError', async () => {
    rows = [
      row('io.test/runtime', 'ready', {
        recent: [
          {
            at: 1,
            contract: 'media',
            method: 'generateImage',
            durationMs: 12,
            ok: true,
            errorCode: null,
            message: null,
          },
        ],
      }),
    ];
    pluginRuntime.start();
    await vi.waitFor(() => expect(pluginRuntime.stateOf('io.test/runtime')).not.toBeNull());

    const event = handlers.get('plugin.runtime');
    expect(event).toBeDefined();
    event!({ pluginId: 'io.test/runtime', status: 'busy' });
    expect(pluginRuntime.stateOf('io.test/runtime')).toMatchObject({
      status: 'busy',
      recent: [{ method: 'generateImage' }],
    });

    event!({ pluginId: 'io.test/runtime', status: 'error', detail: '插件进程退出' });
    expect(pluginRuntime.stateOf('io.test/runtime')).toMatchObject({
      status: 'error',
      detail: '插件进程退出',
      lastError: '插件进程退出',
    });
    // 回 ready 后 lastError 保留（与 core 的 lastError 语义一致）。
    event!({ pluginId: 'io.test/runtime', status: 'ready' });
    expect(pluginRuntime.stateOf('io.test/runtime')).toMatchObject({
      status: 'ready',
      lastError: '插件进程退出',
    });
  });

  it('拉取在途时到达的事件不被慢响应覆盖（事件更新鲜）', async () => {
    rows = [row('io.test/runtime', 'ready')];
    pluginRuntime.start();
    // 第二次强制拉取：在响应回来之前推一个 starting 事件。
    const loading = pluginRuntime.load(true);
    handlers.get('plugin.runtime')!({ pluginId: 'io.test/runtime', status: 'starting' });
    await loading;
    expect(pluginRuntime.stateOf('io.test/runtime')?.status).toBe('starting');
  });

  it('并发强制拉取：只有最新一次响应生效（旧响应后到不覆盖新状态）', async () => {
    rows = [row('io.test/runtime', 'stopped')];
    pluginRuntime.start();
    await vi.waitFor(() => expect(pluginRuntime.stateOf('io.test/runtime')).not.toBeNull());

    deferList = true;
    const older = pluginRuntime.load(true);
    const newer = pluginRuntime.load(true);
    await vi.waitFor(() => expect(deferredLists).toHaveLength(2));

    deferredLists[1]!.resolve({ plugins: [row('io.test/runtime', 'ready')] });
    await newer;
    expect(pluginRuntime.stateOf('io.test/runtime')?.status).toBe('ready');

    // 旧请求后到：必须被丢弃，不能把徽标写回 stopped。
    deferredLists[0]!.resolve({ plugins: [row('io.test/runtime', 'stopped')] });
    await older;
    expect(pluginRuntime.stateOf('io.test/runtime')?.status).toBe('ready');
    expect(pluginRuntime.loading).toBe(false);
  });

  it('reset 使在途拉取失效：旧端点的响应不写回复位后的 store', async () => {
    rows = [row('io.test/runtime', 'ready')];
    pluginRuntime.start();
    await vi.waitFor(() => expect(pluginRuntime.stateOf('io.test/runtime')).not.toBeNull());

    deferList = true;
    const pending = pluginRuntime.load(true);
    await vi.waitFor(() => expect(deferredLists).toHaveLength(1));
    pluginRuntime.reset();
    deferredLists[0]!.resolve({ plugins: [row('io.test/runtime', 'ready')] });
    await pending;
    expect(pluginRuntime.states).toEqual({});
    expect(pluginRuntime.loading).toBe(false);
  });

  it('拉取与事件并发合并：非 error 事件保留服务端更新的最近错误，error 事件用事件详情', async () => {
    rows = [row('io.test/runtime', 'ready', { lastError: '旧错误' })];
    pluginRuntime.start();
    await vi.waitFor(() => expect(pluginRuntime.stateOf('io.test/runtime')).not.toBeNull());

    deferList = true;
    const first = pluginRuntime.load(true);
    await vi.waitFor(() => expect(deferredLists).toHaveLength(1));
    // 非 error 事件只带状态：lastError 应取快照里更新的值。
    handlers.get('plugin.runtime')!({ pluginId: 'io.test/runtime', status: 'ready' });
    deferredLists[0]!.resolve({
      plugins: [row('io.test/runtime', 'ready', { lastError: '服务端新错误' })],
    });
    await first;
    expect(pluginRuntime.stateOf('io.test/runtime')?.lastError).toBe('服务端新错误');

    const second = pluginRuntime.load(true);
    await vi.waitFor(() => expect(deferredLists).toHaveLength(2));
    // error 事件：事件详情就是最新错误，不能被旧快照覆盖。
    handlers.get('plugin.runtime')!({
      pluginId: 'io.test/runtime',
      status: 'error',
      detail: '事件错误',
    });
    deferredLists[1]!.resolve({
      plugins: [row('io.test/runtime', 'error', { detail: '旧 detail', lastError: '快照旧错误' })],
    });
    await second;
    expect(pluginRuntime.stateOf('io.test/runtime')).toMatchObject({
      status: 'error',
      detail: '事件错误',
      lastError: '事件错误',
    });
  });

  it('plugins.changed 触发重拉；restart 调 RPC 后重拉', async () => {
    rows = [row('io.test/runtime', 'error')];
    pluginRuntime.start();
    await vi.waitFor(() => expect(count('plugins.runtime.list')).toBe(1));
    handlers.get('plugins.changed')!({ ids: ['io.test/runtime'] });
    await vi.waitFor(() => expect(count('plugins.runtime.list')).toBe(2));

    rows = [row('io.test/runtime', 'ready')];
    await pluginRuntime.restart('io.test/runtime');
    expect(calls.filter((entry) => entry.method === 'plugins.runtime.restart')).toEqual([
      { method: 'plugins.runtime.restart', params: { pluginId: 'io.test/runtime' } },
    ]);
    expect(pluginRuntime.stateOf('io.test/runtime')?.status).toBe('ready');
  });

  it('list 失败（运行时未装配）只记 loadError，不抛、不出现条目', async () => {
    callError = Object.assign(new Error('插件模块未就绪'), { code: 'NOT_IMPLEMENTED' });
    pluginRuntime.start();
    await vi.waitFor(() => expect(pluginRuntime.loadError).toBe('插件模块未就绪'));
    expect(pluginRuntime.states).toEqual({});
  });

  it('reset 清空状态（登出 / 端点切换）', async () => {
    rows = [row('io.test/runtime', 'ready')];
    pluginRuntime.start();
    await vi.waitFor(() => expect(pluginRuntime.states['io.test/runtime']).toBeDefined());
    pluginRuntime.reset();
    expect(pluginRuntime.states).toEqual({});
    expect(pluginRuntime.stateOf('io.test/runtime')).toBeNull();
  });
});
