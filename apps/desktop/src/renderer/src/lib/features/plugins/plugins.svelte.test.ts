import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * `plugins` store（D104 P0a-3）在真实 Svelte 响应式运行时下的行为：`start()` 幂等且
 * `plugins.changed` 触发重拉；启停 / 卸载后刷新受影响的 store；失败上抛且 `busy` 清理。
 */

const calls: Array<{ method: string; params: unknown }> = [];
const handlers = new Map<string, (payload: unknown) => void>();
let list: Array<Record<string, unknown>> = [];
let callError: unknown = null;
const marketStatus: Record<string, unknown> = {
  state: 'ok',
  disabledReason: null,
  lastSync: null,
  generatedAt: null,
  error: null,
  endpoint: 'official',
};
let marketEntries: Array<Record<string, unknown>> = [];
let inspections: Record<string, Record<string, unknown>> = {};
const PLAIN_SHA256 = 'a'.repeat(64);
/** `plugins.marketplace.refresh` 返回前的钩子（模拟 core 在采纳新索引时同步广播事件）。 */
let onRefresh: (() => void) | null = null;

vi.mock('$lib/rpc/client.svelte', () => ({
  core: {
    onEvent: (event: string, handler: (payload: unknown) => void) => {
      handlers.set(event, handler);
      return () => undefined;
    },
    call: async (method: string, params?: unknown) => {
      calls.push({ method, params });
      if (callError !== null) throw callError;
      switch (method) {
        case 'plugins.list':
          return { plugins: list };
        case 'plugins.setEnabled':
        case 'plugins.uninstall':
        case 'plugins.update':
          return { ok: true };
        case 'plugins.marketplace.list':
          return { status: marketStatus, entries: marketEntries };
        case 'plugins.marketplace.refresh':
          onRefresh?.();
          return { status: marketStatus };
        case 'plugins.inspect':
          return inspections[(params as { source: { id: string } }).source.id] ?? {};
        default:
          return {};
      }
    },
  },
}));

const refreshCalls: Array<string> = [];
vi.mock('$lib/stores/settings.svelte', () => ({
  settingsStore: {
    refresh: async () => {
      refreshCalls.push('settings');
    },
  },
}));
vi.mock('$lib/stores/apps.svelte', () => ({
  appsStore: {
    refresh: async () => {
      refreshCalls.push('apps');
    },
  },
}));

const { plugins } = await import('./plugins.svelte');

const summary = (id: string, name: string) => ({
  id,
  name,
  version: '1.0.0',
  description: '',
  author: null,
  origin: 'local',
  tier: 'developer',
  state: 'installed',
  enabled: true,
  dirPath: null,
  marketplace: null,
  installedAt: 1,
  updatedAt: 1,
  counts: { skills: 0, connectors: 0, mcp: 0, mail: 0 },
  items: [],
  updateAvailable: null,
});

const count = (method: string): number => calls.filter((entry) => entry.method === method).length;

beforeEach(() => {
  calls.length = 0;
  refreshCalls.length = 0;
  // handlers 不清空：store 是单例，`start()` 只注册一次（reset() 只清数据）。
  list = [summary('io.github.alice/doc-tools', 'Doc Tools')];
  callError = null;
  marketEntries = [];
  inspections = {};
  onRefresh = null;
  plugins.reset();
});

