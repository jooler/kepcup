/**
 * W1 ref 指纹（todo/borrowings-from-personal-agents.md W1 设计 2）：快照时给
 * 每个 ref 记下 `{ backendNodeId, role, name }`，click / type 前用节点当前的
 * role + 可访问名比对。同一文档内 SPA 重渲染后 backendNodeId 可能指向已换了
 * 内容的节点——比对不上就判 stale（派发前失败，不产生副作用）。
 *
 * 名字只比前 40 个字符且先去掉数字：计数徽章、时间这类随内容变化的名字不该
 * 误判（误判的代价只是多一次快照）。纯函数，browser-host 与单测共用。
 */

export interface RefFingerprint {
  backendNodeId: number;
  role: string;
  /** Accessible name as listed in the snapshot (may carry the 80-char cut + “…”). */
  name: string;
}

/** Characters of the (normalized) name compared. */
export const REF_NAME_COMPARE_CHARS = 40;

/**
 * Name key for comparison: no trailing ellipsis, short digit runs (≤ 3 —
 * badges, counters, times) removed, collapsed spaces, at most 40 chars.
 * Longer numbers (order ids, amounts like 10023) stay: they tell elements apart.
 */
export function normalizeRefName(name: string): string {
  return name
    .replace(/…$/u, '')
    .replace(/(?<!\p{Nd})\p{Nd}{1,3}(?!\p{Nd})/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, REF_NAME_COMPARE_CHARS)
    .trim();
}

export type RefMismatch = 'role' | 'name' | null;

/**
 * Compares the snapshot-time fingerprint with the node's current role/name.
 * Roles must be equal. Names must be equal after normalization; a prefix
 * relation only counts when the listed name was cut (ends in “…”, the 80-char
 * snapshot cut) — "Pay" never matches "Pay $500 now". An empty name only
 * matches an empty name.
 */
export function compareRefFingerprint(
  expected: Pick<RefFingerprint, 'role' | 'name'>,
  current: { role: string; name: string },
): RefMismatch {
  if (expected.role !== current.role) return 'role';
  const storedRaw = expected.name.trim();
  const currentRaw = current.name.trim();
  if (storedRaw.length === 0 || currentRaw.length === 0) {
    return storedRaw.length === currentRaw.length ? null : 'name';
  }
  const a = normalizeRefName(storedRaw);
  const b = normalizeRefName(currentRaw);
  // Names made only of short numbers (pagination "2" vs "3") compare raw.
  if (a.length === 0 && b.length === 0) return storedRaw === currentRaw ? null : 'name';
  if (a === b) return null;
  if (storedRaw.endsWith('…') && b.startsWith(a)) return null;
  return 'name';
}

/**
 * Snapshot text without ref ids (`[e12]`): two snapshots of an unchanged page
 * hash equal even when the host renumbered refs (W1 设计 3 无进展熔断).
 */
export function stripSnapshotRefs(text: string): string {
  return text.replace(/\[e\d+\]/g, '[]');
}
