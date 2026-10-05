import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Recursive size of a directory tree (P13 任务 6 诊断页「磁盘占用」).
 * Symlinks are not followed (a data-directory symlink must not pull an
 * arbitrary outside tree into the number); missing roots count as 0 bytes.
 * ENTRY_BUDGET bounds the walk: a run-away workspace could hold millions of
 * files and the diagnostics refresh must stay responsive — the result is a
 * lower bound in that case, flagged via `truncated`.
 */
export const DISK_WALK_ENTRY_BUDGET = 200_000;

export interface DiskUsage {
  bytes: number;
  files: number;
  truncated: boolean;
}

export function directoryUsage(root: string, budget = DISK_WALK_ENTRY_BUDGET): DiskUsage {
  let bytes = 0;
  let files = 0;
  let truncated = false;
  const stack: string[] = [root];
  while (stack.length > 0) {
    if (files >= budget) {
      truncated = true;
      break;
    }
    const current = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue; // vanished mid-walk / unreadable → contributes 0
    }
    for (const entry of entries) {
      if (files >= budget) {
        truncated = true;
        break;
      }
      files += 1;
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      try {
        bytes += statSync(full).size;
      } catch {
        // vanished mid-walk → contributes 0
      }
    }
  }
  return { bytes, files, truncated };
}

/** File size in bytes; 0 when the file does not exist (fresh database). */
export function fileSizeOrNull(filePath: string): number | undefined {
  try {
    return statSync(filePath).size;
  } catch {
    return undefined;
  }
}
