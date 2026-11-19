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
  from_bot_id: string | null;
  to_bot_id: string | null;
  owner_principal_id: string | null;
}

/** In-conversation participant role of a human principal (fixed vocabulary). */
export type ConversationPrincipalRole = 'member' | 'lead';

/** One active (not yet left) principal roster row of a conversation. */
export interface ConversationPrincipal {
  conversationId: string;
  principalId: string;
  role: ConversationPrincipalRole;
  joinedAt: number;
}

interface PrincipalRow {
  conversation_id: string;
  principal_id: string;
  role: ConversationPrincipalRole;
  joined_at: number;
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
    fromBotId: row.from_bot_id,
    toBotId: row.to_bot_id,
    workdirId: row.workdir_id,
    readOnly: row.read_only === 1,
    archivedAt: row.archived_at ?? null,
    summary: row.summary,
    summaryUptoSeq: row.summary_upto_seq,
    lastSeq: row.last_seq,
    lastReadSeq: row.last_read_seq,
    lastMessageAt: row.last_message_at,
    createdAt: row.created_at,
    // 62.11 C3: owner of a `direct` conversation (null / absent on single-user
    // installs and on dm / project rows). Omitted when null so dormant
    // conversation payloads stay byte-identical.
    ...(row.owner_principal_id !== null ? { ownerPrincipalId: row.owner_principal_id } : {}),
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
    return row ? this.#hydrate([row])[0] ?? null : null;
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
        // D113: `bot_direct` (per-delegation exchange conversations) stays off
        // the roster, same as `card` — the pill detail view reads it by id.
        "select * from conversations where type not in ('card', 'bot_direct') order by coalesce(last_message_at, created_at) desc",
      )
      .all() as ConversationRow[];
    return this.#hydrate(rows);
  }

  /**
   * Conversations of the chat list: archived ones (removed from the list but
   * kept in the address book) are excluded.
   */
  listVisible(): Conversation[] {
    const rows = this.db
      .prepare(
        "select * from conversations where archived_at is null and type not in ('card', 'bot_direct') order by coalesce(last_message_at, created_at) desc",
      )
      .all() as ConversationRow[];
    return this.#hydrate(rows);
  }

  /**
   * Conversations a human principal may see (62.11 C3): those they own (their
   * `direct` chats) plus those they are an active participant of (`dm` /
   * `project` rosters). Card and exchange conversations resolve through their
   * parent (see {@link accessibleBy}) and stay off the roster, like
   * {@link list}. `visibleOnly` applies the {@link listVisible} filter
   * (archived rows dropped); omitted / false = the {@link list} roster.
   */
  listForPrincipal(
    principalId: string,
    opts?: { visibleOnly?: boolean } | undefined,
  ): Conversation[] {
    const visibleOnly = opts?.visibleOnly === true;
    const rows = this.db
      .prepare(
        `select * from conversations c
          where c.type not in ('card', 'bot_direct')
            ${visibleOnly ? 'and c.archived_at is null' : ''}
            and (
              (c.type = 'direct' and c.owner_principal_id = ?)
              or exists (
                select 1 from conversation_principals p
                 where p.conversation_id = c.id and p.principal_id = ? and p.left_at is null
              )
            )
          order by coalesce(c.last_message_at, c.created_at) desc`,
      )
      .all(principalId, principalId) as ConversationRow[];
    return this.#hydrate(rows);
  }

  /**
   * Whether the principal may touch this conversation (62.04 §2 会话资格,
   * core-side seam): direct = its owner; dm / project = active roster member;
   * card / bot_direct resolve through their parent project / the delegation's
   * source chat. Missing conversation = false (never leak existence).
   */
  async accessibleBy(conversationId: string, principalId: string): Promise<boolean> {
    const conversation = this.get(conversationId);
    if (conversation === null) return false;
    switch (conversation.type) {
      case 'direct':
        return conversation.ownerPrincipalId === principalId;
      case 'dm':
      case 'project':
        return this.hasPrincipal(conversationId, principalId);
      case 'card': {
        const parent = conversation.parentProjectId;
        return parent !== null && this.hasPrincipal(parent, principalId);
      }
      case 'bot_direct': {
        // The exchange conversation belongs to the delegation that opened it;
        // eligibility follows the delegating chat: a direct chat by owner, a
        // project chat by roster (delegations can be proposed from a project).
        const row = this.db
          .prepare(
            'select from_conversation_id as id from delegations where exchange_conversation_id = ? limit 1',
          )
          .get(conversationId) as { id: string } | undefined;
        if (row === undefined) return false;
        const source = this.get(row.id);
        if (source === null) return false;
        if (source.type === 'direct') return source.ownerPrincipalId === principalId;
        if (source.type === 'project') return this.hasPrincipal(source.id, principalId);
        return false;
      }
    }
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
   *
   * `opts.ownerPrincipalId` (62.11 C3) scopes the chat per human principal —
   * one conversation per (bot, owner), matching the unique index
   * `conversations_one_direct_per_bot`. Omitted / null = the single-user chat
   * (owner NULL, exactly the pre-team-server rows and lookup).
   */
  openDirect(
    botId: string,
    opts?: { ownerPrincipalId?: string | null } | undefined,
  ): { conversation: Conversation; created: boolean } {
    const ownerPrincipalId = opts?.ownerPrincipalId ?? null;
    const existing = this.db
      .prepare(
        "select * from conversations where type = 'direct' and direct_bot_id = ? and read_only = 0 " +
          "and ifnull(owner_principal_id, '') = ?",
      )
      .get(botId, ownerPrincipalId ?? '') as ConversationRow | undefined;
    if (existing) return { conversation: this.#hydrate([existing])[0]!, created: false };

    const id = newId('conv');
    const now = this.clock.now();
    const run = this.db.transaction(() => {
      this.db
        .prepare(
          'insert into conversations (id, type, direct_bot_id, owner_principal_id, created_at) values (?, ?, ?, ?, ?)',
        )
        .run(id, 'direct', botId, ownerPrincipalId, now);
      this.db
        .prepare(
          'insert into conversation_members (conversation_id, bot_id, joined_at) values (?, ?, ?)',
        )
        .run(id, botId, now);
    });
    run.immediate();
    return { conversation: this.getOrThrow(id), created: true };
  }

  /**
   * Opens (or reuses) a human-to-human `dm` conversation (62.11 C3 / 62.04 §2):
   * no bot, no lead, no dispatch — participants live in
   * `conversation_principals`. A single id opens the principal's self
   * conversation. Idempotent on the unordered id pair: the lookup compares the
   * full active roster, so a left participant rejoining matches a fresh
   * conversation, never a stale one. Every participant joins as
   * `role = 'member'` (`'lead'` is reserved for project leads).
   */
  openDm(principalIds: string[]): { conversation: Conversation; created: boolean } {
    const ids = [...new Set(principalIds.map((id) => id.trim()).filter((id) => id.length > 0))].sort();
    if (ids.length === 0) {
      throw new AppError('INVALID_INPUT', 'dm conversation requires at least one principal');
    }
    const placeholders = ids.map(() => '?').join(', ');
    const candidates = this.db
      .prepare(
        `select conversation_id as id from conversation_principals
          where left_at is null and principal_id in (${placeholders})
          group by conversation_id
          having count(distinct principal_id) = ?`,
      )
      .all(...ids, ids.length) as Array<{ id: string }>;
    for (const candidate of candidates) {
      const roster = this.#activePrincipalIds(candidate.id);
      if (roster.length !== ids.length) continue;
      if (!ids.every((id) => roster.includes(id))) continue;
      const conversation = this.get(candidate.id);
      if (conversation !== null && conversation.type === 'dm') {
        return { conversation, created: false };
      }
    }

    const id = newId('conv');
    const now = this.clock.now();
    const run = this.db.transaction(() => {
      // dm rows carry neither a bot nor a lead (every 0077 CHECK holds with
      // those columns NULL).
      this.db
        .prepare("insert into conversations (id, type, created_at) values (?, 'dm', ?)")
        .run(id, now);
      for (const principalId of ids) {
        this.db
          .prepare(
            "insert into conversation_principals (conversation_id, principal_id, role, joined_at) values (?, ?, 'member', ?)",
          )
          .run(id, principalId, now);
      }
    });
    run.immediate();
    return { conversation: this.getOrThrow(id), created: true };
  }

  /** Active (not left) principals of a conversation, in join order. */
  principals(conversationId: string): ConversationPrincipal[] {
    const rows = this.db
      .prepare(
        'select conversation_id, principal_id, role, joined_at from conversation_principals where conversation_id = ? and left_at is null order by joined_at, principal_id',
      )
      .all(conversationId) as PrincipalRow[];
    return rows.map((row) => ({
      conversationId: row.conversation_id,
      principalId: row.principal_id,
      role: row.role,
      joinedAt: row.joined_at,
    }));
  }

  /** Whether the principal is an active participant (left rows excluded). */
  hasPrincipal(conversationId: string, principalId: string): boolean {
    const row = this.db
      .prepare(
        'select 1 as hit from conversation_principals where conversation_id = ? and principal_id = ? and left_at is null limit 1',
      )
      .get(conversationId, principalId) as { hit: number } | undefined;
    return row !== undefined;
  }

  /**
   * D113 (D71 v2): a fresh single-turn `bot_direct` exchange conversation for
   * one delegation — A's task message and B's replies live here, never in the
   * users' chats. Every call creates a NEW conversation (one delegation : one
   * exchange, so the pill's detail link is unambiguous); it is not listed in
   * the roster and the user cannot speak into it. The executor's workdir
   * binding (if its user chat has one) is copied so the delegated turn's
   * `resolveCwd` matches v1 semantics. Members: both bots.
   */
  openExchange(fromBotId: string, toBotId: string): Conversation {
    const bound = this.db
      .prepare(
        "select workdir_id from conversations where type = 'direct' and direct_bot_id = ? and read_only = 0",
      )
      .get(toBotId) as { workdir_id: string | null } | undefined;
    const workdirId = bound?.workdir_id ?? null;
    const id = newId('conv');
    const now = this.clock.now();
    const run = this.db.transaction(() => {
      this.db
        .prepare(
          'insert into conversations (id, type, workdir_id, from_bot_id, to_bot_id, created_at) values (?, ?, ?, ?, ?, ?)',
        )
        .run(id, 'bot_direct', workdirId, fromBotId, toBotId, now);
      for (const botId of [fromBotId, toBotId]) {
        this.db
          .prepare(
            'insert into conversation_members (conversation_id, bot_id, joined_at) values (?, ?, ?)',
          )
          .run(id, botId, now);
      }
    });
    run.immediate();
    return this.getOrThrow(id);
  }

  /**
   * Marks messages read up to `seq`. With `principalId` (62.11 C5) the write
   * goes only to the per-principal `conversation_reads` row (upsert max); the
   * conversation-wide `last_read_seq` stays untouched. Without one this is the
   * single-user path exactly as before (the old column).
   */
  markRead(conversationId: string, seq: number, principalId?: string | null | undefined): void {
    if (principalId != null && principalId.length > 0) {
      this.db
        .prepare(
          `insert into conversation_reads (conversation_id, principal_id, last_read_seq)
           values (?, ?, ?)
           on conflict(conversation_id, principal_id) do update set
             last_read_seq = max(last_read_seq, excluded.last_read_seq)`,
        )
        .run(conversationId, principalId, seq);
      return;
    }
    this.db
      .prepare('update conversations set last_read_seq = max(last_read_seq, ?) where id = ?')
      .run(seq, conversationId);
  }

  /**
   * The principal's stored read position (62.11 C5, read by the binding layer's
   * conversation view). Missing row = 0 (never read anything).
   */
  lastReadSeqOf(conversationId: string, principalId: string): number {
    const row = this.db
      .prepare(
        'select last_read_seq as seq from conversation_reads where conversation_id = ? and principal_id = ?',
      )
      .get(conversationId, principalId) as { seq: number } | undefined;
    return row?.seq ?? 0;
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

  /**
   * Maps rows and enriches `dm` rows with their active principal roster
   * (62.11 C3 `peerPrincipalIds`; the binding layer's conversation view reads
   * the same roster). Non-dm rows pass through untouched — and with no dm rows
   * at all (every single-user database) this is a pure map.
   */
  #hydrate(rows: ConversationRow[]): Conversation[] {
    const conversations = rows.map(conversationRowToConversation);
    const dmIds = conversations.filter((c) => c.type === 'dm').map((c) => c.id);
    if (dmIds.length === 0) return conversations;
    const placeholders = dmIds.map(() => '?').join(', ');
    const roster = this.db
      .prepare(
        `select conversation_id, principal_id from conversation_principals
          where left_at is null and conversation_id in (${placeholders})
          order by joined_at, principal_id`,
      )
      .all(...dmIds) as Array<{ conversation_id: string; principal_id: string }>;
    const peers = new Map<string, string[]>();
    for (const row of roster) {
      const list = peers.get(row.conversation_id) ?? [];
      list.push(row.principal_id);
      peers.set(row.conversation_id, list);
    }
    return conversations.map((conversation) =>
      conversation.type === 'dm'
        ? { ...conversation, peerPrincipalIds: peers.get(conversation.id) ?? [] }
        : conversation,
    );
  }

  /** Active principal ids of a conversation (raw list, no ordering guarantee). */
  #activePrincipalIds(conversationId: string): string[] {
    const rows = this.db
      .prepare(
        'select principal_id as id from conversation_principals where conversation_id = ? and left_at is null',
      )
      .all(conversationId) as Array<{ id: string }>;
    return rows.map((row) => row.id);
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
