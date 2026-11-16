import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * `capabilityEntries` store（D124，`plugins.listCapabilityEntries` 分组视图）在真实
 * Svelte 响应式运行时下的行为：`start()` 幂等且 `plugins.changed` 触发重拉；失败
 * 记 loadError 不抛；按插件 / 按能力的查询与「测试连接」键。
 */

const calls: Array<{ method: string; params: unknown }> = [];
const handlers = new Map<string, (payload: unknown) => void>();
let groups: Array<Record<string, unknown>> = [];
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
      if (method === 'plugins.listCapabilityEntries') return { plugins: groups };
      if (method === 'plugins.testCapabilityEntry') return { ok: true };
      return {};
    },
  },
}));

const { capabilityEntries } = await import('./capability-entries.svelte');

const group = (
  pluginId: string,
  pluginName: string,
  entries: Array<Record<string, unknown>>,
): Record<string, unknown> => ({
  pluginId,
  pluginName,
  tier: 'developer',
  entries,
});

const entryRow = (
  entryId: string,
  capability: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  entryId,
  capability,
  model: `${entryId}-model`,
  displayName: null,
  engine: 'dashscope',
  instanceState: 'single',
  configured: true,
  ...overrides,
});

const count = (method: string): number => calls.filter((row) => row.method === method).length;

beforeEach(() => {
  calls.length = 0;
  groups = [];
  callError = null;
  capabilityEntries.reset();
});

describe('capabilityEntries store（D124 条目分组视图）', () => {
  it('start() 订阅一次；plugins.changed 触发重拉（实例增删会改配置状态）', async () => {
    capabilityEntries.start();
    capabilityEntries.start();
    groups = [group('p/one', 'One', [entryRow('e1', 'image')])];
    await capabilityEntries.load();
    expect(count('plugins.listCapabilityEntries')).toBe(1);
    expect(capabilityEntries.entriesOf('p/one')).toHaveLength(1);

    const changed = handlers.get('plugins.changed');
    expect(changed).toBeDefined();
    groups = [group('p/one', 'One', [entryRow('e1', 'image', { configured: false })])];
    changed!({ ids: ['p/one'] });
    await vi.waitFor(() => {
      expect(count('plugins.listCapabilityEntries')).toBe(2);
    });
    expect(capabilityEntries.entriesOf('p/one')[0]?.configured).toBe(false);
  });

  it('load 失败记录 loadError 且不抛；已加载的分组不清空', async () => {
    groups = [group('p/one', 'One', [entryRow('e1', 'image')])];
    await capabilityEntries.load();
    callError = new Error('boom');
    await capabilityEntries.load(true);
    expect(capabilityEntries.loadError).toBe('boom');
    expect(capabilityEntries.entriesOf('p/one')).toHaveLength(1);
  });

  it('entriesOf / pluginNameOf：未装插件 = 空数组、名字回退 id', async () => {
    groups = [group('p/one', '阿里云百炼', [entryRow('e1', 'image')])];
    await capabilityEntries.load();
    expect(capabilityEntries.entriesOf('missing')).toEqual([]);
    expect(capabilityEntries.pluginNameOf('p/one')).toBe('阿里云百炼');
    expect(capabilityEntries.pluginNameOf('missing')).toBe('missing');
  });

  it('countByCapability / pluginIdsOf：设置页「插件提供 · N 个模型」与 deepLink 的数据面', async () => {
    groups = [
      group('p/one', 'One', [entryRow('a', 'image'), entryRow('b', 'video')]),
      group('p/two', 'Two', [entryRow('c', 'image'), entryRow('d', 'tts')]),
    ];
    await capabilityEntries.load();
    expect(capabilityEntries.countByCapability('image')).toBe(2);
    expect(capabilityEntries.countByCapability('video')).toBe(1);
    expect(capabilityEntries.countByCapability('asr')).toBe(0);
    expect(capabilityEntries.pluginIdsOf('image')).toEqual(['p/one', 'p/two']);
    expect(capabilityEntries.pluginIdsOf('video')).toEqual(['p/one']);
    expect(capabilityEntries.pluginIdsOf('rerank')).toEqual([]);
  });

  it('testKey：条目行唯一键', () => {
    expect(capabilityEntries.testKey('p/one', 'e1')).toBe('p/one/e1');
  });

  it('reset() 清数据不清订阅（单例 #started 保持）', async () => {
    capabilityEntries.start();
    await capabilityEntries.load();
    capabilityEntries.reset();
    expect(capabilityEntries.groups).toEqual([]);
    expect(capabilityEntries.loadError).toBe(null);
    capabilityEntries.reset();
    await capabilityEntries.load(true);
    expect(count('plugins.listCapabilityEntries')).toBe(2);
  });
});
