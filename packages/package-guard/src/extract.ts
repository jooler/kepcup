import { chmod, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  resolveZipGuard,
  safeEntryPath,
  type ZipArchive,
  type ZipGuardOptions,
} from './zip.js';

/**
 * Safe shared extraction for the plugin pipeline and `kepcup-app validate/pack`:
 * entry names go through {@link safeEntryPath}, symlinks and case-folded duplicates are
 * rejected, the resolved target must stay inside `destDir`, and only the executable bit
 * of the archived mode is honoured (0o755 / 0o644).
 */

export interface ExtractResult {
  files: number;
  bytes: number;
}

export async function extractZip(
  archive: ZipArchive,
  destDir: string,
  options: ZipGuardOptions = {},
): Promise<ExtractResult> {
  const { error, limits } = resolveZipGuard(options);
  if (archive.entries.length > limits.maxEntries) {
    throw error(`包内条目过多（上限 ${limits.maxEntries}）`);
  }
  const declared = archive.entries.reduce((sum, entry) => sum + entry.size, 0);
  if (declared > limits.maxUnpackedBytes) throw error('包解压后体积超过上限');

  let exists = true;
  try {
    const info = await stat(destDir);
    if (!info.isDirectory()) throw error(`目标路径不是目录：${destDir}`);
    if ((await readdir(destDir)).length > 0) throw error(`目标目录不是空目录：${destDir}`);
  } catch (statError) {
    if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError;
    exists = false;
  }
  if (!exists) await mkdir(destDir, { recursive: true });

  const root = path.resolve(destDir);
  const seen = new Set<string>();
  let files = 0;
  let bytes = 0;
  let unpacked = 0;
  for (const entry of archive.entries) {
    const safe = safeEntryPath(entry.name, error);
    const key = safe.toLowerCase();
    if (seen.has(key)) throw error(`包内有重复路径：${entry.name}`);
    seen.add(key);
    if (entry.isSymlink) throw error(`包内含符号链接，已拒绝：${entry.name}`);
    const target = path.resolve(root, ...safe.split('/'));
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw error(`包内路径越界：${entry.name}`);
    }
    if (entry.isDirectory) {
      await mkdir(target, { recursive: true });
      continue;
    }
    if (entry.size > limits.maxEntryBytes) throw error(`包内文件过大：${entry.name}`);
    unpacked += entry.size;
    if (unpacked > limits.maxUnpackedBytes) throw error('包解压后体积超过上限');
    const data = await archive.read(entry);
    await mkdir(path.dirname(target), { recursive: true });
    const mode = (entry.unixMode & 0o111) !== 0 ? 0o755 : 0o644;
    await writeFile(target, data, { mode });
    await chmod(target, mode);
    files += 1;
    bytes += data.length;
  }
  return { files, bytes };
}
