import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { SIDEBAR_ICON_ACTIVE_CLASS, SIDEBAR_ROW_ACTIVE_CLASS } from './sidebar-active-class';

const SOURCE = readFileSync(new URL('./AppSidebar.svelte', import.meta.url), 'utf8');

/** 取 `marker` 每一处出现之前的一段源码（class 属性写在 data-testid 之前）。 */
function windowsBefore(marker: string, size = 600): string[] {
  return [...SOURCE.matchAll(new RegExp(marker, 'g'))].map((match) =>
    SOURCE.slice(Math.max(0, (match.index ?? 0) - size), match.index),
  );
}

describe('左栏选中态底色', () => {
  test('展开态与图标态各一套亮/暗底色', () => {
    expect(SIDEBAR_ROW_ACTIVE_CLASS).toBe(
      'data-active:bg-[oklch(0.925_0_0)] dark:data-active:bg-[oklch(0.25_0_0)]',
    );
    expect(SIDEBAR_ICON_ACTIVE_CLASS).toBe(
      'data-active:bg-[oklch(0.93_0_0)] dark:data-active:bg-[oklch(0.16_0_0)]',
    );
  });

  // 曾经的 bug：工作台入口展开态内联 0.98 / 0.5，亮色几乎等于侧栏底色（看不出
  // 高亮）、暗色又明显过亮；对话行是 0.925 / 0.25。两处必须取同一套 token。
  test('工作台入口展开态与对话行取同一套底色', () => {
    const workbench = windowsBefore('data-testid="workbench-nav"');
    // 工作台入口两处：图标态（data-active 三态写法）与展开态（isActive={workbenchActive}）。
    expect(workbench).toHaveLength(2);

    const expanded = workbench.filter((window) => window.includes('isActive={workbenchActive}'));
    expect(expanded).toHaveLength(1);
    expect(expanded[0]).toContain('{SIDEBAR_ROW_ACTIVE_CLASS}');

    const iconOnly = workbench.find((window) => window.includes('data-active={workbenchActive'));
    expect(iconOnly).toBeDefined();
    expect(iconOnly).toContain('{SIDEBAR_ICON_ACTIVE_CLASS}');
  });

  test('左栏不再内联 active 底色字面量，全部从常量取', () => {
    // 内联字面量正是上一条 bug 的来源：任何一处重新写死都会脱离共用 token。
    expect(SOURCE).not.toMatch(/data-active:bg-\[/);
    // 展开态两处：工作台入口 + 对话行。
    expect(SOURCE.match(/\{SIDEBAR_ROW_ACTIVE_CLASS\}/g) ?? []).toHaveLength(2);
    // 图标态三处：工作台入口 + 对话条目 + 设置分类。
    expect(SOURCE.match(/\{SIDEBAR_ICON_ACTIVE_CLASS\}/g) ?? []).toHaveLength(3);
  });
});
