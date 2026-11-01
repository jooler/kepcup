import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { MEMO_CARD_BASE_CLASS, MEMO_CARD_CONVERTED_CLASS, memoCardClass } from './memo-card-class';

const SOURCE = readFileSync(new URL('./MemoCard.svelte', import.meta.url), 'utf8');

describe('备忘卡类名', () => {
  test('普通卡片不带半透明', () => {
    expect(memoCardClass(false)).toBe(MEMO_CARD_BASE_CLASS);
    expect(memoCardClass(false)).not.toContain('opacity-50');
  });

  test('已转事项整卡半透明，hover / 焦点内恢复', () => {
    const className = memoCardClass(true);
    expect(className).toContain(MEMO_CARD_BASE_CLASS);
    expect(className).toContain('opacity-50');
    expect(className).toContain('hover:opacity-100');
    expect(className).toContain('focus-within:opacity-100');
    expect(className).toContain('transition-opacity');
    // 半透明是整卡的（含 footer 按钮与徽标），不做成只给正文降透明度。
    expect(MEMO_CARD_CONVERTED_CLASS).not.toContain('memo-body');
  });
});

describe('备忘卡模板接线（MemoCard.svelte）', () => {
  test('根节点类名走 memoCardClass(converted)，判定复用 converted', () => {
    const root = SOURCE.slice(
      SOURCE.indexOf('data-testid="memo-card"') - 400,
      SOURCE.indexOf('data-testid="memo-card"'),
    );
    expect(root).toContain('class={memoCardClass(converted)}');
    expect(SOURCE).toContain('const converted = $derived(');
    // 判定走 workbench-model 的纯函数（看过 status），不能退回只看 memoId 的写法。
    expect(SOURCE).toContain('$derived(memoConverted(workbench.todos, memo.id))');
    expect(SOURCE).not.toContain('todos.some((todo) => todo.memoId === memo.id)');
  });

  test('拖拽把手是 footer 里的覆盖层，正文仍是 contenteditable', () => {
    expect(SOURCE).toContain('use:dragHandle');
    expect(SOURCE).toContain('data-testid="memo-drag-handle"');
    expect(SOURCE).toContain('absolute inset-0 cursor-grab');
    expect(SOURCE).toContain('contenteditable="plaintext-only"');
    // footer 容器要 relative，覆盖层才只盖 footer。
    const footer = SOURCE.slice(
      SOURCE.indexOf('data-testid="memo-footer"') - 200,
      SOURCE.indexOf('data-testid="memo-footer"'),
    );
    expect(footer).toContain('relative');
  });

  test('grip 非 hover 时 display:none，不再用 opacity 占位', () => {
    const grip = SOURCE.slice(
      SOURCE.indexOf('data-testid="memo-drag-grip"') - 300,
      SOURCE.indexOf('data-testid="memo-drag-grip"'),
    );
    expect(grip).toContain('hidden');
    expect(grip).toContain('group-hover/memo:block');
    expect(grip).not.toContain('opacity-0');
  });
});
