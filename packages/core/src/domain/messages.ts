import {
  AppError,
  INTERNAL_SYSTEM_EVENTS,
  newId,
  type Message,
  type MessageStatus,
} from '@kepcup/shared';
import { buildFtsQuery, segmentForFts } from '../infra/text-segment.js';
import type { SqliteDatabase } from '../infra/db.js';
import type { Clock } from '../infra/clock.js';

interface MessageRow {
  id: string;
  conversation_id: string;
  seq: number;
  sender_type: 'user' | 'bot' | 'system';
  sender_bot_id: string | null;
  kind: 'text' | 'system_event' | 'card';
  content_json: string;
  reply_to: string | null;
  mentions_json: string;
  batch_id: string | null;
  run_id: string | null;
  status: MessageStatus;
  edited_at: number | null;
  created_at: number;
}

export interface AppendMessageInput {
  conversationId: string;
  senderType: 'user' | 'bot' | 'system';
  senderBotId?: string | null;
  kind: 'text' | 'system_event' | 'card';
  text?: string | undefined;
  /** text messages only: setup-interview answer (hidden bubble in the UI). */
  setupAnswer?: boolean | undefined;
  event?: string | undefined;
  /** system_event extras: clickable bot candidates / related batch (P05). */
  botIds?: string[] | undefined;
  /**
   * Bot-internal affair (wiki ingest, env install, skill import, schedule
   * trigger — INTERNAL_SYSTEM_EVENTS): the row still feeds the bot's context
   * and triggers, but user-visible read paths filter it out.
   */
  internal?: boolean | undefined;
  relatedBatchId?: string | undefined;
  /** system_event extras: setup-question candidate answers (bot_setup_question). */
  options?: string[] | undefined;
  /** system_event extras: group-creation question step (group_setup_question). */
  step?: string | undefined;
  /** Card messages only: the approval the card belongs to. */
  cardType?: string | undefined;
  approvalId?: string | undefined;
  /** Run-changes cards only: the run whose changes the card summarizes. */
  cardRunId?: string | undefined;
  replyTo?: string | null;
  mentions?: string[];
  batchId?: string | null;
  runId?: string | null;
  /** Overrides the creation time (defaults to the clock). */
  at?: number | undefined;
}

export function messageRowToMessage(row: MessageRow): Message {
  const content = JSON.parse(row.content_json) as Message['content'];
  return {
    id: row.id,
    conversationId: row.conversation_id,
    seq: row.seq,
    senderType: row.sender_type,
    senderBotId: row.sender_bot_id,
    kind: row.kind,
    content,
    replyTo: row.reply_to,
    mentions: JSON.parse(row.mentions_json) as string[],
    batchId: row.batch_id,
    runId: row.run_id,
    status: row.status,
    editedAt: row.edited_at,
    createdAt: row.created_at,
    attachments: [],
  };
}

/**
 * 用户可见性（docs/design/01-conversation.md 消息原则）：Bot 的内部事务——
 * wiki 入库、环境安装、技能导入、调度触发、凭据处理——不是对话内容。带
 * `internal` 标记或属于 INTERNAL_SYSTEM_EVENTS（历史存量行没有标记）的
 * system_event 只进 Bot 的上下文与触发，不进用户可见的消息流；其余消息
 * （用户/Bot 发言、审批卡、访谈卡、群聊认领提示、执行中断等）都可见。
 */
export function isVisibleToUser(message: Message): boolean {
  if (message.senderType !== 'system' || message.kind !== 'system_event') return true;
  const content = message.content as { internal?: boolean; event?: string };
  if (content.internal === true) return false;
  return !INTERNAL_SYSTEM_EVENTS.has(content.event ?? '');
}

/**
 * Message storage. `seq` is monotonic per conversation (assigned inside the
 * insert transaction); every text write keeps `messages_fts` in sync.
 */
