import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  SHARE_MAX_FILES,
  SHARE_MAX_FILE_BYTES,
  SHARE_MAX_TOTAL_BYTES,
  isShareIntakeId,
  shareManifestSchema,
  type ShareManifest,
} from '@kepcup/shared';

/**
 * D94 §5.1：扩展写在 App Group inbox 里的批次目录。
 *
 *   {intakeId}/
 *     manifest.json   目标、附言、文件清单（大小 + sha256）
 *     ready           完成标记（最后写）
 *     files/          000-chat.zip …
 *
 * 主进程只消费带 `ready` 的完整目录；目录名必须与 manifest 里的 id 一致
 * （防路径注入）。
 */

export interface StagedFile {
  /** 批次目录内的绝对路径。 */
  path: string;
  originalName: string;
  mime: string;
  size: number;
  sha256: string;
}

export interface StagedIntake {
  intakeId: string;
  dir: string;
  manifest: ShareManifest;
  files: StagedFile[];
}

export type StagedIntakeError =
  | 'not_ready'
  | 'bad_intake_id'
  | 'missing_manifest'
  | 'manifest_invalid'
  | 'id_mismatch'
  | 'files_missing'
  | 'file_invalid'
  | 'too_many_files'
  | 'file_too_large'
  | 'total_too_large'
  | 'hash_mismatch';

/** 读取并校验一个批次目录；不合法时给出原因（调用方只跳过、不删）。 */
export function readStagedIntake(dir: string): StagedIntake | { error: StagedIntakeError } {
  const intakeId = path.basename(dir);
  if (!isShareIntakeId(intakeId)) return { error: 'bad_intake_id' };
  // ready 是完成标记：没有它说明扩展还没写完。
  if (!existsSync(path.join(dir, 'ready'))) return { error: 'not_ready' };
  const manifestPath = path.join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) return { error: 'missing_manifest' };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return { error: 'manifest_invalid' };
  }
  const parsed = shareManifestSchema.safeParse(raw);
  if (!parsed.success) return { error: 'manifest_invalid' };
  const manifest = parsed.data;
  if (manifest.intakeId !== intakeId) return { error: 'id_mismatch' };
  if (manifest.files.length > SHARE_MAX_FILES) return { error: 'too_many_files' };

  const files: StagedFile[] = [];
  let total = 0;
  for (const file of manifest.files) {
    // stagedName 只作批次目录内的相对名；含分隔符或 .. 的直接拒绝。
    if (file.stagedName !== path.basename(file.stagedName) || file.stagedName.includes('..')) {
      return { error: 'file_invalid' };
    }
    const filePath = path.join(dir, 'files', file.stagedName);
    let stat;
    try {
      const link = lstatSync(filePath);
      if (link.isSymbolicLink() || !link.isFile()) return { error: 'file_invalid' };
      stat = statSync(filePath);
    } catch {
      return { error: 'files_missing' };
    }
    if (stat.size !== file.size) return { error: 'file_invalid' };
    if (stat.size > SHARE_MAX_FILE_BYTES) return { error: 'file_too_large' };
    total += stat.size;
    if (total > SHARE_MAX_TOTAL_BYTES) return { error: 'total_too_large' };
    // stat 与 read 之间文件可能被删 / 权限变化：读不出来按 files_missing 归类，
    // 不让单个坏批次把整轮 scan 炸掉（unhandled rejection）。
    let bytes: Buffer;
    try {
      bytes = readFileSync(filePath);
    } catch {
      return { error: 'files_missing' };
    }
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== file.sha256.toLowerCase()) return { error: 'hash_mismatch' };
    files.push({
      path: filePath,
      originalName: file.originalName,
      mime: file.mime,
      size: file.size,
      sha256: file.sha256,
    });
  }
  return { intakeId, dir, manifest, files };
}

/** 列出 App Group inbox 里「带 ready」的批次目录。 */
export function listReadyIntakes(inboxDir: string): string[] {
  return listIntakeDirs(inboxDir).filter(
    (name) => isShareIntakeId(name) && existsSync(path.join(inboxDir, name, 'ready')),
  );
}

/** 列出 inbox 里全部批次目录（含未写完 / 未通过校验的）——TTL 清理用（§6.7）。 */
export function listIntakeDirs(inboxDir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(inboxDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  return entries.sort();
}
