import type { SettingValues } from '@kepcup/shared';

/**
 * 群成员卡（`group.members`）的纯逻辑（D89 审查修复）。
 *
 * - Bot 的预填 `{bots: [...]}` 只表示「建议拉进群的 Bot」：现有成员默认一律勾选，预填只会多勾，
 *   永远不会预先取消勾选谁（core 的提议也已整理成「现有成员 ∪ 建议」）。
 * - 移出只能由用户亲手取消勾选；卡片把「将加入」「将移出」分开列出来。
 * - 用户的选择按 Bot 记成显式的勾 / 不勾（`choices`），没碰过的 Bot 跟随当前成员。所以卡片挂着
 *   期间别处新拉进群的 Bot 仍算成员，「应用」不会把它移出去。
 */

/** 预填里建议加入的 Bot id（去重，只认字符串）。 */
export function proposedMemberIds(prefill: SettingValues | null | undefined): string[] {
  const wanted = prefill?.bots;
  if (!Array.isArray(wanted)) return [];
  return [...new Set(wanted.filter((entry): entry is string => typeof entry === 'string'))];
}

export interface GroupMemberPlan {
  /** 这个 Bot 现在是否勾选。 */
  checked(id: string): boolean;
  /** 「应用」时要拉进群的（勾选了、还不是成员）。 */
  toAdd: string[];
  /** 「应用」时要移出的（现在是成员、被用户亲手取消勾选）。 */
  toRemove: string[];
  /** 勾选的人数。 */
  count: number;
}

export function groupMemberPlan(
  current: readonly string[],
  proposed: readonly string[],
  choices: Readonly<Record<string, boolean>>,
): GroupMemberPlan {
  const members = new Set(current);
  const checked = (id: string): boolean =>
    Object.hasOwn(choices, id) ? choices[id] === true : members.has(id) || proposed.includes(id);
  const candidates = [...new Set([...proposed, ...Object.keys(choices)])];
  const toAdd = candidates.filter((id) => checked(id) && !members.has(id));
  const toRemove = current.filter((id) => !checked(id));
  return {
    checked,
    toAdd,
    toRemove,
    count: current.length - toRemove.length + toAdd.length,
  };
}
