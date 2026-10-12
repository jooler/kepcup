import { describe, expect, it } from 'vitest';
import {
  MODAL_OVERLAY_SELECTOR,
  hasOpenModal,
  isSearchShortcut,
  resolveSearchShortcut,
  type SearchShortcutState,
} from './global-shortcuts.js';

const idle: SearchShortcutState = {
  coreReady: true,
  searchOpen: false,
  onboardingOpen: false,
  settingsOpen: false,
  narrowSettingsOpen: false,
  modalOpen: false,
};

describe('isSearchShortcut', () => {
  it('Cmd/Ctrl + K（不分大小写）；其它组合不是', () => {
    expect(isSearchShortcut({ metaKey: true, ctrlKey: false, key: 'k' })).toBe(true);
    expect(isSearchShortcut({ metaKey: false, ctrlKey: true, key: 'K' })).toBe(true);
    expect(isSearchShortcut({ metaKey: false, ctrlKey: false, key: 'k' })).toBe(false);
    expect(isSearchShortcut({ metaKey: true, ctrlKey: false, key: 'j' })).toBe(false);
  });
});

describe('resolveSearchShortcut', () => {
  it('空闲时打开搜索', () => {
    expect(resolveSearchShortcut(idle)).toBe('open');
  });

  it.each([
    ['核心未就绪', { coreReady: false }],
    ['搜索已开', { searchOpen: true }],
    ['向导开着', { onboardingOpen: true }],
    ['设置弹框开着', { settingsOpen: true }],
    ['窄屏设置页开着', { narrowSettingsOpen: true }],
    ['已有其它模态（扩展中心 / 确认框 / 群设置…）', { modalOpen: true }],
  ] as const)('%s：不处理（调用方不得 preventDefault）', (_name, patch) => {
    expect(resolveSearchShortcut({ ...idle, ...patch })).toBe('ignore');
  });
});

describe('hasOpenModal', () => {
  it('用 dialog / sheet 遮罩选择器探测', () => {
    const queried: string[] = [];
    const root = (found: boolean) => ({
      querySelector: (selector: string) => {
        queried.push(selector);
        return found ? ({} as Element) : null;
      },
    });
    expect(hasOpenModal(root(true))).toBe(true);
    expect(hasOpenModal(root(false))).toBe(false);
    expect(queried).toEqual([MODAL_OVERLAY_SELECTOR, MODAL_OVERLAY_SELECTOR]);
    expect(MODAL_OVERLAY_SELECTOR).toContain('dialog-overlay');
    expect(MODAL_OVERLAY_SELECTOR).toContain('sheet-overlay');
  });
});