export class MessagesService {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock,
  ) {}

  append(input: AppendMessageInput): Message {
    const now = input.at ?? this.clock.now();
    const id = newId('msg');
    const contentJson =
      input.kind === 'text'
        ? JSON.stringify({
            text: input.text ?? '',
            ...(input.setupAnswer ? { setupAnswer: true } : {}),
          })
        : input.kind === 'card'
          ? JSON.stringify({
              cardType: input.cardType ?? '',
              approvalId: input.approvalId ?? '',
              ...(input.cardRunId !== undefined ? { runId: input.cardRunId } : {}),
            })
          : JSON.stringify({
              event: input.event ?? '',
              text: input.text ?? '',
              ...(input.botIds !== undefined ? { botIds: input.botIds } : {}),
              ...(input.internal ? { internal: true } : {}),
              ...(input.relatedBatchId !== undefined ? { batchId: input.relatedBatchId } : {}),
              ...(input.options !== undefined ? { options: input.options } : {}),
              ...(input.step !== undefined ? { step: input.step } : {}),
            });
    const mentions = input.mentions ?? [];
    let message: Message;
    const run = this.db.transaction(() => {
      const row = this.db
        .prepare('select last_seq from conversations where id = ?')
        .get(input.conversationId) as { last_seq: number } | undefined;
      if (!row)
        throw new AppError('NOT_FOUND', `Conversation ${input.conversationId} does not exist`);
      const seq = row.last_seq + 1;
      this.db
        .prepare(
          'insert into messages (id, conversation_id, seq, sender_type, sender_bot_id, kind, content_json, reply_to, mentions_json, batch_id, run_id, status, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          id,
          input.conversationId,
          seq,
          input.senderType,
          input.senderBotId ?? null,
          input.kind,
          contentJson,
          input.replyTo ?? null,
          JSON.stringify(mentions),
          input.batchId ?? null,
          input.runId ?? null,
          'normal',
          now,
        );
      this.db
        .prepare(
          'update conversations set last_seq = ?, last_message_at = max(coalesce(last_message_at, 0), ?) where id = ?',
        )
        .run(seq, now, input.conversationId);
      if (input.kind === 'text' && (input.text ?? '').length > 0) {
        this.db
          .prepare(
            'insert into messages_fts (segmented_text, message_id, conversation_id) values (?, ?, ?)',
          )
          .run(segmentForFts(input.text ?? ''), id, input.conversationId);
      }
      message = {
        id,
        conversationId: input.conversationId,
        seq,
        senderType: input.senderType,
        senderBotId: input.senderBotId ?? null,
        kind: input.kind,
        content: JSON.parse(contentJson) as Message['content'],
        replyTo: input.replyTo ?? null,
        mentions,
        batchId: input.batchId ?? null,
        runId: input.runId ?? null,
        status: 'normal',
        editedAt: null,
        createdAt: now,
        attachments: [],
      };
    });
    run.immediate();
    return message!;
  }

  getById(id: string): Message | null {
    const row = this.db.prepare('select * from messages where id = ?').get(id) as
      MessageRow | undefined;
    if (!row) return null;
    const message = messageRowToMessage(row);
    message.attachments = this.attachmentsFor(message.id);
    return message;
  }

  getOrThrow(id: string): Message {
    const message = this.getById(id);
    if (!message) throw new AppError('NOT_FOUND', `Message ${id} does not exist`);
    return message;
  }

  list(conversationId: string, options: { beforeSeq?: number; limit?: number } = {}): Message[] {
    const limit = options.limit ?? 60;
    const rows = (
      options.beforeSeq !== undefined
        ? this.db
            .prepare(
              'select * from messages where conversation_id = ? and seq < ? order by seq desc limit ?',
            )
            .all(conversationId, options.beforeSeq, limit)
        : this.db
            .prepare('select * from messages where conversation_id = ? order by seq desc limit ?')
            .all(conversationId, limit)
    ) as MessageRow[];
    return rows
      .reverse()
      .map(messageRowToMessage)
      .map((m) => ({ ...m, attachments: this.attachmentsFor(m.id) }));
  }

  /**
   * 用户可见消息列表（messages.list RPC 的数据源）：`isVisibleToUser` 的 SQL
   * 镜像——内部事务事件在存储层就被排除，一页取满 limit 条**可见**消息。
   * 若像旧实现那样先取原始行再在 RPC 层过滤，密集的内部事件会把页压缩成
   * 短页，桌面端「不足一页 = 没有更早消息」的判断会截断历史。Bot 侧读
   * 上下文仍走 list（含内部事件）。
   */
  listVisible(
    conversationId: string,
    options: { beforeSeq?: number; limit?: number } = {},
  ): Message[] {
    const limit = options.limit ?? 60;
    const eventNames = [...INTERNAL_SYSTEM_EVENTS];
    const params: Array<string | number> = [conversationId, ...eventNames];
    let where =
      `conversation_id = ? and not (sender_type = 'system' and kind = 'system_event' and (` +
      `coalesce(json_extract(content_json, '$.internal'), 0) = 1 or ` +
      `coalesce(json_extract(content_json, '$.event'), '') in (${eventNames.map(() => '?').join(', ')})))`;
    if (options.beforeSeq !== undefined) {
      where += ' and seq < ?';
      params.push(options.beforeSeq);
    }
    params.push(limit);
    const rows = this.db
      .prepare(`select * from messages where ${where} order by seq desc limit ?`)
      .all(...params) as MessageRow[];
    return rows
      .reverse()
      .map(messageRowToMessage)
      .map((m) => ({ ...m, attachments: this.attachmentsFor(m.id) }));
  }

  /** Edit a user message: content replaced, marked `edited`, FTS updated. */
  edit(id: string, text: string): Message {
    const message = this.getOrThrow(id);
    if (message.senderType !== 'user') {
      throw new AppError('MESSAGE_NOT_RECALLABLE', 'Only user messages can be edited');
    }
    if (message.status === 'recalled') {
      throw new AppError('MESSAGE_NOT_RECALLABLE', 'A recalled message cannot be edited');
    }
    const now = this.clock.now();
    this.db
      .prepare(
        "update messages set content_json = ?, status = 'edited', edited_at = ? where id = ?",
      )
      .run(JSON.stringify({ text }), now, id);
    this.db.prepare('delete from messages_fts where message_id = ?').run(id);
    this.db
      .prepare(
        'insert into messages_fts (segmented_text, message_id, conversation_id) values (?, ?, ?)',
      )
      .run(segmentForFts(text), id, message.conversationId);
    return this.getOrThrow(id);
  }

  /**
   * Full-text search inside one conversation. Recalled messages never match
   * (their FTS rows are deleted).
   */
  search(
    conversationId: string,
    query: string,
    options: { limit?: number; senderBotId?: string | null; fromSeq?: number; toSeq?: number } = {},
  ): Message[] {
    const ftsQuery = buildFtsQuery(query);
    if (!ftsQuery) return [];
    const limit = options.limit ?? 20;
    const rows = this.db
      .prepare(
        'select m.* from messages_fts f join messages m on m.id = f.message_id ' +
          "where f.conversation_id = ? and messages_fts match ? and m.status != 'recalled' " +
          'order by m.seq limit ?',
      )
      .all(conversationId, ftsQuery, limit) as MessageRow[];
    return rows.map(messageRowToMessage);
  }

  /** Messages of one flush batch, in seq order (group re-dispatch, P05). */
  listByBatch(batchId: string): Message[] {
    const rows = this.db
      .prepare('select * from messages where batch_id = ? order by seq')
      .all(batchId) as MessageRow[];
    return rows
      .map(messageRowToMessage)
      .map((m) => ({ ...m, attachments: this.attachmentsFor(m.id) }));
  }

  /**
   * User messages strictly after `seq`, in order (19/D59 目录闸门放行：访谈
   * 首答与期间自由输入的消息在目录卡作答后一起作为触发批投递)。
   */
  userMessagesAfter(conversationId: string, seq: number): Message[] {
    const rows = this.db
      .prepare(
        "select * from messages where conversation_id = ? and seq > ? and sender_type = 'user' and status != 'recalled' order by seq",
      )
      .all(conversationId, seq) as MessageRow[];
    return rows
      .map(messageRowToMessage)
      .map((m) => ({ ...m, attachments: this.attachmentsFor(m.id) }));
  }

  /** Messages around an anchor (N before + the anchor + N after). */
  around(conversationId: string, seq: number, n: number): Message[] {
    const rows = this.db
      .prepare(
        "select * from messages where conversation_id = ? and seq >= ? and seq <= ? and status != 'recalled' order by seq",
      )
      .all(conversationId, seq - n, seq + n) as MessageRow[];
    return rows.map(messageRowToMessage);
  }

  setSummary(conversationId: string, summary: string, uptoSeq: number): void {
    this.db
      .prepare('update conversations set summary = ?, summary_upto_seq = ? where id = ?')
      .run(summary, uptoSeq, conversationId);
  }

  /** Loads unsummarized messages (between summary_upto_seq and beforeSeq). */
  unsummarized(conversationId: string, beforeSeq: number): Message[] {
    const rows = this.db
      .prepare(
        "select * from messages where conversation_id = ? and seq > ? and seq <= ? and status != 'recalled' order by seq",
      )
      .all(conversationId, 0, beforeSeq) as MessageRow[];
    const conv = this.db
      .prepare('select summary_upto_seq from conversations where id = ?')
      .get(conversationId) as { summary_upto_seq: number };
    return rows.filter((r) => r.seq > conv.summary_upto_seq).map(messageRowToMessage);
  }

  countByConversation(conversationId: string): number {
    return (
      this.db
        .prepare('select count(*) as n from messages where conversation_id = ?')
        .get(conversationId) as { n: number }
    ).n;
  }

  /**
   * Number of system events of one kind in the conversation (content JSON
   * substring match; used for the setup question cap).
   */
  countSystemEvents(conversationId: string, event: string): number {
    const row = this.db
      .prepare(
        "select count(*) as n from messages where conversation_id = ? and kind = 'system_event' and instr(content_json, ?) > 0",
      )
      .get(conversationId, `"event":"${event}"`) as { n: number };
    return row.n;
  }

  /**
   * Seq of the FIRST/LAST system event of one kind (same substring match as
   * countSystemEvents). 19/D59 目录闸门用：闸门关闭判定（目录卡之后有无用户
   * 消息）与缓冲投递范围（首问卡之后全部用户消息）都以 seq 为基准。
   */
  systemEventSeq(conversationId: string, event: string, which: 'first' | 'last'): number | null {
    const row = this.db
      .prepare(
        `select seq from messages where conversation_id = ? and kind = 'system_event' and instr(content_json, ?) > 0 order by seq ${which === 'first' ? 'asc' : 'desc'} limit 1`,
      )
      .get(conversationId, `"event":"${event}"`) as { seq: number } | undefined;
    return row?.seq ?? null;
  }

  countByBot(botId: string): number {
    return (
      this.db.prepare('select count(*) as n from messages where sender_bot_id = ?').get(botId) as {
        n: number;
      }
    ).n;
  }

  attachmentsFor(messageId: string): Message['attachments'] {
    const rows = this.db
      .prepare('select * from attachments where message_id = ?')
      .all(messageId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r['id'] as string,
      conversationId: r['conversation_id'] as string,
      messageId: r['message_id'] as string | null,
      draftId: r['draft_id'] as string | null,
      fileName: r['file_name'] as string,
      mime: r['mime'] as string,
      size: r['size'] as number,
      sha256: r['sha256'] as string,
      relPath: r['rel_path'] as string,
      createdAt: r['created_at'] as number,
    }));
  }
}
