import {
  AppError,
  CONVERSATION_NOTE_TEXT_MAX_CHARS,
  newId,
  type ConversationNote,
} from '@kepcup/shared';
import type { SqliteDatabase } from '../infra/db.js';
import type { Clock } from '../infra/clock.js';

interface ConversationNoteRow {
  id: string;
  conversation_id: string;
  text: string;
  created_at: number;
  updated_at: number;
}

function rowToNote(row: ConversationNoteRow): ConversationNote {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    text: row.text,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 对话便签（docs/dev/03-data-model.md「conversation_notes」）：用户在右栏
 * 「便签」tab 手动记录的信息。纯用户数据，不参与 Bot 上下文；删除对话时
 * 随 conversations 行 FK 级联删除，无需额外生命周期钩子。
 */
export class ConversationNotesService {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock,
  ) {}

  list(conversationId: string): ConversationNote[] {
    const rows = this.db
      .prepare('select * from conversation_notes where conversation_id = ? order by created_at, id')
      .all(conversationId) as ConversationNoteRow[];
    return rows.map(rowToNote);
  }

  create(input: { id?: string; conversationId: string; text: string }): ConversationNote {
    const text = assertText(input.text);
    const now = this.clock.now();
    const id = input.id ?? newId('note');
    this.db
      .prepare(
        `insert into conversation_notes (id, conversation_id, text, created_at, updated_at)
         values (?, ?, ?, ?, ?)`,
      )
      .run(id, input.conversationId, text, now, now);
    return this.getOrThrow(id);
  }

  update(id: string, text: string): ConversationNote {
    this.getOrThrow(id);
    this.db
      .prepare('update conversation_notes set text = ?, updated_at = ? where id = ?')
      .run(assertText(text), this.clock.now(), id);
    return this.getOrThrow(id);
  }

  remove(id: string): void {
    this.db.prepare('delete from conversation_notes where id = ?').run(id);
  }

  getOrThrow(id: string): ConversationNote {
    const row = this.db.prepare('select * from conversation_notes where id = ?').get(id) as
      ConversationNoteRow | undefined;
    if (row === undefined) {
      throw new AppError('NOT_FOUND', '该便签不存在或已被删除');
    }
    return rowToNote(row);
  }
}

/** 便签正文不能为空（纯空白等同于清空），长度上限与 RPC 校验一致。 */
function assertText(text: string): string {
  if (text.trim().length === 0) {
    throw new AppError('INVALID_INPUT', '便签内容不能为空');
  }
  if (text.length > CONVERSATION_NOTE_TEXT_MAX_CHARS) {
    throw new AppError(
      'INVALID_INPUT',
      `便签内容不能超过 ${CONVERSATION_NOTE_TEXT_MAX_CHARS} 个字符`,
    );
  }
  return text;
}
