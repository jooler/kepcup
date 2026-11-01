import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

/**
 * 事项排序 / 拖拽开关 / 卡片底栏的模板接线（D90 §5.2）。
 *
 * 这几处只能靠「模板里到底连了哪个值」来验证（渲染层没有 DOM 测试基建，同一目录的
 * memo-card-class.test.ts 也是读源码断言）。排序算法本身在 workbench-model.test.ts。
 */

const pane = readFileSync(new URL('./TodoPane.svelte', import.meta.url), 'utf8');
const lane = readFileSync(new URL('./TodoLane.svelte', import.meta.url), 'utf8');
const card = readFileSync(new URL('./TodoCard.svelte', import.meta.url), 'utf8');
const view = readFileSync(new URL('./WorkbenchView.svelte', import.meta.url), 'utf8');

describe('排序方式开关', () => {
  test('排序方式是设置标量，默认关闭（= 按开始时间）', () => {
    // 点击后先乐观、store 跟上后清掉；默认关闭由 shared schema 保证。
    expect(pane).toContain('settingsStore.settings?.workbenchTodoCustomOrder === true');
    expect(pane).toContain('customOrderOverride');
  });

  test('排序方式传进 buildLanes，切换只写设置、不改 position', () => {
    expect(pane).toMatch(/buildLanes\(\{[\s\S]*customOrder,/);
    expect(pane).toContain('settingsStore.update({ workbenchTodoCustomOrder: next })');
    // 开关不得调用 todos.move / 位置写回。
    expect(pane).not.toContain('todos.move');
    expect(pane).not.toMatch(/\.position/);
  });

  test('「更多」菜单在事项栏头里，只有一份（宽屏与窄屏 tab 共用）', () => {
    expect(pane).toContain('data-testid="todo-more-menu"');
    expect(pane).toContain('data-testid="todo-custom-order-toggle"');
    expect(pane).toContain("t('workbench.todos.more')");
    expect(pane).toContain('checked={customOrder}');
    // 标题与菜单下移进 TodoPane 后，WorkbenchView 不再自己渲染事项标题（否则会有两个菜单）。
    expect(pane).toContain("t('workbench.todos.title')");
    expect(view).not.toContain('todo-more-menu');
    // 只剩备忘标题那一个 h2（事项标题已在 TodoPane 里）。
    expect((view.match(/<h2/g) ?? []).length).toBe(1);
    expect((view.match(/<TodoPane \/>/g) ?? []).length).toBe(1);
  });

  test('禁用拖拽时道内顺序直接来自 lane.todos（按开始时间），开关打开才可拖', () => {
    expect(pane).toMatch(/<TodoLane[\s\S]*draggable={customOrder}/);
    expect(lane).toContain('dragDisabled: !draggable');
    expect(lane).toContain("data-draggable={draggable ? 'true' : 'false'}");
  });
});

describe('事项卡底栏', () => {
  test('底栏顺序：执行者 → 执行时间 → 空隙 → 主操作', () => {
    const row = card.indexOf('flex flex-wrap items-center gap-x-3 gap-y-1');
    const assignee = card.indexOf('data-testid="todo-card-assignee"');
    const when = card.indexOf('data-testid="todo-card-when"');
    // 空隙 + 按钮组：ml-auto 把按钮推到右端。
    const actions = card.indexOf('ml-auto flex flex-wrap items-center justify-end gap-1');
    expect(row).toBeGreaterThan(-1);
    expect(assignee).toBeGreaterThan(row);
    expect(when).toBeGreaterThan(assignee);
    expect(actions).toBeGreaterThan(when);
  });

  test('「恢复」按钮在底栏按钮组里，不是单独一行', () => {
    const actions = card.indexOf('ml-auto flex flex-wrap items-center justify-end gap-1');
    const reopen = card.indexOf('data-testid="todo-card-reopen"');
    expect(reopen).toBeGreaterThan(actions);
    // 底栏之后只剩按钮组的闭合与卡片闭合，没有第二个按钮行。
    expect(card.indexOf('mt-2 flex flex-wrap justify-end')).toBe(-1);
  });

  test('退回原因与周期执行摘要仍留在正文区，不进底栏', () => {
    const actions = card.indexOf('ml-auto flex flex-wrap items-center justify-end gap-1');
    expect(card.indexOf('data-testid="todo-card-blocked"')).toBeLessThan(actions);
    expect(card.indexOf('data-testid="todo-card-last-run"')).toBeLessThan(actions);
  });
});
