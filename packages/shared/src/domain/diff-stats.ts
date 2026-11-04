/**
 * 文件改动的行数统计（任务详情页工具行「Edited x.ts +9 −1」）：
 * 按行做 LCS，返回新增 / 删除行数。edit 工具参数与外部智能体的 ACP diff
 * 内容都用它，保证两套引擎在界面上口径一致。
 */

export interface DiffStats {
  added: number;
  removed: number;
}

/** Plain line count (a trailing newline does not add an empty line). */
export function countLines(text: string): number {
  return toLines(text).length;
}

/** Added / removed lines between two texts. */
export function lineDiffCounts(oldText: string, newText: string): DiffStats {
  const before = toLines(oldText);
  const after = toLines(newText);
  if (before.length === 0) return { added: after.length, removed: 0 };
  if (after.length === 0) return { added: 0, removed: before.length };
  // Edit blocks are small; refuse to allocate for pathological inputs.
  if (before.length * after.length > 1_000_000) {
    return { added: after.length, removed: before.length };
  }

  let prev = new Uint32Array(after.length + 1);
  let curr = new Uint32Array(after.length + 1);
  for (let i = 1; i <= before.length; i += 1) {
    const line = before[i - 1];
    for (let j = 1; j <= after.length; j += 1) {
      curr[j] = line === after[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, curr[j - 1]!);
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  const common = prev[after.length]!;
  return { added: after.length - common, removed: before.length - common };
}

/**
 * Summed diff stats of an edit tool's `edits[]` argument
 * (`{ oldText, newText }` entries). Returns null when there is nothing usable.
 */
export function diffStatsOfEdits(edits: unknown): DiffStats | null {
  if (!Array.isArray(edits) || edits.length === 0) return null;
  let added = 0;
  let removed = 0;
  for (const raw of edits) {
    if (raw === null || typeof raw !== 'object') continue;
    const record = raw as { oldText?: unknown; newText?: unknown };
    const oldText = typeof record.oldText === 'string' ? record.oldText : '';
    const newText = typeof record.newText === 'string' ? record.newText : '';
    const stats = lineDiffCounts(oldText, newText);
    added += stats.added;
    removed += stats.removed;
  }
  return { added, removed };
}

function toLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}
