import { flushSync } from 'svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `settings.changed`（todo/conversational-app-setup.md §4.1「广播」）：settingsStore 订阅后
 * 记下变化条目（link 设置卡据此自动完成）并重新拉取快照——设置页各分区直接读 store，
 * 打开着的设置弹框随之刷新。
 */

const handlers = new Map<string, (payload: unknown) => void>();
const calls: string[] = [];
let mainModel = 'custom:mock/mock-main';

vi.mock('$lib/rpc/client.svelte', () => ({
  core: {
    coreStatus: null,
    onEvent: (event: string, handler: (payload: unknown) => void) => {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
    call: async (method: string) => {
      calls.push(method);
      switch (method) {
        case 'settings.get':
          return {
            defaultMainModel: mainModel,
            capabilityModels: {},
            webSearch: { provider: null },
            vendorProviders: [],
          };
        case 'providers.list':
          return { providers: [] };
        default:
          return { ok: true };
      }
    },
  },
}));

const { settingsStore } = await import('./settings.svelte');

describe('settingsStore × settings.changed', () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it('start 订阅事件；快照未加载时只记变化、不抢先拉取', async () => {
    settingsStore.start();
    expect(handlers.has('settings.changed')).toBe(true);
    const seq = settingsStore.changeSeq;
    await settingsStore.handleChanged({ itemIds: ['models.default-main'] });
    expect(settingsStore.changeSeq).toBe(seq + 1);
    expect(settingsStore.lastChangedItemIds).toEqual(['models.default-main']);
    expect(calls).toEqual([]);
  });

  it('已加载：事件到达即刷新 settings 与 providers，读 store 的界面跟着变', async () => {
    await settingsStore.refresh();
    let seen = '';
    const stop = $effect.root(() => {
      $effect(() => {
        seen = settingsStore.settings?.defaultMainModel ?? '';
      });
    });
    flushSync();
    expect(seen).toBe('custom:mock/mock-main');

    calls.length = 0;
    mainModel = 'custom:mock/mock-light';
    handlers.get('settings.changed')!({ itemIds: ['models.default-main', 'models.default-light'] });
    await vi.waitFor(() => expect(calls).toEqual(['settings.get', 'providers.list']));
    await vi.waitFor(() => {
      flushSync();
      expect(seen).toBe('custom:mock/mock-light');
    });
    expect(settingsStore.lastChangedItemIds).toEqual([
      'models.default-main',
      'models.default-light',
    ]);
    stop();
  });

  it('重复 start 不重复订阅', () => {
    const before = handlers.get('settings.changed');
    settingsStore.start();
    expect(handlers.get('settings.changed')).toBe(before);
  });
});
