import { AppError, newId, type Conversation, type ConversationType } from '@kepcup/shared';
import type { SqliteDatabase } from '../infra/db.js';
import type { Clock } from '../infra/clock.js';

interface ConversationRow {
  id: string;
  type: ConversationType;
  title: string | null;
  goal: string | null;
  direct_bot_id: string | null;
  lead_bot_id: string | null;
  workdir_id: string | null;
  read_only: 0 | 1;
  archived_at: number | null;
  summary: string | null;
  summary_upto_seq: number;
  last_seq: number;
  last_read_seq: number;
  last_message_at: number | null;
  created_at: number;
  parent_project_id: string | null;
  card_todo_id: string | null;
}

export function conversationRowToConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    ...(row.goal !== null ? { goal: row.goal } : {}),
    directBotId: row.direct_bot_id,
    leadBotId: row.lead_bot_id,
    parentProjectId: row.parent_project_id,
    cardTodoId: row.card_todo_id,
    workdirId: row.workdir_id,
    readOnly: row.read_only === 1,
    archivedAt: row.archived_at ?? null,
    summary: row.summary,
    summaryUptoSeq: row.summary_upto_seq,
    lastSeq: row.last_seq,
    lastReadSeq: row.last_read_seq,
    lastMessageAt: row.last_message_at,
    createdAt: row.created_at,
  };
}

export interface EnsureCardConversationInput {
  projectId: string;
  todoId: string;
  botId: string;
  title: string;
}

export interface EnsureCardConversationResult {
  conversation: Conversation;
  /** True when this call inserted the row. */
  created: boolean;
  /** Rows whose read-only bit or title changed, including a newly inserted row. */
  updated: Conversation[];
}

/** One of `todoId` / `botId` / `projectId` narrows the card-conversation query. */
export interface CardConversationFilter {
  todoId?: string;
  botId?: string;
  projectId?: string;
}

export interface ConversationsHooks {
  /**
   * Fired after a card-conversation write commits. Callers that already sit
   * inside a transaction publish the returned rows themselves.
   */
  onUpdated?: ((conversation: Conversation) => void) | undefined;
}

export class ConversationsService {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock,
    private readonly hooks?: ConversationsHooks,
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

  /**
   * Every conversation, archived ones included. Used where the whole roster
   * matters (mention labels, mounted workdirs) — the chat list uses
   * {@link listVisible} instead.
   */
  list(): Conversation[] {
    const rows = this.db
      .prepare(
        "select * from conversations where type != 'card' order by coalesce(last_message_at, created_at) desc",
      )
      .all() as ConversationRow[];
    return rows.map(conversationRowToConversation);
  }

  /**
   * Conversations of the chat list: archived ones (removed from the list but
   * kept in the address book) are excluded.
   */
  listVisible(): Conversation[] {
    const rows = this.db
      .prepare(
        "select * from conversations where archived_at is null and type != 'card' order by coalesce(last_message_at, created_at) desc",
      )
      .all() as ConversationRow[];
    return rows.map(conversationRowToConversation);
  }

  /**
   * Archives a conversation (removed from the chat list, data kept) or brings
   * it back. Archiving is a soft delete: messages, runs, attachments,
   * workspaces and the project wiki stay on disk; the address book keeps the
   * entry so it can be restored.
   */
  setArchived(conversationId: string, archived: boolean): Conversation {
    const conversation = this.getOrThrow(conversationId);
    if (archived) {
      if (conversation.archivedAt !== null && conversation.archivedAt !== undefined) {
        return conversation;
      }
      this.db
        .prepare('update conversations set archived_at = ? where id = ?')
        .run(this.clock.now(), conversationId);
    } else {
      if (conversation.archivedAt === null || conversation.archivedAt === undefined) {
        return conversation;
      }
      this.db
        .prepare('update conversations set archived_at = null where id = ?')
        .run(conversationId);
    }
    return this.getOrThrow(conversationId);
  }

  /**
   * Opens the single conversation with a bot, creating it (plus the member
   * row) when missing. Read-only past conversations are never reopened — a
   * deleted bot's chat stays closed and a new bot instance gets a new id.
   * An archived chat (removed from the chat list) is returned as-is: the
   * domain never resurrects it. Restoring is a user action and lives in the
   * RPC layer (`conversations.openDirect` / `conversations.unarchive`), so
   * background deliveries (mail, workbench) don't pull it back into the list.
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

  /** Binds or unbinds the conversation's workdir (P04; null clears). */
  setWorkdir(conversationId: string, workdirId: string | null): void {
    this.db
      .prepare('update conversations set workdir_id = ? where id = ?')
      .run(workdirId, conversationId);
  }

  /**
   * The open card conversation for this executor, or a new one. Another open
   * conversation of the same card becomes read-only first, so the unique
   * index `conversations_one_open_per_card` holds under concurrent callers.
   */
  ensureCardConversation(input: EnsureCardConversationInput): EnsureCardConversationResult {
    try {
      return this.#ensureCardConversation(input);
    } catch (error) {
      if (!isOpenCardConflict(error)) throw error;
      return this.#ensureCardConversation(input);
    }
  }

