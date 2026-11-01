/** Escape literal text for RegExp construction. */
// KepCup 垫片（orca src/shared/string-utils.ts 原样复制）。
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
