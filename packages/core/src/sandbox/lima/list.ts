import { LIMA_VM_NAME } from './constants.js';

export interface LimaListEntry {
  name?: string;
  status?: string;
  running?: boolean;
}

/**
 * `limactl list --json` 的两种真实输出形态：JSONL（每行一个对象）与 JSON
 * 数组。解析失败的行直接忽略（Lima 偶尔在 stdout 混入警告）。
 */
export function parseLimaList(stdout: string): LimaListEntry[] {
  const text = stdout.trim();
  if (text.length === 0) return [];
  if (text.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (entry): entry is LimaListEntry => entry !== null && typeof entry === 'object',
        );
      }
    } catch {
      // 落到逐行解析。
    }
  }
  const entries: LimaListEntry[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === 'object') entries.push(parsed as LimaListEntry);
    } catch {
      // 非 JSON 行（警告/进度）忽略。
    }
  }
  return entries;
}

/** Instance state of our VM within a `limactl list` result. */
export function limaInstanceState(entries: readonly LimaListEntry[]): 'missing' | 'stopped' | 'running' {
  const vm = entries.find((entry) => entry.name === LIMA_VM_NAME);
  if (vm === undefined) return 'missing';
  return vm.running === true || vm.status === 'Running' ? 'running' : 'stopped';
}
