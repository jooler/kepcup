/**
 * 新建群聊输入条（GroupComposeBar）的纯逻辑：候选过滤与回车的决定。组件没有 DOM
 * 测试环境，判断都落在这里单测；真实交互见 e2e `group-compose.spec.ts`。
 */

export interface ComposeCandidate {
  id: string;
  name: string;
}

/** 候选列表：去掉已选成员，按名称（不区分大小写）包含输入过滤，保持通讯录顺序。 */
export function composeCandidates<T extends ComposeCandidate>(
  bots: readonly T[],
  selectedIds: readonly string[],
  query: string,
): T[] {
  const selected = new Set(selectedIds);
  const needle = query.trim().toLowerCase();
  return bots.filter((bot) => {
    if (selected.has(bot.id)) return false;
    return needle.length === 0 || bot.name.toLowerCase().includes(needle);
  });
}

export type ComposeEnterAction =
  /** 加入一个已有 Bot（方向键选中的候选，或与输入同名的 Bot）。 */
  | { kind: 'add'; botId: string }
  /** 输入的名字已是某个已选成员：不重复新建，清空输入即可。 */
  | { kind: 'alreadySelected'; botId: string }
  /** 新建一个画像为空、名字为输入内容的 Bot 并加入。 */
  | { kind: 'create'; name: string }
  /** 空回车且已选够 2 人：创建群。 */
  | { kind: 'commit' }
  /** 空回车但不足 2 人：提示再选成员。 */
  | { kind: 'needMembers' };

/**
 * 回车做什么：
 * 1. 用方向键选中了候选（highlight ≥ 0）→ 加入该候选；
 * 2. 有输入 → 名称（去首尾空白、不区分大小写）完全相同的未选 Bot 直接加入；
 *    同名的只有已选成员 → 不新建重名 Bot；否则新建；
 * 3. 空输入 → 够 2 人就建群，否则提示。
 */
export function composeEnterAction(input: {
  query: string;
  bots: readonly ComposeCandidate[];
  selectedIds: readonly string[];
  /** 当前候选列表（composeCandidates 的结果）。 */
  candidates: readonly ComposeCandidate[];
  /** 方向键选中的候选下标；-1 = 没有用方向键选择。 */
  highlight: number;
}): ComposeEnterAction {
  const picked = input.highlight >= 0 ? input.candidates[input.highlight] : undefined;
  if (picked !== undefined) return { kind: 'add', botId: picked.id };

  const text = input.query.trim();
  if (text.length > 0) {
    const needle = text.toLowerCase();
    const selected = new Set(input.selectedIds);
    const same = input.bots.filter((bot) => bot.name.trim().toLowerCase() === needle);
    const unselected = same.find((bot) => !selected.has(bot.id));
    if (unselected !== undefined) return { kind: 'add', botId: unselected.id };
    const already = same.find((bot) => selected.has(bot.id));
    if (already !== undefined) return { kind: 'alreadySelected', botId: already.id };
    return { kind: 'create', name: text };
  }

  const selectedCount = input.selectedIds.filter((id) =>
    input.bots.some((bot) => bot.id === id),
  ).length;
  return selectedCount >= 2 ? { kind: 'commit' } : { kind: 'needMembers' };
}

/** 方向键移动高亮：-1（未选）↔ 0 … length-1，两端不回绕。 */
export function stepHighlight(current: number, direction: 'up' | 'down', length: number): number {
  if (length === 0) return -1;
  if (direction === 'down') return Math.min(length - 1, current + 1);
  return Math.max(-1, Math.min(length - 1, current) - 1);
}
