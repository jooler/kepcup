import { chmodSync, lstatSync, readdirSync, rmSync as nodeRmSync, type RmOptions } from 'node:fs';
import path from 'node:path';

/**
 * `fs.rmSync` that also removes trees holding read-only entries on Windows.
 *
 * Node's native recursive remove fails with EPERM on a file that has the
 * read-only attribute (what `chmod 0o444` becomes there): the skill library
 * seals its files that way, and libgit2 writes object files read-only. On the
 * first such failure the tree is made writable and the remove retried, with a
 * few delays for handles that are still closing. Other platforms call straight
 * through.
 */
export function rmSync(target: string, options: RmOptions = {}): void {
  if (process.platform !== 'win32') {
    nodeRmSync(target, options);
    return;
  }
  try {
    nodeRmSync(target, options);
    return;
  } catch (error) {
    if (!isRetryable(error)) throw error;
  }
  makeWritable(target);
  // 只读属性之外，Windows 上关闭中的句柄（sqlite/leveldb 收尾）也会短暂
  // EBUSY：native 的内部重试拉长到 ~6s，把删除级联从竞态里解放出来。
  nodeRmSync(target, { maxRetries: 24, retryDelay: 250, ...options });
}

function isRetryable(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY' || code === 'ENOTEMPTY';
}

export function makeWritable(entry: string): void {
  let stat;
  try {
    stat = lstatSync(entry);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) return;
  try {
    chmodSync(entry, 0o666);
  } catch {
    // Best effort: the remove below reports what is really in the way.
  }
  if (!stat.isDirectory()) return;
  let names: string[];
  try {
    names = readdirSync(entry);
  } catch {
    return;
  }
  for (const name of names) makeWritable(path.join(entry, name));
}