describe('plugins store', () => {
  it('start() 订阅一次；plugins.changed 触发重拉', async () => {
    plugins.start();
    plugins.start();
    await plugins.load();
    expect(count('plugins.list')).toBe(1);
    expect(plugins.plugins).toHaveLength(1);

    const changed = handlers.get('plugins.changed');
    expect(changed).toBeDefined();
    list = [summary('io.github.alice/doc-tools', 'Doc Tools'), summary('local.kepcup/x', 'X')];
    changed!({ ids: ['io.github.alice/doc-tools'] });
    await vi.waitFor(() => {
      expect(count('plugins.list')).toBe(2);
    });
    expect(plugins.plugins).toHaveLength(2);
  });

  it('load(false) 只拉一次，load(true) 强制刷新；失败记录 loadError 且不抛', async () => {
    await plugins.load();
    await plugins.load();
    expect(count('plugins.list')).toBe(1);
    await plugins.load(true);
    expect(count('plugins.list')).toBe(2);

    callError = new Error('boom');
    await plugins.load(true);
    expect(plugins.loadError).toBe('boom');
    // 失败不清空已加载的列表（与 market 一致），只透出错误。
    expect(plugins.plugins).toHaveLength(1);
  });

  it('setEnabled 成功后刷新 settings 与 apps 目录，并清理 busy', async () => {
    await plugins.setEnabled('io.github.alice/doc-tools', false);
    expect(calls).toContainEqual({
      method: 'plugins.setEnabled',
      params: { id: 'io.github.alice/doc-tools', enabled: false },
    });
    // afterMutation：列表重拉 + settings / apps 目录刷新。
    expect(refreshCalls).toContain('settings');
    expect(refreshCalls).toContain('apps');
    expect(plugins.busy.has('io.github.alice/doc-tools')).toBe(false);
  });

  it('setEnabled / uninstall 失败时上抛且 busy 被清理', async () => {
    callError = Object.assign(new Error('PLUGIN_MANAGED'), { code: 'PLUGIN_MANAGED' });
    await expect(plugins.setEnabled('io.github.alice/doc-tools', true)).rejects.toThrow(
      'PLUGIN_MANAGED',
    );
    expect(plugins.busy.has('io.github.alice/doc-tools')).toBe(false);
    await expect(plugins.uninstall('io.github.alice/doc-tools')).rejects.toThrow('PLUGIN_MANAGED');
    expect(plugins.busy.has('io.github.alice/doc-tools')).toBe(false);
  });

  it('nameOf 找不到时回退 id', async () => {
    await plugins.load();
    expect(plugins.nameOf('io.github.alice/doc-tools')).toBe('Doc Tools');
    expect(plugins.nameOf('missing/plugin')).toBe('missing/plugin');
  });

  it('marketplace.updated 事件刷新市场与已安装列表', async () => {
    // 单例的 #started 跨用例保持为 true（reset() 只清数据）；直接调用已注册的处理器。
    plugins.start();
    await plugins.loadMarket();
    expect(count('plugins.marketplace.list')).toBe(1);
    const changed = handlers.get('plugins.marketplace.updated');
    expect(changed).toBeDefined();
    marketEntries = [{ id: 'io.github.a/one', version: '1.0.0' }];
    changed!({ generatedAt: 1 });
    await vi.waitFor(() => {
      expect(count('plugins.marketplace.list')).toBe(2);
    });
    expect(plugins.market).toHaveLength(1);
  });

  it('refreshMarket 进行中收到 marketplace.updated 不重复拉取；之后的事件照常刷新', async () => {
    plugins.start();
    await plugins.loadMarket();
    await plugins.load();
    calls.length = 0;
    onRefresh = () => handlers.get('plugins.marketplace.updated')!({ generatedAt: 2 });
    await plugins.refreshMarket();
    // 刷新 RPC 一次 + 刷新尾部的显式重载各一次；事件被吞掉，没有第二轮。
    expect(count('plugins.marketplace.refresh')).toBe(1);
    expect(count('plugins.marketplace.list')).toBe(1);
    expect(count('plugins.list')).toBe(1);

    handlers.get('plugins.marketplace.updated')!({ generatedAt: 3 });
    await vi.waitFor(() => {
      expect(count('plugins.marketplace.list')).toBe(2);
      expect(count('plugins.list')).toBe(2);
    });
  });

  it('updateAll 只直接更新无需确认的插件，其余计入 skipped', async () => {
    list = [
      {
        ...summary('io.github.a/plain', 'Plain'),
        origin: 'marketplace',
        tier: 'verified',
        updateAvailable: { version: '1.1.0' },
      },
      {
        ...summary('io.github.a/permdiff', 'Perm'),
        origin: 'marketplace',
        tier: 'verified',
        updateAvailable: { version: '1.1.0' },
      },
      {
        ...summary('io.github.a/needsconfig', 'Cfg'),
        origin: 'marketplace',
        tier: 'verified',
        updateAvailable: { version: '1.1.0' },
      },
      {
        ...summary('io.github.a/optionalconfig', 'Opt'),
        origin: 'marketplace',
        tier: 'verified',
        updateAvailable: { version: '1.1.0' },
      },
    ];
    inspections = {
      'io.github.a/plain': {
        id: 'io.github.a/plain',
        installable: true,
        packageSha256: PLAIN_SHA256,
        update: { from: '1.0.0', permissionsExpanded: false, added: [] },
        mcp: [],
      },
      'io.github.a/permdiff': {
        id: 'io.github.a/permdiff',
        installable: true,
        update: { from: '1.0.0', permissionsExpanded: true, added: ['新增主机 api.x.com'] },
        mcp: [],
      },
      'io.github.a/needsconfig': {
        id: 'io.github.a/needsconfig',
        installable: true,
        update: { from: '1.0.0', permissionsExpanded: false, added: [] },
        mcp: [
          {
            kind: 'mcpb',
            id: 'db',
            userConfigFields: [{ key: 'token', required: true, sensitive: true }],
          },
        ],
      },
      // 只有可选字段也跳过：非敏感值不保留，全部更新会把用户改过的值换回默认。
      'io.github.a/optionalconfig': {
        id: 'io.github.a/optionalconfig',
        installable: true,
        update: { from: '1.0.0', permissionsExpanded: false, added: [] },
        mcp: [
          {
            kind: 'mcpb',
            id: 'proxy',
            userConfigFields: [{ key: 'base_url', required: false, sensitive: false }],
          },
        ],
      },
    };
    await plugins.load(true);
    const result = await plugins.updateAll();
    expect(result).toEqual({ done: 1, skipped: 3 });
    // sha256 必须是检视结果里的那一个（core 据此拒绝「检视后包被替换」）。
    expect(calls.filter((entry) => entry.method === 'plugins.update')).toEqual([
      {
        method: 'plugins.update',
        params: {
          id: 'io.github.a/plain',
          sha256: PLAIN_SHA256,
          userConfig: {},
          acknowledgeDiff: false,
        },
      },
    ]);
  });
});
