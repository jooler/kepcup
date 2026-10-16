import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { rmSync } from '../infra/fs-rm.js';
import path from 'node:path';
import { AppError, newId, type Attachment } from '@kepcup/shared';
import type { AppPaths } from '../infra/paths.js';
import type { SqliteDatabase } from '../infra/db.js';
import type { Clock } from '../infra/clock.js';

/** Per-attachment byte ceiling (upload rejects larger payloads). */
export const MAX_ATTACHMENT_BYTES = 30_000_000;

/**
 * 未绑定（message_id 为空）附件的存活期。上传后到随消息发出之间的 chip 可跨重启
 * 留在输入框草稿里，所以不能立刻回收；超过该期限仍没发出的视为被遗弃
 * （关闭应用、卸载草稿缓存、D86 前遗留的队列附件等），行与文件一起回收。
 */
export const UNBOUND_ATTACHMENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 磁盘上「没有任何行引用」的文件至少放过这么久才删（避开写文件与插行之间的窗口）。 */
export const ORPHAN_FILE_GRACE_MS = 24 * 60 * 60 * 1000;

export interface AttachmentSweepResult {
  /** 回收的过期未绑定附件行数。 */
  expiredRows: number;
  /** 删除的、不再被任何行引用的文件数。 */
  orphanFiles: number;
  /** 上述两类回收的字节数（行的 size + 孤儿文件大小）。 */
  freedBytes: number;
}

export interface AttachmentStatusEntry {
  id: string;
  state: 'pending' | 'sent' | 'missing';
}

interface AttachmentRow {
  id: string;
  conversation_id: string;
  message_id: string | null;
  file_name: string;
  mime: string;
  size: number;
  sha256: string;
  rel_path: string;
  created_at: number;
}

function rowToAttachment(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    fileName: row.file_name,
    mime: row.mime,
    size: row.size,
    sha256: row.sha256,
    relPath: row.rel_path,
    createdAt: row.created_at,
  };
}

/**
 * Conversation-scoped attachments stored under
 * `{home}/conversations/{conversationId}/attachments/`.
 */
export class AttachmentsService {
  readonly #db: SqliteDatabase;
  readonly #paths: AppPaths;
  readonly #clock: Clock;

  constructor(deps: { db: SqliteDatabase; paths: AppPaths; clock: Clock }) {
    this.#db = deps.db;
    this.#paths = deps.paths;
    this.#clock = deps.clock;
  }

  #conversationDir(conversationId: string): string {
    return path.join(this.#paths.home, 'conversations', conversationId, 'attachments');
  }

  absolutePath(attachment: Attachment): string {
    return path.join(
      this.#paths.home,
      'conversations',
      attachment.conversationId,
      'attachments',
      attachment.relPath,
    );
  }

  upload(input: {
    conversationId: string;
    fileName: string;
    mime: string;
    bytes: Buffer;
  }): Attachment {
    if (input.bytes.length === 0) {
      throw new AppError('INVALID_INPUT', 'Attachment is empty');
    }
    if (input.bytes.length > MAX_ATTACHMENT_BYTES) {
      throw new AppError('INVALID_INPUT', 'Attachment exceeds the size limit');
    }
    const id = newId('att');
    const now = this.#clock.now();
    const safeName = path.basename(input.fileName).replace(/[^\p{L}\p{N}._-]+/gu, '_');
    const relPath = `${id}_${safeName}`;
    const dir = this.#conversationDir(input.conversationId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, relPath), input.bytes, { mode: 0o600 });

    this.#db
      .prepare(
        'insert into attachments (id, conversation_id, message_id, file_name, mime, size, sha256, rel_path, created_at) values (?, ?, NULL, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        input.conversationId,
        safeName,
        input.mime,
        input.bytes.length,
        createHash('sha256').update(input.bytes).digest('hex'),
        relPath,
        now,
      );
    return this.getOrThrow(id);
  }

  get(id: string): Attachment | null {
    const row = this.#db.prepare('select * from attachments where id = ?').get(id) as
      AttachmentRow | undefined;
    return row ? rowToAttachment(row) : null;
  }

  /**
   * 批量存在性查询（输入框草稿水合 / 发送失败后判因用，一次往返，不读字节）：
   * - `pending`：属于该对话、尚未随消息发出、文件仍在——chip 可继续使用；
   * - `sent`：已绑定消息（多半是上一次发送 core 已受理而响应丢失）；
   * - `missing`：行不存在 / 不属于该对话 / 文件已被清理（过期回收、手动删除）。
   */
  statusOf(ids: readonly string[], conversationId: string): AttachmentStatusEntry[] {
    const select = this.#db.prepare('select * from attachments where id = ?');
    return ids.map((id) => {
      const row = select.get(id) as AttachmentRow | undefined;
      if (!row || row.conversation_id !== conversationId) {
        return { id, state: 'missing' as const };
      }
      if (row.message_id !== null) return { id, state: 'sent' as const };
      try {
        statSync(this.absolutePath(rowToAttachment(row)));
      } catch {
        return { id, state: 'missing' as const };
      }
      return { id, state: 'pending' as const };
    });
  }

  getOrThrow(id: string): Attachment {
    const att = this.get(id);
    if (!att) throw new AppError('NOT_FOUND', `Attachment ${id} does not exist`);
    return att;
  }

