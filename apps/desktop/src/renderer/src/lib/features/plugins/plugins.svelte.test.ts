import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * `plugins` store（D104 P0a-3）在真实 Svelte 响应式运行时下的行为：`start()` 幂等且
 * `plugins.changed` 触发重拉；启停 / 卸载后刷新受影响的 store；失败上抛且 `busy` 清理。
 */

const calls: Array<{ method: string; params: unknown }> = [];
const handlers = new Map<string, (payload: unknown) => void>();
let list: Array<Record<string, unknown>> = [];
let callError: unknown = null;

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
          return { ok: true };
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
  handlers.clear();
  list = [summary('io.github.alice/doc-tools', 'Doc Tools')];
  callError = null;
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
    changed!( { ids: ['io.github.alice/doc-tools'] } );
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
});
