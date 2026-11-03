import { describe, expect, test } from 'vitest';

import type { WidgetCard } from '@kepcup/shared';
import { MicroAppConsentStore, type MicroAppConsentStorage } from './micro-app-consent.svelte';

/** 微应用确认记忆（D112 §5.2 / Q8）：按能力面指纹，键 = widgetId。 */

function memoryStorage(): { storage: MicroAppConsentStorage; map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    storage: {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => {
        map.set(key, value);
      },
    },
  };
}

const CARD: WidgetCard = {
  widgetId: 'wgt_1',
  version: 1,
  title: '小小英语角',
  description: '',
  scope: 'conversation',
  sha256: 'a'.repeat(64),
  queriesSha256: '',
  queriesCount: 0,
  sizeBytes: 100,
  botId: 'bot_a',
  createdAt: 1,
  checkStatus: 'legacy',
  knownIssues: [],
  microApp: {
    name: '小小英语角',
    slug: 'english-corner',
    permissions: ['storage.kv'],
    netMode: 'open',
    netAllowlist: [],
    displayMode: 'immersive',
  },
  capabilityFingerprint: 'v1|perm:storage.kv|net:open',
  bundleSha256: 'b'.repeat(64),
};

describe('MicroAppConsentStore（能力面指纹确认）', () => {
  test('未确认 → 需确认；记住后同指纹通过、bundle 变化标 codeUpdated', () => {
    const { storage } = memoryStorage();
    const store = new MicroAppConsentStore(storage);
    expect(store.consented('wgt_1', CARD.capabilityFingerprint!).ok).toBe(false);
    store.remember('wgt_1', CARD.capabilityFingerprint!, CARD.bundleSha256!, 100);
    expect(store.consented('wgt_1', CARD.capabilityFingerprint!)).toEqual({ ok: true, codeUpdated: false });
    // 同指纹、代码更新（bundle 变）：沿用确认 + 标注。
    expect(store.consented('wgt_1', CARD.capabilityFingerprint!, 'c'.repeat(64))).toEqual({
      ok: true,
      codeUpdated: true,
    });
  });

  test('指纹变化（能力扩大 / 网络放宽）→ 强制重新确认', () => {
    const { storage } = memoryStorage();
    const store = new MicroAppConsentStore(storage);
    store.remember('wgt_1', 'v1|perm:storage.kv|net:open', 'b'.repeat(64), 100);
    expect(store.consented('wgt_1', 'v1|perm:storage.kv,ai.chat|net:open').ok).toBe(false);
    expect(store.consented('wgt_1', 'v1|perm:storage.kv|net:none').ok).toBe(false);
    expect(store.consented('wgt_1', 'v1|perm:storage.kv|net:allowlist:a.com,b.com').ok).toBe(false);
  });

  test('有界：超限丢最旧；存储不可用降级为会话内', () => {
    const { storage, map } = memoryStorage();
    const store = new MicroAppConsentStore(storage);
    for (let i = 0; i < 205; i += 1) {
      store.remember(`wgt_${i}`, `fp_${i}`, `b_${i}`, i);
    }
    expect(store.consented('wgt_0', 'fp_0').ok).toBe(false);
    expect(store.consented('wgt_204', 'fp_204').ok).toBe(true);
    expect(JSON.parse(map.get('kepcup.microApp.consents.v1') ?? '{}')).toHaveProperty('wgt_204');

    const sessionOnly = new MicroAppConsentStore(null);
    sessionOnly.remember('wgt_x', 'fp', 'b', 1);
    expect(sessionOnly.consented('wgt_x', 'fp').ok).toBe(true);
  });

  test('损坏的持久化数据按空处理（不抛）', () => {
    const map = new Map<string, string>([['kepcup.microApp.consents.v1', '{oops']]);
    const store = new MicroAppConsentStore({
      getItem: (key) => map.get(key) ?? null,
      setItem: (key, value) => {
        map.set(key, value);
      },
    });
    expect(store.consented('wgt_1', 'fp').ok).toBe(false);
  });

  test('与存量组件确认互不影响：存量路径的 localStorage 键不被写', () => {
    const { storage, map } = memoryStorage();
    const store = new MicroAppConsentStore(storage);
    store.remember('wgt_1', 'fp', 'b', 1);
    expect(map.has('kepcup.botWidget.consents.v1')).toBe(false);
  });
});
