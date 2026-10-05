import { AppError, newId, type Conversation } from '@kepcup/shared';
import type { SqliteDatabase } from '../infra/db.js';
import type { Clock } from '../infra/clock.js';

/** conversations.setup_state 的唯一取值：群创建问答进行中（design/19 D60）。 */
export const CONVERSATION_SETUP_CREATING = 'creating';

interface ConversationRow {
  id: string;
  type: 'direct' | 'group';
  title: string | null;
  description: string | null;
  direct_bot_id: string | null;
  project_id: string | null;
  read_only: 0 | 1;
  setup_state: string | null;
  summary: string | null;
  summary_upto_seq: number;
  last_seq: number;
  last_read_seq: number;
  last_message_at: number | null;
  created_at: number;
}

export function conversationRowToConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    ...(row.description !== null ? { description: row.description } : {}),
    directBotId: row.direct_bot_id,
    projectId: row.project_id,
    readOnly: row.read_only === 1,
    ...(row.setup_state === CONVERSATION_SETUP_CREATING
      ? { setupState: CONVERSATION_SETUP_CREATING }
      : {}),
    summary: row.summary,
    summaryUptoSeq: row.summary_upto_seq,
    lastSeq: row.last_seq,
    lastReadSeq: row.last_read_seq,
    lastMessageAt: row.last_message_at,
    createdAt: row.created_at,
  };
}

export class ConversationsService {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock,
  ) {}

  get(id: string): Conversation | null {
    const row = this.db.prepare('select * from conversations where id = ?').get(id) as
      ConversationRow | undefined;
    return row ? conversationRowToConversation(row) : null;
  }

  getOrThrow(id: string): Conversation {
    const conv = this.get(id);
    if (!conv) throw new AppError('NOT_FOUND', `Conversation ${id} does not exist`);
    return conv;
  }

  list(): Conversation[] {
    const rows = this.db
      .prepare('select * from conversations order by coalesce(last_message_at, created_at) desc')
      .all() as ConversationRow[];
    return rows.map(conversationRowToConversation);
  }

  /**
   * Opens the single conversation with a bot, creating it (plus the member
   * row) when missing. Read-only past conversations are never reopened — a
   * deleted bot's chat stays closed and a new bot instance gets a new id.
   */
  openDirect(botId: string): { conversation: Conversation; created: boolean } {
    const existing = this.db
      .prepare(
        "select * from conversations where type = 'direct' and direct_bot_id = ? and read_only = 0",
      )
      .get(botId) as ConversationRow | undefined;
    if (existing) return { conversation: conversationRowToConversation(existing), created: false };

    const id = newId('conv');
    const now = this.clock.now();
    const run = this.db.transaction(() => {
      this.db
        .prepare(
          'insert into conversations (id, type, direct_bot_id, created_at) values (?, ?, ?, ?)',
        )
        .run(id, 'direct', botId, now);
      this.db
        .prepare(
          'insert into conversation_members (conversation_id, bot_id, joined_at) values (?, ?, ?)',
        )
        .run(id, botId, now);
    });
    run.immediate();
    return { conversation: this.getOrThrow(id), created: true };
  }

  markRead(conversationId: string, seq: number): void {
    this.db
      .prepare('update conversations set last_read_seq = max(last_read_seq, ?) where id = ?')
      .run(seq, conversationId);
  }

  setReadOnly(conversationId: string, readOnly: boolean): void {
    this.db
      .prepare('update conversations set read_only = ? where id = ?')
      .run(readOnly ? 1 : 0, conversationId);
  }

  /** Binds or unbinds the conversation's project (P04; null clears). */
  setProject(conversationId: string, projectId: string | null): void {
    this.db
      .prepare('update conversations set project_id = ? where id = ?')
      .run(projectId, conversationId);
  }

  /** Marks (or clears) the conversational creation flow state (design/19 D60). */
  setSetupState(conversationId: string, state: 'creating' | null): void {
    this.db
      .prepare('update conversations set setup_state = ? where id = ?')
      .run(state, conversationId);
  }

  /** Direct conversations of a bot (read-only ones included). */
  listDirectByBot(botId: string): Conversation[] {
    const rows = this.db
      .prepare("select * from conversations where type = 'direct' and direct_bot_id = ?")
      .all(botId) as ConversationRow[];
    return rows.map(conversationRowToConversation);
  }

  /** Member bot ids of a conversation. */
  memberBotIds(conversationId: string): string[] {
    const rows = this.db
      .prepare('select bot_id from conversation_members where conversation_id = ?')
      .all(conversationId) as Array<{ bot_id: string }>;
    return rows.map((r) => r.bot_id);
  }

  /** Internal: bump last_message_at (called by the messages service). */
  touchLastMessage(conversationId: string, at: number): void {
    this.db
      .prepare(
        'update conversations set last_message_at = max(coalesce(last_message_at, 0), ?) where id = ?',
      )
      .run(at, conversationId);
  }
}
