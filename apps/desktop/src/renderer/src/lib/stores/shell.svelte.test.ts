import { flushSync } from 'svelte';
import { beforeEach, describe, expect, it } from 'vitest';
import { narrowLayout } from '$lib/features/shell/narrow-layout.svelte';
import { shell } from './shell.svelte';

/**
 * 窄屏 / 宽屏的设置类浮层状态（审查 #2 #7 #11d）。用真实的 shell + narrowLayout store
 * （desktop-svelte 项目，真 $state）。
 */

function setNarrow(narrow: boolean): void {
  narrowLayout.windowWidth = narrow ? 375 : 1280;
  flushSync();
}

beforeEach(() => {
  setNarrow(false);
  shell.closeSettings();
  shell.extensionCenterOpen = false;
  shell.searchOpen = false;
  narrowLayout.tab = 'chats';
  narrowLayout.botDetailOpen = false;
});

describe('closeSettings 统一收起宽屏弹框与窄屏设置页（审查 #2）', () => {
  it('窄屏设置页开着时 closeSettings 关掉它（设置里「去扩展中心」不再被 z-50 的设置页盖住）', () => {
    setNarrow(true);
    shell.openSettings('apps');
    expect(shell.narrowSettingsOpen).toBe(true);
    // AppsSection / DeveloperSection：先 closeSettings 再 openExtensionCenter。
    shell.closeSettings();
    shell.openExtensionCenter('connections');
    expect(shell.narrowSettingsOpen).toBe(false);
    expect(shell.narrowSettingsSection).toBeNull();
    expect(shell.extensionCenterOpen).toBe(true);
  });

  it('宽屏弹框同样关闭', () => {
    shell.openSettings('general');
    expect(shell.settingsOpen).toBe(true);
    shell.closeSettings();
    expect(shell.settingsOpen).toBe(false);
  });
});

describe('宽 / 窄切换统一复位（审查 #7）', () => {
  it('窄屏设置页开着 → 拉宽复位 → 再拉窄不会自己弹出', () => {
    setNarrow(true);
    shell.openSettings('models');
    narrowLayout.tab = 'me';
    setNarrow(false);
    shell.resetForLayoutChange();
    setNarrow(true);
    shell.resetForLayoutChange();
    expect(shell.narrowSettingsOpen).toBe(false);
    expect(shell.narrowSettingsSection).toBeNull();
    expect(narrowLayout.tab).toBe('chats');
  });

  it('宽屏弹框开着 → 拉窄复位：弹框不留在窄屏里', () => {
    shell.openSettings('models');
    setNarrow(true);
    shell.resetForLayoutChange();
    expect(shell.settingsOpen).toBe(false);
    expect(shell.narrowSettingsOpen).toBe(false);
  });
});

describe('窄屏设置页返回（审查 #11d）', () => {
  it('深链直达详情页：返回一次直接关闭（回到来源页）', () => {
    setNarrow(true);
    shell.openSettings('models', 'default-models');
    expect(shell.narrowSettingsSection).toBe('models');
    shell.backNarrowSettings();
    expect(shell.narrowSettingsOpen).toBe(false);
  });

  it('从列表点进详情：返回回列表，再返回关闭', () => {
    setNarrow(true);
    shell.openSettings();
    expect(shell.narrowSettingsSection).toBeNull();
    shell.selectNarrowSettingsSection('general');
    shell.backNarrowSettings();
    expect(shell.narrowSettingsOpen).toBe(true);
    expect(shell.narrowSettingsSection).toBeNull();
    shell.backNarrowSettings();
    expect(shell.narrowSettingsOpen).toBe(false);
  });

  it('深链打开后用户又从列表进入别的分组，来源标记被清除', () => {
    setNarrow(true);
    shell.openSettings('models');
    shell.narrowSettingsSection = null; // 假设已回到列表
    shell.selectNarrowSettingsSection('general');
    expect(shell.narrowSettingsFromLink).toBe(false);
  });
});

describe('窄屏深链路由', () => {
  it('openSettings("contacts") 在窄屏切通讯录 tab，不打开设置页', () => {
    setNarrow(true);
    shell.openSettings('contacts');
    expect(narrowLayout.tab).toBe('contacts');
    expect(shell.narrowSettingsOpen).toBe(false);
  });
});

describe('窄屏断点滞回（宽度 → narrow，真实 store）', () => {
  it('640 进入、680 退出，断点附近抖动不翻转', () => {
    narrowLayout.windowWidth = 700;
    expect(narrowLayout.narrow).toBe(false);
    narrowLayout.windowWidth = 639;
    expect(narrowLayout.narrow).toBe(true);
    narrowLayout.windowWidth = 660;
    expect(narrowLayout.narrow).toBe(true);
    narrowLayout.windowWidth = 679;
    expect(narrowLayout.narrow).toBe(true);
    narrowLayout.windowWidth = 680;
    expect(narrowLayout.narrow).toBe(false);
    narrowLayout.windowWidth = 650;
    expect(narrowLayout.narrow).toBe(false);
  });
});

describe('对话内设置卡深链：Bot 详情 / 项目设置（todo/conversational-app-setup.md §6.1）', () => {
  beforeEach(() => {
    shell.rightPanelCollapsed = true;
    shell.rightPanelTabRequest = null;
    shell.botPanelAnchor = null;
    shell.projectSettingsRequest = null;
  });

  it('宽屏：展开右栏、请求页签与锚点', () => {
    shell.openBotPanel('profile', 'bot-model');
    expect(shell.rightPanelCollapsed).toBe(false);
    expect(narrowLayout.botDetailOpen).toBe(false);
    expect(shell.rightPanelTabRequest).toBe('profile');
    expect(shell.botPanelAnchor).toBe('bot-model');
  });

  it('窄屏：打开 Bot 详情覆盖层而不是展开右栏', () => {
    setNarrow(true);
    shell.openBotPanel('skills');
    expect(narrowLayout.botDetailOpen).toBe(true);
    expect(shell.rightPanelCollapsed).toBe(true);
    expect(shell.rightPanelTabRequest).toBe('skills');
    expect(shell.botPanelAnchor).toBeNull();
  });

  it('项目设置：先到 Bot 配置页签，再留一个带锚点的请求给 ProjectSelector', () => {
    shell.openProjectSettings('project-ports');
    expect(shell.rightPanelTabRequest).toBe('profile');
    expect(shell.projectSettingsRequest).toEqual({ anchor: 'project-ports' });
  });
});
