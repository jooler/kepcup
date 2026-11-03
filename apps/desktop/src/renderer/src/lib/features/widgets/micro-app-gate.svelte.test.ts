import { describe, expect, test } from 'vitest';
import type { WidgetCard } from '@kepcup/shared';
import { microAppConsents } from './micro-app-consent.svelte';
import { microAppEffectiveConsentOk, microAppOpenAllowed } from './micro-app-gate';

/**
 * 微应用运行门控（审查修复 F5）：pre-open fail-closed 与 open 后对生效指纹的兜底复核
 * ——防「卡片门控基于过期指纹」把扩大后的能力面静默放进运行时。node 下单例的
 * localStorage 不可用（会话内记忆），直接用单例读写。
 */

const base: WidgetCard = {
  widgetId: 'wgt_gate_1',
  version: 1,
  title: 't',
  description: '',
  scope: 'conversation',
  sha256: 'a',
  queriesSha256: '',
  queriesCount: 0,
  sizeBytes: 1,
  botId: null,
  createdAt: 1,
  checkStatus: 'legacy',
  knownIssues: [],
  microApp: {
    name: 't',
    slug: 't',
    permissions: ['storage.kv'],
    netMode: 'open',
    netAllowlist: [],
    displayMode: 'immersive',
  },
  capabilityFingerprint: 'v1|perm:storage.kv|net:open',
};

describe('microAppOpenAllowed（挂载前门控）', () => {
  test('卡片无指纹（损坏 / 旧结构）→ 拒绝（fail closed）', () => {
    expect(microAppOpenAllowed({ ...base, capabilityFingerprint: undefined })).toBe(false);
    expect(microAppOpenAllowed({ ...base, capabilityFingerprint: '' })).toBe(false);
  });

  test('未确认 → 拒绝；有确认记录（不论哪个指纹）→ 放行到 open（执法在生效指纹复核）', () => {
    expect(microAppOpenAllowed(base)).toBe(false);
    microAppConsents.remember('wgt_gate_1', 'v1|perm:storage.kv|net:open', 'b1', 1);
    expect(microAppOpenAllowed(base)).toBe(true);
    // 扩权更新后的旧卡（卡片冻结指纹 ≠ 确认记录里的生效指纹）同样能走到 open——
    // 生效能力面由 microAppEffectiveConsentOk 在 open 之后兜底，不会静默运行。
    expect(
      microAppOpenAllowed({ ...base, capabilityFingerprint: 'v1|perm:storage.kv|net:none' }),
    ).toBe(true);
  });
});

describe('microAppEffectiveConsentOk（open 后兜底复核）', () => {
  test('生效指纹 = 已确认指纹 → 通过；能力面扩大（新指纹）→ 拒绝', () => {
    expect(microAppEffectiveConsentOk('wgt_gate_1', 'v1|perm:storage.kv|net:open')).toBe(true);
    expect(microAppEffectiveConsentOk('wgt_gate_1', 'v1|perm:storage.kv,ai.chat|net:open')).toBe(false);
    expect(microAppEffectiveConsentOk('wgt_gate_1', '')).toBe(false);
  });
});
