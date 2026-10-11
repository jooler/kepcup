import { describe, expect, test } from 'vitest';
import {
  isNarrowWidth,
  NARROW_HIDDEN_SETTINGS_SECTIONS,
  NARROW_LAYOUT_MAX_WIDTH,
  NARROW_TABS,
  showNarrowTabBar,
} from './narrow-layout';

describe('isNarrowWidth', () => {
  test('断点开区间：640 整属宽屏（与 Tailwind sm 一致），640 以下窄屏', () => {
    expect(isNarrowWidth(375)).toBe(true);
    expect(isNarrowWidth(NARROW_LAYOUT_MAX_WIDTH - 0.1)).toBe(true);
    expect(isNarrowWidth(NARROW_LAYOUT_MAX_WIDTH)).toBe(false);
    expect(isNarrowWidth(1280)).toBe(false);
  });

  test('非法宽度不进窄屏', () => {
    expect(isNarrowWidth(Number.NaN)).toBe(false);
    expect(isNarrowWidth(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe('showNarrowTabBar', () => {
  test('顶层 tab 页（无选中会话）显示 tab 栏', () => {
    for (const tab of NARROW_TABS) {
      expect(showNarrowTabBar(tab, false, false)).toBe(true);
    }
  });

  test('对话详情（对话 tab 下已选中会话）隐藏 tab 栏', () => {
    expect(showNarrowTabBar('chats', true, false)).toBe(false);
    // 其它 tab 下有选中会话（如从通讯录跳转过）不影响：tab 栏仍显示。
    expect(showNarrowTabBar('contacts', true, false)).toBe(true);
  });

  test('Bot 详情覆盖层打开时任何 tab 都隐藏 tab 栏', () => {
    expect(showNarrowTabBar('chats', false, true)).toBe(false);
    expect(showNarrowTabBar('chats', true, true)).toBe(false);
    expect(showNarrowTabBar('me', false, true)).toBe(false);
  });
});

describe('NARROW_HIDDEN_SETTINGS_SECTIONS', () => {
  test('窄屏设置弹框隐藏通讯录与用户画像（提取为底部 tab）', () => {
    expect([...NARROW_HIDDEN_SETTINGS_SECTIONS].sort()).toEqual(['contacts', 'profile']);
  });
});
