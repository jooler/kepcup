/**
 * 左栏「按最后消息时间自动排序」的时间快照与去抖参数（纯逻辑，可单测）。
 *
 * 多个 Bot 同时执行时消息事件可能每秒来好几次。如果每次事件都立刻重排，
 * 条目会在列表里来回跳。这里只维护一份「已提交」的时间快照，布局按快照
 * 排序；事件先把新时间攒起来，安静 {@link SIDEBAR_SORT_DEBOUNCE_MS} 后再
 * 一次性提交——期间列表保持原顺序。持续不断的更新用
 * {@link SIDEBAR_SORT_MAX_WAIT_MS} 兜底，避免永远等不到安静期而一直不重排。
 */

/** 最后一条消息停下多久后提交重排（ms）。 */
export const SIDEBAR_SORT_DEBOUNCE_MS = 900;

/** 连续更新的最长等待（ms）：超过后强制提交一次，避免饿死排序。 */
export const SIDEBAR_SORT_MAX_WAIT_MS = 4000;

export interface ActivitySource {
  id: string;
  lastMessageAt?: number | null;
  createdAt?: number;
}

function activityOf(item: ActivitySource): number {
  const at = item.lastMessageAt ?? item.createdAt ?? 0;
  return Number.isFinite(at) ? at : 0;
}

/** conversationId → 活跃时间（最后一条消息，没有消息时用创建时间）。 */
export function activitySnapshotOf(items: readonly ActivitySource[]): Record<string, number> {
  const snapshot: Record<string, number> = {};
  for (const item of items) snapshot[item.id] = activityOf(item);
  return snapshot;
}

/** 两份快照是否完全相同（不做重排时省掉一次提交）。 */
export function sameActivitySnapshot(
  a: Record<string, number>,
  b: Record<string, number>,
): boolean {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  return aKeys.every((key) => a[key] === b[key]);
}
