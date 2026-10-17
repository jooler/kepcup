import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getSettingItem, SETTING_ITEMS } from '@kepcup/shared';
import { settingDeepLinkAction } from './deep-link';
import { applyRendererValues } from './renderer-items';

describe('settingDeepLinkAction（设置卡「在设置中打开」）', () => {
  it('目录里每个深链都落到认得的分区 / 页签（不走兜底）', () => {
    for (const entry of SETTING_ITEMS) {
      const action = settingDeepLinkAction(entry.deepLink, {}, 'conv_1');
      expect(action.kind, entry.id).toBe(entry.deepLink.surface);
      if (action.kind === 'settings') expect(action.section, entry.id).toBe(entry.deepLink.section);
      if (action.kind === 'extension-center')
        expect(action.tab, entry.id).toBe(entry.deepLink.section);
    }
  });

  it('设置分区带锚点；不认识的分区退回「通用」', () => {
    expect(
      settingDeepLinkAction(
        { surface: 'settings', section: 'models', anchor: 'default-models' },
        {},
        null,
      ),
    ).toEqual({ kind: 'settings', section: 'models', anchor: 'default-models' });
    expect(settingDeepLinkAction({ surface: 'settings', section: 'nope' }, {}, null)).toEqual({
      kind: 'settings',
      section: 'general',
      anchor: null,
    });
    expect(
      settingDeepLinkAction({ surface: 'extension-center', section: 'nope' }, {}, null),
    ).toEqual({
      kind: 'extension-center',
      tab: 'skills',
    });
  });

  it('Bot 面板带作用 Bot；群设置缺省用卡片所在会话；工作目录设置带锚点', () => {
    const bot = getSettingItem('bot.network')!;
    expect(settingDeepLinkAction(bot.deepLink, { botId: 'bot_b' }, 'conv_1')).toEqual({
      kind: 'bot-panel',
      tab: 'profile',
      anchor: 'bot-network',
      botId: 'bot_b',
    });
    const group = getSettingItem('group.members')!;
    expect(settingDeepLinkAction(group.deepLink, {}, 'conv_g')).toEqual({
      kind: 'group-dialog',
      conversationId: 'conv_g',
      anchor: 'group-members',
    });
    expect(
      settingDeepLinkAction(group.deepLink, { conversationId: 'conv_x' }, 'conv_g'),
    ).toMatchObject({
      conversationId: 'conv_x',
    });
    const workdir = getSettingItem('workdir.ports')!;
    expect(settingDeepLinkAction(workdir.deepLink, {}, 'conv_1')).toEqual({
      kind: 'workdir-dialog',
      anchor: 'workdir-ports',
    });
  });
});

describe('applyRendererValues（渲染层条目的本机写入）', () => {
  it('硬件条目写启用开关与设备；其余条目不写', () => {
    const calls: string[] = [];
    const writers = {
      setSensorEnabled: (kind: string, enabled: boolean) => calls.push(`${kind}:${enabled}`),
      setSensorDevice: (kind: string, device: string) => calls.push(`${kind}@${device}`),
    };
    expect(
      applyRendererValues(getSettingItem('hardware.microphone')!, { enabled: true }, writers),
    ).toBe(true);
    expect(
      applyRendererValues(
        getSettingItem('hardware.camera')!,
        { enabled: false, device: 'cam-2' },
        writers,
      ),
    ).toBe(true);
    expect(calls).toEqual(['microphone:true', 'camera:false', 'camera@cam-2']);
    expect(applyRendererValues(getSettingItem('hardware.camera')!, {}, writers)).toBe(false);
    expect(applyRendererValues(getSettingItem('general.theme')!, { theme: 'dark' }, writers)).toBe(
      false,
    );
    const themeCalls: string[] = [];
    expect(
      applyRendererValues(getSettingItem('general.theme')!, { theme: 'dark' }, {
        ...writers,
        setTheme: (theme) => themeCalls.push(theme),
        setLanguage: (language) => themeCalls.push(language),
      }),
    ).toBe(true);
    expect(
      applyRendererValues(getSettingItem('general.language')!, { language: 'zh-CN' }, {
        ...writers,
        setTheme: () => undefined,
        setLanguage: (language) => themeCalls.push(language),
      }),
    ).toBe(true);
    expect(themeCalls).toEqual(['dark', 'zh-CN']);
  });
});

describe('界面语言（D89 审查修复：只认支持的语言）', () => {
  it('不支持的语言不写，卡片退回「在设置中打开」', () => {
    const written: string[] = [];
    const writers = {
      setSensorEnabled: () => undefined,
      setSensorDevice: () => undefined,
      setLanguage: (language: string) => written.push(language),
      languages: ['zh-CN'],
    };
    const item = getSettingItem('general.language')!;
    expect(applyRendererValues(item, { language: 'xx-YY' }, writers)).toBe(false);
    expect(applyRendererValues(item, { language: 'zh-CN' }, writers)).toBe(true);
    expect(written).toEqual(['zh-CN']);
  });

  it('目录里 general.language 的静态选项与 i18n 注册的语言一致（core 按它校验）', () => {
    const source = readFileSync(
      new URL('../../i18n/state.svelte.ts', import.meta.url),
      'utf8',
    );
    const block = /localeOptions: LocaleOption\[\] = \[([^\]]*)\]/.exec(source)?.[1] ?? '';
    const ids = [...block.matchAll(/id: '([^']+)'/g)].map((match) => match[1]);
    const field = getSettingItem('general.language')!.fields.find((entry) => entry.name === 'language')!;
    expect(field.options).toBe('static');
    expect(ids.length).toBeGreaterThan(0);
    expect((field.staticOptions ?? []).map((option) => option.value)).toEqual(ids);
  });
});
