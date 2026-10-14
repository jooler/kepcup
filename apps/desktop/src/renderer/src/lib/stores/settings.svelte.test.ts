import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `settingsStore.test` 的线上格式：能力探测「未保存先测」——表单里填了 Key
 * 就以 keyOverride 传给 providers.test（服务端只用入参探测、不落库），留空
 * 则不带该字段（用已存 key）。CapabilityModelSection 的测试按钮据此不再先
 * 落盘（对齐 WebSearchSection 的既定取向）。
 */

const calls: Array<{ method: string; params: unknown }> = [];

vi.mock('$lib/rpc/client.svelte', () => ({
  core: {
    coreStatus: null,
    onEvent: () => () => undefined,
    call: async (method: string, params?: unknown) => {
      calls.push({ method, params });
      switch (method) {
        case 'settings.get':
          return { capabilityModels: {}, webSearch: { provider: null }, vendorProviders: [] };
        case 'providers.list':
          return { providers: [] };
        default:
          return { ok: true };
      }
    },
  },
}));

const { settingsStore } = await import('./settings.svelte');

describe('settingsStore.test（能力探测）', () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it('表单 Key 非空 → 以 keyOverride 传参（不落库）', async () => {
    await settingsStore.test('dashscope', 'qwen-image', 'image', 'sk-form');
    const call = calls.find((entry) => entry.method === 'providers.test');
    expect(call?.params).toEqual({
      provider: 'dashscope',
      model: 'qwen-image',
      capability: 'image',
      keyOverride: 'sk-form',
    });
    expect(calls.some((entry) => entry.method === 'settings.update')).toBe(false);
    expect(calls.some((entry) => entry.method === 'providers.setKey')).toBe(false);
  });

  it('Key 留空 → 不带 keyOverride（用已存 key）', async () => {
    await settingsStore.test('dashscope', 'qwen-image', 'image');
    const call = calls.find((entry) => entry.method === 'providers.test');
    expect(call?.params).toEqual({ provider: 'dashscope', model: 'qwen-image', capability: 'image' });
  });
});

describe('settingsStore.update 带出发快照（D89 审查修复）', () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it('只带补丁里的顶层键作为 base，core 据此三方合并', async () => {
    settingsStore.settings = {
      defaultMainModel: 'a/old',
      defaultLightModel: 'a/light',
      mcpServers: [],
    } as never;
    await settingsStore.update({ defaultLightModel: 'a/new' });
    const call = calls.find((entry) => entry.method === 'settings.update');
    expect(call?.params).toEqual({
      defaultLightModel: 'a/new',
      base: { defaultLightModel: 'a/light' },
    });
  });

  it('显式传 null（或还没有快照）时不带 base（整体覆盖的老行为）', async () => {
    await settingsStore.update({ defaultLightModel: 'a/x' }, null);
    expect(calls.find((entry) => entry.method === 'settings.update')?.params).toEqual({
      defaultLightModel: 'a/x',
    });
  });
});
