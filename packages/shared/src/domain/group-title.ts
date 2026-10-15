/** 群名称上限，与 groups.create / groups.rename 的 schema 一致。 */
export const GROUP_TITLE_MAX = 100;

/**
 * 新建群的默认名称：成员名用逗号加空格拼接。超出上限时丢掉放不下的名字；
 * 单个名字本身超长时截断到上限。
 */
export function groupTitleFromMemberNames(names: readonly string[]): string {
  const parts: string[] = [];
  for (const name of names) {
    const piece = name.trim();
    if (piece.length === 0) continue;
    const next = parts.length === 0 ? piece : `${parts.join(', ')}, ${piece}`;
    if (next.length > GROUP_TITLE_MAX) break;
    parts.push(piece);
  }
  if (parts.length > 0) return parts.join(', ');
  const first = names.map((name) => name.trim()).find((name) => name.length > 0);
  return first === undefined ? '' : first.slice(0, GROUP_TITLE_MAX);
}
