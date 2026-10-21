import { describe, expect, it } from 'vitest';
import { getSettingItem, settingsSchema } from '@kepcup/shared';
import {
  EXPLICIT_ADAPTER_FALLBACK,
  SETTING_ADAPTER_CONTRIBUTIONS,
  assembleAdapters,
  buildItemAdapters,
  settingAdapterContributionIds,
} from '../../src/settings/contributions/index.js';
import type { SettingAdapterContribution } from '../../src/settings/contributions/types.js';
import { settingsAdapterCoverageProblems } from '@kepcup/shared';
import type { AdapterDeps } from '../../src/settings/adapters.js';

/**
 * 目录条目 → core 适配器闭合（todo/settings-catalog-registry.md §4.1.4 / 任务 2）：
 * 需要适配器的条目必须登记；漏登记的条目 `settings_read` 回 `unknown` 而不是 `configured`。
 */

const deps: AdapterDeps = {
  settings: {
    get: () => settingsSchema.parse({}),
    update: (patch) => settingsSchema.parse(patch),
  },
  secrets: { hasValue: () => false, setValue: () => undefined },
  providers: { list: () => [], setKey: () => undefined },
  bots: { get: () => null },
  botProfiles: {
    apply: () => {
      throw new Error('not used');
    },
  },
  publish: () => undefined,
};

describe('settings adapter coverage', () => {
  it('every core catalog-writable item has an adapter or a justified fallback', () => {
    expect(
      settingsAdapterCoverageProblems({
        adapterIds: settingAdapterContributionIds(),
        explicitFallback: EXPLICIT_ADAPTER_FALLBACK,
      }),
    ).toEqual([]);
  });

  it('the only explicit fallback is profile.user-facts', () => {
    expect(Object.keys(EXPLICIT_ADAPTER_FALLBACK)).toEqual(['profile.user-facts']);
  });

  it('a forgotten adapter is called out by name', () => {
    const withoutWorkbench = settingAdapterContributionIds().filter((id) => id !== 'general.task-loop');
    expect(
      settingsAdapterCoverageProblems({
        adapterIds: withoutWorkbench,
        explicitFallback: EXPLICIT_ADAPTER_FALLBACK,
      }),
    ).toEqual([
      'general.task-loop：需要 core 适配器（core 拥有、经目录写入），但不在贡献表里，也没有登记 EXPLICIT_ADAPTER_FALLBACK 理由',
    ]);
  });
});

describe('buildItemAdapters assembly', () => {
  it('unregistered core items read as unknown, never configured', () => {
    const adapterOf = buildItemAdapters(deps);
    const ghost = { ...getSettingItem('general.workbench')!, id: 'general.ghost', store: { kind: 'settings', paths: ['x'] } };
    const snapshot = adapterOf(ghost).read(ghost, { botId: null, conversationId: null, workdirId: null });
    expect(snapshot.status).toBe('unknown');
    expect(snapshot.values).toBeNull();
    expect(snapshot.summary).toContain('未接入');
  });

  it('duplicate registrations across contributions throw', () => {
    const duplicate: readonly SettingAdapterContribution[] = [
      { name: 'a', adapters: { 'general.task-loop': (d) => buildItemAdapters(d)(getSettingItem('general.task-loop')!) } },
      SETTING_ADAPTER_CONTRIBUTIONS.find((c) => c.name === 'general')!,
    ];
    expect(() => assembleAdapters(duplicate, deps)).toThrow('重复的设置适配器：general.task-loop');
  });

  it('generic settings items are served by the generic adapter without a contribution', () => {
    const adapterOf = buildItemAdapters(deps);
    const workbench = getSettingItem('general.workbench')!;
    const snapshot = adapterOf(workbench).read(workbench, { botId: null, conversationId: null, workdirId: null });
    expect(snapshot.status).toBe('configured');
    expect(snapshot.values).toEqual({ enabled: false });
    expect(snapshot.summary).toBe('已关闭');
  });
});