  /** Current open card conversation of a todo, if any. */
  openCardConversation(todoId: string): Conversation | null {
    const row = this.db
      .prepare(
        "select * from conversations where type = 'card' and card_todo_id = ? and read_only = 0",
      )
      .get(todoId) as ConversationRow | undefined;
    return row ? conversationRowToConversation(row) : null;
  }

  /**
   * Card conversations of a todo, a bot, or a project. At least one filter
   * is required; an empty filter returns nothing.
   */
  cardConversations(filter: CardConversationFilter): Conversation[] {
    return this.#cardConversations(filter, undefined);
  }

  /** Read-only card conversations of a todo, a bot, or a project. */
  readOnlyCardConversationsOf(filter: CardConversationFilter): Conversation[] {
    return this.#cardConversations(filter, true);
  }

  /** Writes the derived card title onto every conversation of that card. */
  setCardTitle(todoId: string, title: string): Conversation[] {
    const changed = this.db.transaction(() => {
      const rows = this.db
        .prepare("select * from conversations where type = 'card' and card_todo_id = ?")
        .all(todoId) as ConversationRow[];
      const updated: Conversation[] = [];
      for (const row of rows) {
        if (row.title === title) continue;
        this.db.prepare('update conversations set title = ? where id = ?').run(title, row.id);
        updated.push(this.getOrThrow(row.id));
      }
      return updated;
    })();
    this.#publishUpdated(changed);
    return changed;
  }

  /** Every open card conversation of the todo becomes read-only. */
  closeOpenCardConversations(todoId: string): Conversation[] {
    const changed = this.db.transaction(() => {
      const rows = this.db
        .prepare(
          "select id from conversations where type = 'card' and card_todo_id = ? and read_only = 0",
        )
        .all(todoId) as Array<{ id: string }>;
      for (const row of rows) this.setReadOnly(row.id, true);
      return rows.map((row) => this.getOrThrow(row.id));
    })();
    this.#publishUpdated(changed);
    return changed;
  }

  /** Direct conversations of a bot (read-only ones included). Card chats are not direct. */
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

  #ensureCardConversation(input: EnsureCardConversationInput): EnsureCardConversationResult {
    const title = input.title;
    const result = this.db.transaction(() => {
      const same = this.db
        .prepare(
          "select * from conversations where type = 'card' and card_todo_id = ? and direct_bot_id = ?",
        )
        .get(input.todoId, input.botId) as ConversationRow | undefined;
      const others = this.db
        .prepare(
          "select id from conversations where type = 'card' and card_todo_id = ? and read_only = 0 and direct_bot_id != ?",
        )
        .all(input.todoId, input.botId) as Array<{ id: string }>;
      const updated: Conversation[] = [];
      for (const other of others) {
        this.setReadOnly(other.id, true);
        updated.push(this.getOrThrow(other.id));
      }
      if (same) {
        let changed = false;
        if (same.read_only === 1) {
          this.setReadOnly(same.id, false);
          changed = true;
        }
        if (same.title !== title) {
          this.db.prepare('update conversations set title = ? where id = ?').run(title, same.id);
          changed = true;
        }
        const conversation = this.getOrThrow(same.id);
        if (changed) updated.push(conversation);
        return { conversation, created: false, updated };
      }
      const id = newId('conv');
      const now = this.clock.now();
      this.db
        .prepare(
          `insert into conversations
             (id, type, title, direct_bot_id, parent_project_id, card_todo_id, created_at)
           values (?, 'card', ?, ?, ?, ?, ?)`,
        )
        .run(id, title, input.botId, input.projectId, input.todoId, now);
      this.db
        .prepare(
          'insert into conversation_members (conversation_id, bot_id, joined_at) values (?, ?, ?)',
        )
        .run(id, input.botId, now);
      const conversation = this.getOrThrow(id);
      updated.push(conversation);
      return { conversation, created: true, updated };
    }).immediate();
    this.#publishUpdated(result.updated);
    return result;
  }

  #cardConversations(filter: CardConversationFilter, readOnly: boolean | undefined): Conversation[] {
    const clauses = ["type = 'card'"];
    const params: Array<string | number> = [];
    if (filter.todoId !== undefined) {
      clauses.push('card_todo_id = ?');
      params.push(filter.todoId);
    }
    if (filter.botId !== undefined) {
      clauses.push('direct_bot_id = ?');
      params.push(filter.botId);
    }
    if (filter.projectId !== undefined) {
      clauses.push('parent_project_id = ?');
      params.push(filter.projectId);
    }
    if (clauses.length === 1) return [];
    if (readOnly !== undefined) {
      clauses.push('read_only = ?');
      params.push(readOnly ? 1 : 0);
    }
    const rows = this.db
      .prepare(
        `select * from conversations where ${clauses.join(' and ')} order by created_at asc, id asc`,
      )
      .all(...params) as ConversationRow[];
    return rows.map(conversationRowToConversation);
  }

  /** Skip while a caller transaction is still open; that caller publishes after commit. */
  #publishUpdated(conversations: readonly Conversation[]): void {
    if (this.db.inTransaction) return;
    for (const conversation of conversations) this.hooks?.onUpdated?.(conversation);
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

function isOpenCardConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /conversations_one_open_per_card|UNIQUE constraint failed/i.test(message);
}
