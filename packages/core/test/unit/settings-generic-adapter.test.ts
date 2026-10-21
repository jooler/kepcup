import { describe, expect, it } from 'vitest';
import { getSettingItem, settingsSchema, type Settings } from '@kepcup/shared';
import { genericSettingsAdapter } from '../../src/settings/generic-adapter.js';
import type { AdapterDeps, ItemAdapter } from '../../src/settings/adapters.js';

/**
 * 通用标量适配器（todo/settings-catalog-registry.md §4.2.4 / 任务 3）：
 * 顶层标量读写、只改提交的字段、静态选项与数值边界校验、行为与被替换的
 * `workbenchEnabledAdapter` 一致。
 */

function harness(patch: Partial<Settings> = {}) {
  let settings = settingsSchema.parse({ ...patch });
  const deps: AdapterDeps = {
    settings: {
      get: () => settings,
      update: (next) => {
        settings = settingsSchema.parse({ ...settings, ...next });
        return settings;
      },
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
  return { deps, read: () => settings };
}

function adapterOf(item: Parameters<typeof genericSettingsAdapter>[1]): ItemAdapter {
  const { deps } = harness();
  return genericSettingsAdapter(deps, item);
}

describe('genericSettingsAdapter', () => {
  it('reads and writes the workbench toggle like the bespoke adapter did', () => {
    const item = getSettingItem('general.workbench')!;
    const { deps, read } = harness();
    const adapter = genericSettingsAdapter(deps, item);
    const target = { botId: null, conversationId: null, workdirId: null };

    expect(adapter.read(item, target)).toMatchObject({
      status: 'configured',
      values: { enabled: false },
      summary: '已关闭',
    });
    const normalized = adapter.normalize!(item, { enabled: true }, target);
    expect(normalized).toEqual({ ok: true, values: { enabled: true } });
    adapter.write!(item, { next: { enabled: true }, secrets: {} }, target);
    expect(read().workbenchEnabled).toBe(true);
    expect(adapter.read(item, target).summary).toBe('已开启');
  });

  it('only writes the submitted fields, leaving sibling settings untouched', () => {
    const item = getSettingItem('general.workbench')!;
    const { deps, read } = harness({ launchAtLogin: true });
    const adapter = genericSettingsAdapter(deps, item);
    adapter.write!(item, { next: { enabled: true }, secrets: {} }, {
      botId: null,
      conversationId: null,
      workdirId: null,
    });
    expect(read().workbenchEnabled).toBe(true);
    expect(read().launchAtLogin).toBe(true);
  });

  it('rejects wrong types, out-of-range numbers and off-list static options', () => {
    const workbench = getSettingItem('general.workbench')!;
    const target = { botId: null, conversationId: null, workdirId: null };
    const workbenchAdapter = adapterOf(workbench);
    expect(workbenchAdapter.normalize!(workbench, { enabled: 'yes' }, target)).toEqual({
      ok: false,
      message: 'enabled 应为 true / false',
    });

    const item = {
      ...workbench,
      id: 'general.demo',
      fields: [
        { ...workbench.fields[0]!, name: 'volume', type: 'number' as const, min: 1, max: 5, label: '音量' },
      ],
    };
    const adapter = genericSettingsAdapter(harness().deps, item);
    expect(adapter.normalize!(item, { volume: 9 }, target)).toEqual({
      ok: false,
      message: '音量应为 1–5 的数字',
    });
    expect(adapter.normalize!(item, { volume: '3' }, target)).toEqual({
      ok: false,
      message: 'volume 应为数字',
    });

    const selectItem = {
      ...workbench,
      id: 'general.demo-select',
      fields: [
        {
          ...workbench.fields[0]!,
          name: 'mode',
          type: 'select' as const,
          options: 'static' as const,
          staticOptions: [
            { value: 'fast', label: '快' },
            { value: 'slow', label: '慢' },
          ],
          label: '模式',
        },
      ],
    };
    const selectAdapter = genericSettingsAdapter(harness().deps, selectItem);
    expect(selectAdapter.normalize!(selectItem, { mode: 'turbo' }, target)).toEqual({
      ok: false,
      message: '模式只能是 fast / slow',
    });
    expect(selectAdapter.normalize!(selectItem, { mode: 'fast' }, target)).toEqual({
      ok: true,
      values: { mode: 'fast' },
    });
  });

  it('never widens permission', () => {
    const item = getSettingItem('general.workbench')!;
    expect(adapterOf(item).valuesWiden?.(item, null, { enabled: true })).toBe(false);
  });
});