  readBytes(attachment: Attachment): Buffer {
    return readFileSync(this.absolutePath(attachment));
  }

  /** Re-links bot-generated attachments to the message they belong to. */
  attachToMessage(attachmentIds: string[], messageId: string): void {
    const run = this.#db.transaction(() => {
      for (const id of attachmentIds) {
        this.#db.prepare('update attachments set message_id = ? where id = ?').run(messageId, id);
      }
    });
    run.immediate();
  }

  /**
   * 校验附件归属并把无主的上传挂到随发消息上（messages.send 直发，
   * docs/design/20-conversation-media.md）：必须属于本对话且尚未挂消息。
   * 在调用方的事务内执行（与消息落库同事务）。
   */
  claimForMessage(attachmentIds: string[], conversationId: string, messageId: string): void {
    for (const id of attachmentIds) {
      const row = this.#db.prepare('select * from attachments where id = ?').get(id) as
        AttachmentRow | undefined;
      if (!row || row.conversation_id !== conversationId) {
        throw new AppError('INVALID_INPUT', `附件 ${id} 不存在或不属于当前对话`);
      }
      if (row.message_id !== null) {
        throw new AppError('INVALID_INPUT', `附件 ${id} 已被占用`);
      }
      this.#db.prepare('update attachments set message_id = ? where id = ?').run(messageId, id);
    }
  }

  /**
   * 移除未发送的附件（上传后尚未随消息发出的 chip）：行与文件一起删。
   * 已随消息发出的附件（message_id 非空）不可移除——消息内容属对话历史。
   */
  detach(id: string): void {
    const attachment = this.getOrThrow(id);
    if (attachment.messageId !== null) {
      throw new AppError('INVALID_INPUT', '附件已随消息发出，不能移除');
    }
    const run = this.#db.transaction(() => {
      this.#db.prepare('delete from attachments where id = ?').run(id);
    });
    run.immediate();
    this.#deleteFile(attachment);
  }

  /**
   * 孤儿附件回收（启动时调用，best-effort）。保守两步，且都只碰「确定没人用」的：
   * 1. 删除 message_id 为空且创建超过 UNBOUND_ATTACHMENT_TTL_MS 的行及其文件——
   *    未过期的正常上传（输入框里的 chip）不动；已绑定消息的附件永远不动。
   * 2. 扫描 `conversations/<id>/attachments/` 下的普通文件，删除没有任何 attachments
   *    行引用、且 mtime 早于 ORPHAN_FILE_GRACE_MS 的文件（崩溃遗留、步骤 1 删行后
   *    的残余、已删会话的残留）。不跟随符号链接，不删目录。
   */
  sweepOrphans(): AttachmentSweepResult {
    const now = this.#clock.now();
    const result: AttachmentSweepResult = { expiredRows: 0, orphanFiles: 0, freedBytes: 0 };

    const expired = this.#db
      .prepare(
        'select * from attachments where message_id is null and created_at < ? order by created_at',
      )
      .all(now - UNBOUND_ATTACHMENT_TTL_MS) as AttachmentRow[];
    if (expired.length > 0) {
      const run = this.#db.transaction(() => {
        for (const row of expired) {
          // 再次带上 message_id is null：并发的 claim 把它绑走则不删。
          const info = this.#db
            .prepare('delete from attachments where id = ? and message_id is null')
            .run(row.id);
          if (info.changes === 0) continue;
          result.expiredRows += 1;
          result.freedBytes += row.size;
          this.#deleteFile(rowToAttachment(row));
        }
      });
      run.immediate();
    }

    const conversationsRoot = path.join(this.#paths.home, 'conversations');
    let conversationDirs: string[];
    try {
      conversationDirs = readdirSync(conversationsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return result;
    }
    const referenced = this.#db.prepare(
      'select rel_path from attachments where conversation_id = ?',
    );
    for (const conversationId of conversationDirs) {
      const dir = this.#conversationDir(conversationId);
      let files: string[];
      try {
        files = readdirSync(dir, { withFileTypes: true })
          .filter((entry) => entry.isFile())
          .map((entry) => entry.name);
      } catch {
        continue;
      }
      if (files.length === 0) continue;
      const known = new Set(
        (referenced.all(conversationId) as Array<{ rel_path: string }>).map((row) => row.rel_path),
      );
      for (const name of files) {
        if (known.has(name)) continue;
        const target = path.join(dir, name);
        try {
          const stat = statSync(target);
          if (now - stat.mtimeMs < ORPHAN_FILE_GRACE_MS) continue;
          rmSync(target, { force: true });
          result.orphanFiles += 1;
          result.freedBytes += stat.size;
        } catch {
          // 单个文件删不了不影响其余。
        }
      }
    }
    return result;
  }

  #deleteFile(attachment: Attachment): void {
    try {
      rmSync(this.absolutePath(attachment), { force: true });
    } catch {
      // 文件缺失不阻塞行删除（目录被手动清理等）。
    }
  }

  /** Removes the conversation's attachment storage directory (row deletion
   * happens through the messages/conversations cascade). */
  deleteConversationFiles(conversationId: string): void {
    rmSync(path.join(this.#paths.home, 'conversations', conversationId), {
      recursive: true,
      force: true,
    });
  }
}
