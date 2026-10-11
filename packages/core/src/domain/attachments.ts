import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { AppError, newId, type Attachment } from '@kepcup/shared';
import type { AppPaths } from '../infra/paths.js';
import type { SqliteDatabase } from '../infra/db.js';
import type { Clock } from '../infra/clock.js';

const MAX_ATTACHMENT_BYTES = 30_000_000;

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
