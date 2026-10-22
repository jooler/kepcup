import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { AppError, type Attachment } from '@kepcup/shared';
import type { AttachmentsService } from '../domain/attachments.js';

/**
 * 分享附件的 workspace 副本（D94 §5.7）。
 *
 * 给模型的不是附件库路径（不在 Bot 沙盒可读范围），也不是原始分享源路径
 * （安全作用域临时文件、随时可能被删）。这里是宿主在 Bot 的 workspace 里
 * 物化的一份只读副本：`{workspace}/.attachments/{attachmentId}_{safeName}`。
 *
 * 同一 Bot 多轮复用同一份；副本被改写（size / mtime 变了）就重建并恢复原始
 * 字节。首次物化算一次 SHA256 写 sidecar，之后不重算 30MB。
 */

/** workspace 副本的宿主目录（与 get_attachment 的落点一致）。 */
export const SHARE_ATTACHMENT_DIR = '.attachments';

/** 副本的只读权限（宿主语义：Bot 要改先自己复制走）。 */
const COPY_FILE_MODE = 0o444;

export interface ShareAttachmentCopy {
  /** workspace 副本的绝对路径。 */
  path: string;
  /** 是否复用了已有副本（false = 本次重建）。 */
  reused: boolean;
}

interface CopySidecar {
  attachmentId: string;
  size: number;
  mtimeMs: number;
  sha256: string;
}

/** 文件名清洗：basename + 去掉路径分隔符与控制字符（与附件库落盘一致）。 */
export function safeAttachmentFileName(fileName: string): string {
  const base = path.basename(fileName);
  const cleaned = base.replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^\.+/u, '');
  return cleaned.length > 0 ? cleaned : 'file';
}

/** workspace 副本的目标路径（不含 sidecar）。 */
export function shareAttachmentCopyPath(workspacePath: string, attachment: Attachment): string {
  return path.join(
    workspacePath,
    SHARE_ATTACHMENT_DIR,
    `${attachment.id}_${safeAttachmentFileName(attachment.fileName)}`,
  );
}

/**
 * 物化（或复用）一个附件的 workspace 副本。
 *
 * 幂等且自愈：副本存在、sidecar 与附件行一致、size / mtime 未变 → 直接复用；
 * 否则从附件库重建（临时文件 + rename 原子替换，不跟随符号链接）。
 */
export function ensureShareAttachmentCopy(input: {
  attachments: AttachmentsService;
  /** 当前查看 Bot 在该对话下的 workspace 目录。 */
  workspacePath: string;
  attachment: Attachment;
}): ShareAttachmentCopy {
  const { attachments, workspacePath, attachment } = input;
  const dir = path.join(workspacePath, SHARE_ATTACHMENT_DIR);
  const target = shareAttachmentCopyPath(workspacePath, attachment);
  const sidecarPath = `${target}.meta.json`;

  const existing = inspectCopy(target, sidecarPath, attachment);
  if (existing !== null) {
    try {
      chmodSync(target, COPY_FILE_MODE);
    } catch {
      // 权限修不了不影响读取。
    }
    return { path: target, reused: true };
  }

  const bytes = attachments.readBytes(attachment);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const expected = typeof attachment.sha256 === 'string' ? attachment.sha256 : '';
  if (expected.length > 0 && digest !== expected) {
    throw new AppError(
      'SHARE_MATERIALIZE_FAILED',
      `附件 ${attachment.id} 的内容与记录的 sha256 不符`,
    );
  }

  mkdirSync(dir, { recursive: true });
  // 先删旧副本（可能是符号链接或被改写的半成品），再用临时文件 + rename
  // 原子替换——读方不会看到半截文件。
  try {
    rmSync(target, { force: true });
  } catch {
    // 旧副本删不掉就直接失败（不覆盖未知内容）。
  }
  rmSync(sidecarPath, { force: true });
  const temp = `${target}.tmp-${process.pid}`;
  try {
    writeFileSync(temp, bytes, { mode: COPY_FILE_MODE });
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw new AppError(
      'SHARE_MATERIALIZE_FAILED',
      `附件 ${attachment.id} 的 workspace 副本写入失败`,
      { reason: error instanceof Error ? error.message : String(error) },
    );
  }
  const stat = statSync(target);
  const sidecar: CopySidecar = {
    attachmentId: attachment.id,
    size: attachment.size,
    mtimeMs: stat.mtimeMs,
    sha256: digest,
  };
  const tempSidecar = `${sidecarPath}.tmp-${process.pid}`;
  try {
    writeFileSync(tempSidecar, JSON.stringify(sidecar), { mode: 0o600 });
    renameSync(tempSidecar, sidecarPath);
  } catch {
    // sidecar 写不进去只是下次多重建一次副本。
    rmSync(tempSidecar, { force: true });
  }
  return { path: target, reused: false };
}

/**
 * 现有副本是否仍然可信：sidecar 在、归属与哈希对得上、文件的 size / mtime
 * 与 sidecar 记录一致（被改写就会变）。不一致返回 null（调用方重建）。
 */
function inspectCopy(
  target: string,
  sidecarPath: string,
  attachment: Attachment,
): CopySidecar | null {
  let sidecar: CopySidecar;
  try {
    sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8')) as CopySidecar;
  } catch {
    return null;
  }
  if (sidecar.attachmentId !== attachment.id) return null;
  const expected = typeof attachment.sha256 === 'string' ? attachment.sha256 : '';
  if (expected.length > 0 && sidecar.sha256 !== expected) return null;
  if (sidecar.size !== attachment.size) return null;
  let stat;
  try {
    const link = lstatSync(target);
    // 符号链接不是副本（不跟随）。
    if (link.isSymbolicLink()) return null;
    stat = statSync(target);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  if (stat.size !== sidecar.size) return null;
  if (stat.mtimeMs !== sidecar.mtimeMs) return null;
  return sidecar;
}
