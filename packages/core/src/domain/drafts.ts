import { AppError, newId, type Attachment, type Draft } from '@kepcup/shared';
import type { SqliteDatabase } from '../infra/db.js';
import type { Clock } from '../infra/clock.js';

interface DraftRow {
  id: string;
  conversation_id: string;
  position: number;
  text: string;
  mentions_json: string;
  reply_to: string | null;
  created_at: number;
  updated_at: number;
}

interface AttachmentRow {
  id: string;
  conversation_id: string;
  message_id: string | null;
  draft_id: string | null;
  file_name: string;
  mime: string;
  size: number;
  sha256: string;
  rel_path: string;
  created_at: number;
}

function attachmentRowToAttachment(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    draftId: row.draft_id,
    fileName: row.file_name,
    mime: row.mime,
    size: row.size,
    sha256: row.sha256,
    relPath: row.rel_path,
    createdAt: row.created_at,
  };
}

function rowToDraft(row: DraftRow, attachments: Attachment[]): Draft {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    position: row.position,
    text: row.text,
    mentions: JSON.parse(row.mentions_json) as string[],
    replyTo: row.reply_to,
    attachments,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The per-conversation outgoing queue (docs/design/01-conversation.md). */
export class DraftsService {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock,
  ) {}

  list(conversationId: string): Draft[] {
    const rows = this.db
      .prepare('select * from drafts where conversation_id = ? order by position')
      .all(conversationId) as DraftRow[];
    return rows.map((row) => rowToDraft(row, this.attachmentsForDraft(row.id)));
  }

  add(
    conversationId: string,
    text: string,
    options: {
      mentions?: string[];
      replyTo?: string | null;
      /** 已上传的附件 id：校验归属后预挂到本草稿（docs/design/20-conversation-media.md）。 */
      attachmentIds?: string[];
    } = {},
  ): Draft {
    const now = this.clock.now();
    const id = newId('drf');
    const row = this.db
      .prepare('select coalesce(max(position), -1) + 1 as p from drafts where conversation_id = ?')
      .get(conversationId) as { p: number };
    const insert = this.db.transaction(() => {
      this.db
        .prepare(
          'insert into drafts (id, conversation_id, position, text, mentions_json, reply_to, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          id,
          conversationId,
          row.p,
          text,
          JSON.stringify(options.mentions ?? []),
          options.replyTo ?? null,
          now,
          now,
        );
      for (const attachmentId of options.attachmentIds ?? []) {
        this.#bindAttachment(attachmentId, id, conversationId);
      }
    });
    insert.immediate();
    return this.getOrThrow(id);
  }

  /** 预挂一个附件：必须属于本对话且仍是无主的上传（未挂消息、未挂其他草稿）。 */
  #bindAttachment(attachmentId: string, draftId: string, conversationId: string): void {
    const row = this.db.prepare('select * from attachments where id = ?').get(attachmentId) as
      AttachmentRow | undefined;
    if (!row || row.conversation_id !== conversationId) {
      throw new AppError('INVALID_INPUT', `附件 ${attachmentId} 不存在或不属于当前对话`);
    }
    if (row.message_id !== null || row.draft_id !== null) {
      throw new AppError('INVALID_INPUT', `附件 ${attachmentId} 已被占用`);
    }
    this.db.prepare('update attachments set draft_id = ? where id = ?').run(draftId, attachmentId);
  }

  update(id: string, text: string): Draft {
    const existing = this.getOrThrow(id);
    this.db
      .prepare('update drafts set text = ?, updated_at = ? where id = ?')
      .run(text, this.clock.now(), existing.id);
    return this.getOrThrow(id);
  }

  /** Reorders by the given id sequence; unknown ids throw. */
  reorder(conversationId: string, ids: string[]): Draft[] {
    const current = this.list(conversationId);
    const known = new Set(current.map((d) => d.id));
    if (ids.length !== current.length || !ids.every((id) => known.has(id))) {
      throw new AppError('INVALID_INPUT', 'Reorder list must match the queue exactly');
    }
    const run = this.db.transaction(() => {
      ids.forEach((id, index) => {
        this.db
          .prepare('update drafts set position = ?, updated_at = ? where id = ?')
          .run(index, this.clock.now(), id);
      });
    });
    run.immediate();
    return this.list(conversationId);
  }

  remove(id: string): void {
    const existing = this.getOrThrow(id);
    this.db.prepare('delete from drafts where id = ?').run(existing.id);
  }

  removeAll(conversationId: string): void {
    this.db.prepare('delete from drafts where conversation_id = ?').run(conversationId);
  }

  getOrThrow(id: string): Draft {
    const row = this.db.prepare('select * from drafts where id = ?').get(id) as
      DraftRow | undefined;
    if (!row) throw new AppError('NOT_FOUND', `Draft ${id} does not exist`);
    return rowToDraft(row, this.attachmentsForDraft(row.id));
  }

  attachmentsForDraft(draftId: string): Attachment[] {
    const rows = this.db
      .prepare('select * from attachments where draft_id = ? order by created_at')
      .all(draftId) as AttachmentRow[];
    return rows.map(attachmentRowToAttachment);
  }

  /** Rows joined with their attachments (draft_id link), for flush. */
  attachmentIdsForDraft(draftId: string): string[] {
    const rows = this.db
      .prepare('select id from attachments where draft_id = ?')
      .all(draftId) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }
}
