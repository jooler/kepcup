/**
 * 备忘卡根节点类名。
 *
 * - 已转事项的卡片整卡半透明（body、footer、按钮一起变淡，是需求要的观感），
 *   hover 或键盘焦点进入卡片内时恢复全不透明。
 * - 类名放在模块里而不是模板里，方便单测断言；Tailwind 会扫 .ts 源码，字面量类名照样生成。
 */
export const MEMO_CARD_BASE_CLASS =
  'group/memo flex min-w-0 flex-col rounded-lg border bg-card p-3 text-sm';

/** 已转事项（converted）的追加类：半透明 + 平滑过渡 + hover / 焦点内恢复。 */
export const MEMO_CARD_CONVERTED_CLASS =
  'opacity-50 transition-opacity hover:opacity-100 focus-within:opacity-100';

export function memoCardClass(converted: boolean): string {
  return converted ? `${MEMO_CARD_BASE_CLASS} ${MEMO_CARD_CONVERTED_CLASS}` : MEMO_CARD_BASE_CLASS;
}
