import { describe, expect, test } from 'vitest';
import {
  isNarrowWidth,
  NARROW_LAYOUT_EXIT_WIDTH,
  nextNarrow,
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

describe('nextNarrow（滞回：640 进入、680 退出）', () => {
  test('宽屏下：小于 640 才进入窄屏，640~679 仍是宽屏', () => {
    expect(nextNarrow(false, 639)).toBe(true);
    expect(nextNarrow(false, NARROW_LAYOUT_MAX_WIDTH)).toBe(false);
    expect(nextNarrow(false, 679)).toBe(false);
  });

  test('窄屏下：小于 680 保持窄屏，≥ 680 才退出', () => {
    expect(nextNarrow(true, 639)).toBe(true);
    expect(nextNarrow(true, 640)).toBe(true);
    expect(nextNarrow(true, NARROW_LAYOUT_EXIT_WIDTH - 1)).toBe(true);
    expect(nextNarrow(true, NARROW_LAYOUT_EXIT_WIDTH)).toBe(false);
  });

  test('在断点附近来回抖动不翻转（逐帧序列只翻转一次）', () => {
    let narrow = false;
    const flips: number[] = [];
    for (const width of [700, 650, 641, 639, 641, 645, 639, 660, 670, 679, 680, 650]) {
      const next = nextNarrow(narrow, width);
      if (next !== narrow) flips.push(width);
      narrow = next;
    }
    // 639 进入窄屏；一路到 680 才退出；650 不再进入（需 <640）。
    expect(flips).toEqual([639, 680]);
  });

  test('非法宽度视为宽屏', () => {
    expect(nextNarrow(true, Number.NaN)).toBe(false);
    expect(nextNarrow(false, Number.POSITIVE_INFINITY)).toBe(false);
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
