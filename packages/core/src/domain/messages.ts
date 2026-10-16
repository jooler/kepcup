import {
  AppError,
  EPHEMERAL_APPROVAL_CARD_TYPES,
  INTERNAL_SYSTEM_EVENTS,
  isEphemeralApprovalCardType,
  isHiddenApprovalCard,
  TERMINAL_TASK_EVENT_PHASES,
  newId,
  taskEventContentSchema,
  type AppUiCard,
  type Message,
  type MessageKind,
  type MessageStatus,
  type RunStatus,
  type ScheduleOfferContent,
  type HandoverEventContent,
  type SettingCardContent,
  type SettingCardResolved,
  type ScheduleReceiptSnapshot,
  type TaskEventContent,
  type TaskEventPhase,
  type AskUserField,
  type AskUserMode,
  type PresentCard,
  type WidgetCard,
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
  kind: MessageKind;
  content_json: string;
  reply_to: string | null;
  mentions_json: string;
  batch_id: string | null;
  run_id: string | null;
  status: MessageStatus;
  edited_at: number | null;
  created_at: number;
  owner_bot_id: string | null;
  task_id: string | null;
}

export interface AppendMessageInput {
  conversationId: string;
  /**
   * Bot-generated attachments (already uploaded, unbound) to attach to the new
   * message **in the same transaction** as the insert: either the message and
   * its attachments both land, or neither does (no attachment-less shell
   * message when binding fails). Each id must exist; otherwise the whole
   * append rolls back with INVALID_INPUT.
   */
  attachmentIds?: readonly string[] | undefined;
  senderType: 'user' | 'bot' | 'system';
  senderBotId?: string | null;
  kind: MessageKind;
  text?: string | undefined;
  /** text messages only: setup-interview answer (hidden bubble in the UI). */
  setupAnswer?: boolean | undefined;
  /**
   * text messages only (D71): a user message proxied by another bot (A) on
   * the user's behalf — `origin: 'delegation'` + the delegation row + A's id.
   */
  delegation?: { delegationId: string; delegatedBy: string } | undefined;
  /**
   * text messages only (D75): a visible message attributed to a task —
   * `origin: 'task'` + the task's run id (rendered as 「你（任务 t_x）」).
   * `interim: true` marks auto-delivered progress (UI only; not model context).
   */
  taskOrigin?: { taskId: string; interim?: boolean } | undefined;
  /** text messages only (D87 P4 L3): a user message sent from a widget card (confirmed). */
  widgetOrigin?: { widgetId: string; version: number } | undefined;
  /**
   * task_event messages only (D75 §2.4.1): the entry payload; required for
   * kind 'task_event'. Prefer `appendTaskEvent` (idempotent terminal phases).
   */
  taskEvent?: TaskEventContent | undefined;
  /**
   * Private-row owner (D75 §2.4.2): only this bot sees the row; null/omitted =
   * shared with the conversation. Used for task_event only.
   */
  ownerBotId?: string | null | undefined;
  /** task_id column (task_event only); defaults to `taskEvent.taskId`. */
  taskId?: string | null | undefined;
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
  /** system_event extras: the bot whose task asks (task_question, D75 审查 H1). */
  taskBotId?: string | undefined;
  /** system_event extras (task_question, D87 P4 L2): multi / form question cards. */
  questionMode?: AskUserMode | undefined;
  questionFields?: AskUserField[] | undefined;
  /** system_event extras: group-creation question step (group_setup_question). */
  step?: string | undefined;
  /** system_event extras: butler route card target (route_suggestion, D70). */
  route?:
    | {
        kind: 'bot' | 'group' | 'delegate';
        botId?: string | undefined;
        conversationId?: string | undefined;
        task?: string | undefined;
      }
    | undefined;
  /** system_event extras: schedule receipt snapshot (schedule_created, D80). */
  schedule?: ScheduleReceiptSnapshot | undefined;
  /** system_event extras: schedule offer card (schedule_offer, D80). */
  offer?: ScheduleOfferContent | undefined;
  /** system_event extras: asset handover notes (bot_handover / bot_handed_over, D88). */
  handover?: HandoverEventContent | undefined;
  /** system_event extras: 对话内设置卡（setting_card，含回执卡）。 */
  setting?: SettingCardContent | undefined;
  /** system_event extras: 设置卡落定后唤醒 Bot 的内部事件（setting_card_resolved）的结构化部分。 */
  settingResolved?: SettingCardResolved | undefined;
  /**
   * text messages only (D80): sent by a scheduled turn — the schedule and its
   * title snapshot (「⏰ 标题」 tag under the bubble).
   */
  scheduleSource?: { scheduleId: string; scheduleTitle: string } | undefined;
  /**
   * text messages only (D90): a user message the workbench dispatched on the user's behalf —
   * `origin: 'workbench'` + the todo and its run (rendered as a dispatch card).
   */
  workbench?:
    | {
        todoId: string;
        todoRunId: string;
        viaButler?: boolean | undefined;
        butlerDrafted?: boolean | undefined;
        /** A text update of an in-flight dispatch (`todoUpdate: true`), not a dispatch. */
        update?: boolean | undefined;
      }
    | undefined;
  /**
   * text messages only (D90 §4.5): a reply of a turn that belongs to a dispatched todo — the
   * todo, its run and a title snapshot (「📋 标题」 tag under the bubble).
   */
  todoSource?: { todoId: string; todoRunId: string; todoTitle: string } | undefined;
  /** Card messages only: the approval the card belongs to. */
  cardType?: string | undefined;
  approvalId?: string | undefined;
  /**
   * Mid-turn permission cards only: keep a folded transcript record (auto-decided,
   * egress or taint-flagged; shared `isApprovalRecordCard`).
   */
  cardRecord?: boolean | undefined;
  /** Run-changes cards only: the run whose changes the card summarizes. */
  cardRunId?: string | undefined;
  /** Delegation cards only (D71): the delegation the card renders. */
  cardDelegationId?: string | undefined;
  /** MCP Apps cards only (D73 P3, cardType `mcp_app`): the descriptor (no HTML, no tokens). */
  cardAppUi?: AppUiCard | undefined;
  /** Bot 自制交互组件卡片（D81，cardType `bot_widget`）：描述符（不含 HTML）。 */
  cardWidget?: WidgetCard | undefined;
  /** 声明式展示卡（D87 P4 L1，cardType `present`）。 */
  cardPresent?: PresentCard | undefined;
  /** Watch cards only (W7, cardType `watch`). */
  cardWatch?:
    | {
        watchId: string;
        watchEvent: 'created' | 'alert';
        watchSeq?: number | undefined;
        watchKey?: string | undefined;
        watchSummary?: string | undefined;
      }
    | undefined;
  /** Mail cards only (D84, cardType `mail`). */
  cardMail?:
    | {
        mailEvent: 'arrived';
        mailAccountId: string;
        mailKey: string;
        mailUid?: number | undefined;
        mailFrom?: string | undefined;
        mailSubject?: string | undefined;
        mailDate?: string | undefined;
        mailSummary?: string | undefined;
      }
    | undefined;
  replyTo?: string | null;
  mentions?: string[];
  batchId?: string | null;
  runId?: string | null;
  /** Overrides the creation time (defaults to the clock). */
  at?: number | undefined;
}

/**
 * 状态类邮件 / 监看卡已改为 `app.notice`，schema 只保留有效信息卡。库里的旧行
 * （`mailEvent` 为 error / paused，`watchEvent` 为 paused）原样读出会让
 * `messages.list` 整页校验失败、对话打不开。读出时改写成一条系统提示，不改库。
 */
function legacyStatusNotice(content: unknown): { event: string; text: string } | null {
  if (content === null || typeof content !== 'object') return null;
  const card = content as {
    cardType?: unknown;
    mailEvent?: unknown;
    mailSummary?: unknown;
    watchEvent?: unknown;
    watchSummary?: unknown;
  };
  if (card.cardType === 'mail' && (card.mailEvent === 'error' || card.mailEvent === 'paused')) {
    const summary = typeof card.mailSummary === 'string' ? card.mailSummary.trim() : '';
    return {
      event: 'mail_status',
      text: summary || (card.mailEvent === 'paused' ? '新邮件提醒已暂停' : '邮箱连接失败'),
    };
  }
  if (card.cardType === 'watch' && card.watchEvent === 'paused') {
    const summary = typeof card.watchSummary === 'string' ? card.watchSummary.trim() : '';
    return { event: 'watch_status', text: summary || '监看已暂停' };
  }
  return null;
}

export function messageRowToMessage(row: MessageRow): Message {
  const stored = JSON.parse(row.content_json) as Message['content'];
  const notice = legacyStatusNotice(stored);
  const content = notice ?? stored;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    seq: row.seq,
    senderType: row.sender_type,
    senderBotId: row.sender_bot_id,
    kind: notice !== null ? 'system_event' : row.kind,
    content,
    replyTo: row.reply_to,
    mentions: JSON.parse(row.mentions_json) as string[],
    batchId: row.batch_id,
    runId: row.run_id,
    status: row.status,
    editedAt: row.edited_at,
    createdAt: row.created_at,
    attachments: [],
    ownerBotId: row.owner_bot_id,
    taskId: row.task_id,
  };
}

/** Input of `MessagesService.appendTaskEvent` (D75 §2.4.1). */
export interface AppendTaskEventInput {
  conversationId: string;
  ownerBotId: string;
  taskId: string;
  phase: TaskEventPhase;
  text: string;
  sourceMessageIds?: string[] | undefined;
  status?: RunStatus | undefined;
  error?: string | undefined;
  /** W3: machine-readable failure reason (e.g. `permission_revoked`). */
  errorReason?: string | undefined;
  delivery?: 'delivered' | 'queued' | undefined;
  questionMessageId?: string | undefined;
  title?: string | undefined;
  writes?: boolean | undefined;
  continuesTaskId?: string | undefined;
  /** D91: brief — the external capability ids the task declared. */
  capabilities?: string[] | undefined;
  /** Overrides the creation time (defaults to the clock). */
  at?: number | undefined;
}

const TERMINAL_PHASES_SQL = [...TERMINAL_TASK_EVENT_PHASES].map((p) => `'${p}'`).join(', ');

/**
 * Bot 视角的行过滤（D75 设计 30 §2.4.3）：`viewerBotId` 为某个 Bot 时 = 共享行
 * + 该 Bot 自己的私有条目；`null` = 只看共享行（对话摘要、任务的对话层）。
 * `alias` 是 messages 表在查询里的别名前缀（如 `m.`）。
 */
function viewerFilter(viewerBotId: string | null, alias = ''): { sql: string; params: string[] } {
  return viewerBotId === null
    ? { sql: `${alias}owner_bot_id is null`, params: [] }
    : { sql: `(${alias}owner_bot_id is null or ${alias}owner_bot_id = ?)`, params: [viewerBotId] };
}

/**
 * 用户视角（`isVisibleToUser` 的 SQL 镜像）：非 task_event、非私有，且不是
 * 内部事务事件（带 internal 标记或属于 INTERNAL_SYSTEM_EVENTS）。
 */
function userVisibleFilter(): { sql: string; params: string[] } {
  const eventNames = [...INTERNAL_SYSTEM_EVENTS];
  const ephemeralCards = [...EPHEMERAL_APPROVAL_CARD_TYPES];
  return {
    sql:
      "kind != 'task_event' and owner_bot_id is null and " +
      // Task interim status is a single overlay (task card / status line), not chat bubbles.
      `not (kind = 'text' and coalesce(json_extract(content_json, '$.interim'), 0) = 1) and ` +
      `not (sender_type = 'system' and kind = 'system_event' and (` +
      `coalesce(json_extract(content_json, '$.internal'), 0) = 1 or ` +
      `coalesce(json_extract(content_json, '$.event'), '') in (${eventNames.map(() => '?').join(', ')}))) and ` +
      // Mid-turn permission cards: dock popup only, not transcript history — except
      // the folded records (auto-decided, egress / taint-flagged: `record`).
      `not (kind = 'card' and coalesce(json_extract(content_json, '$.cardType'), '') in (${ephemeralCards.map(() => '?').join(', ')}) ` +
      `and coalesce(json_extract(content_json, '$.record'), 0) != 1)`,
    params: [...eventNames, ...ephemeralCards],
  };
}

/**
 * 用户可见性（docs/design/01-conversation.md 消息原则）：Bot 的内部事务——
 * wiki 入库、环境安装、技能导入、调度触发、凭据处理——不是对话内容。带
 * `internal` 标记或属于 INTERNAL_SYSTEM_EVENTS（历史存量行没有标记）的
 * system_event 只进 Bot 的上下文与触发，不进用户可见的消息流；其余消息
 * （用户/Bot 发言、移交进度卡、访谈卡、群聊认领提示、执行中断等）都可见。
 * 中途权限弹窗（访问、命令、MCP 等）只在输入区上方弹出，不进用户可见流；
 * 例外是带 `record` 标记的折叠记录：自动决定的卡（无人值守，用户从没在 dock
 * 里见过它）与外发 / 污点相关的卡（D73 留痕）。技能导入、环境安装、移交等
 * 卡片留在对话里，失败与进度靠折叠记录。
 */
export function isVisibleToUser(message: Message): boolean {
  // D75 §2.4.3: task_event rows and bot-owned private rows never reach the user.
  if (message.kind === 'task_event' || (message.ownerBotId ?? null) !== null) return false;
  // Task interim progress is a single status overlay — not a chat bubble.
  if (message.kind === 'text') {
    const content = message.content as { interim?: unknown };
    if (content.interim === true) return false;
  }
  if (message.kind === 'card' && isHiddenApprovalCard(message.content as { cardType?: unknown })) {
    return false;
  }
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
    if (input.kind === 'task_event' && input.taskEvent === undefined) {
      throw new AppError('INVALID_INPUT', 'task_event messages require a taskEvent payload');
    }
    const ownerBotId = input.ownerBotId ?? null;
    const taskId = input.taskId ?? input.taskEvent?.taskId ?? null;
    const contentJson =
      input.kind === 'task_event'
        ? JSON.stringify(taskEventContentSchema.parse(input.taskEvent))
        : input.kind === 'text'
          ? JSON.stringify({
              text: input.text ?? '',
              ...(input.setupAnswer ? { setupAnswer: true } : {}),
              ...(input.delegation !== undefined
                ? {
                    origin: 'delegation',
                    delegationId: input.delegation.delegationId,
                    delegatedBy: input.delegation.delegatedBy,
                  }
                : {}),
              ...(input.taskOrigin !== undefined
                ? {
                    origin: 'task',
                    taskId: input.taskOrigin.taskId,
                    ...(input.taskOrigin.interim === true ? { interim: true } : {}),
                  }
                : {}),
              ...(input.widgetOrigin !== undefined
                ? {
                    origin: 'widget',
                    widgetId: input.widgetOrigin.widgetId,
                    widgetVersion: input.widgetOrigin.version,
                  }
                : {}),
              ...(input.workbench !== undefined
                ? {
                    origin: 'workbench',
                    todoId: input.workbench.todoId,
                    todoRunId: input.workbench.todoRunId,
                    ...(input.workbench.viaButler === true ? { viaButler: true } : {}),
                    ...(input.workbench.butlerDrafted === true ? { butlerDrafted: true } : {}),
                    ...(input.workbench.update === true ? { todoUpdate: true } : {}),
                  }
                : {}),
              ...(input.scheduleSource !== undefined
                ? {
                    scheduleId: input.scheduleSource.scheduleId,
                    scheduleTitle: input.scheduleSource.scheduleTitle,
                  }
                : {}),
              ...(input.todoSource !== undefined
                ? {
                    todoId: input.todoSource.todoId,
                    todoRunId: input.todoSource.todoRunId,
                    todoTitle: input.todoSource.todoTitle,
                  }
                : {}),
            })
          : input.kind === 'card'
            ? JSON.stringify({
                cardType: input.cardType ?? '',
                approvalId: input.approvalId ?? '',
                ...(input.cardRecord === true ? { record: true } : {}),
                ...(input.cardRunId !== undefined ? { runId: input.cardRunId } : {}),
                ...(input.cardDelegationId !== undefined
                  ? { delegationId: input.cardDelegationId }
                  : {}),
                ...(input.cardAppUi !== undefined ? { appUi: input.cardAppUi } : {}),
                ...(input.cardWidget !== undefined ? { widget: input.cardWidget } : {}),
                ...(input.cardPresent !== undefined ? { present: input.cardPresent } : {}),
                ...(input.cardWatch !== undefined
                  ? {
                      watchId: input.cardWatch.watchId,
                      watchEvent: input.cardWatch.watchEvent,
                      ...(input.cardWatch.watchSeq !== undefined
                        ? { watchSeq: input.cardWatch.watchSeq }
                        : {}),
                      ...(input.cardWatch.watchKey !== undefined
                        ? { watchKey: input.cardWatch.watchKey }
                        : {}),
                      ...(input.cardWatch.watchSummary !== undefined
                        ? { watchSummary: input.cardWatch.watchSummary }
                        : {}),
                    }
                  : {}),
                ...(input.cardMail !== undefined
                  ? {
                      mailAccountId: input.cardMail.mailAccountId,
                      mailEvent: input.cardMail.mailEvent,
                      mailKey: input.cardMail.mailKey,
                      ...(input.cardMail.mailUid !== undefined
                        ? { mailUid: input.cardMail.mailUid }
                        : {}),
                      ...(input.cardMail.mailFrom !== undefined
                        ? { mailFrom: input.cardMail.mailFrom }
                        : {}),
                      ...(input.cardMail.mailSubject !== undefined
                        ? { mailSubject: input.cardMail.mailSubject }
                        : {}),
                      ...(input.cardMail.mailDate !== undefined
                        ? { mailDate: input.cardMail.mailDate }
                        : {}),
                      ...(input.cardMail.mailSummary !== undefined
                        ? { mailSummary: input.cardMail.mailSummary }
                        : {}),
                    }
                  : {}),
              })
            : JSON.stringify({
                event: input.event ?? '',
                text: input.text ?? '',
                ...(input.botIds !== undefined ? { botIds: input.botIds } : {}),
                ...(input.internal ? { internal: true } : {}),
                ...(input.relatedBatchId !== undefined ? { batchId: input.relatedBatchId } : {}),
                ...(input.options !== undefined ? { options: input.options } : {}),
                ...(input.questionMode !== undefined && input.questionMode !== 'single'
                  ? { questionMode: input.questionMode }
                  : {}),
                ...(input.questionFields !== undefined
                  ? { questionFields: input.questionFields }
                  : {}),
                ...(input.taskBotId !== undefined ? { taskBotId: input.taskBotId } : {}),
                ...(input.step !== undefined ? { step: input.step } : {}),
                ...(input.route !== undefined ? { route: input.route } : {}),
                ...(input.schedule !== undefined ? { schedule: input.schedule } : {}),
                ...(input.offer !== undefined ? { offer: input.offer } : {}),
                ...(input.handover !== undefined ? { handover: input.handover } : {}),
                ...(input.setting !== undefined ? { setting: input.setting } : {}),
                ...(input.settingResolved !== undefined
                  ? { settingResolved: input.settingResolved }
                  : {}),
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
          'insert into messages (id, conversation_id, seq, sender_type, sender_bot_id, kind, content_json, reply_to, mentions_json, batch_id, run_id, status, created_at, owner_bot_id, task_id) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
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
          ownerBotId,
          taskId,
        );
      // Mid-turn permission cards are not conversation content: advance seq
      // (the row still feeds the bot) but do not move the user's preview time.
      const bumpsPreview =
        ownerBotId === null &&
        !(input.kind === 'card' && isEphemeralApprovalCardType(input.cardType ?? ''));
      if (bumpsPreview) {
        this.db
          .prepare(
            'update conversations set last_seq = ?, last_message_at = max(coalesce(last_message_at, 0), ?) where id = ?',
          )
          .run(seq, now, input.conversationId);
      } else {
        // Private rows (D75 §2.4.3) and mid-turn permission cards advance
        // seq but not last_message_at: the user's conversation order must not
        // move for a row the user never sees.
        this.db
          .prepare('update conversations set last_seq = ? where id = ?')
          .run(seq, input.conversationId);
      }
      for (const attachmentId of input.attachmentIds ?? []) {
        const bound = this.db
          .prepare('update attachments set message_id = ? where id = ?')
          .run(id, attachmentId);
        if (bound.changes !== 1) {
          throw new AppError('INVALID_INPUT', `Attachment ${attachmentId} does not exist`);
        }
      }
      // task_event text is indexed too; per-bot filtering of search results
      // joins messages.owner_bot_id at query time (D75 §2.4.3, W1-B).
      const ftsText =
        input.kind === 'text'
          ? (input.text ?? '')
          : input.kind === 'task_event'
            ? (input.taskEvent?.text ?? '')
            : '';
      if (ftsText.length > 0) {
        this.db
          .prepare(
            'insert into messages_fts (segmented_text, message_id, conversation_id) values (?, ?, ?)',
          )
          .run(segmentForFts(ftsText), id, input.conversationId);
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
        ownerBotId,
        taskId,
      };
    });
    run.immediate();
    if ((input.attachmentIds?.length ?? 0) > 0) {
      message!.attachments = this.attachmentsFor(id);
    }
    return message!;
  }

  /**
   * Writes one private task_event entry (D75 §2.4.1, `sender_type='system'`,
   * owned by the task's bot). Terminal phases (result / failure) are
   * idempotent per task (§3.2, unique index messages_task_terminal): a second
   * terminal write does not throw and returns the existing entry with
   * `created: false`.
   */
  appendTaskEvent(input: AppendTaskEventInput): { message: Message; created: boolean } {
    const terminal = TERMINAL_TASK_EVENT_PHASES.has(input.phase);
    const taskEvent: TaskEventContent = {
      taskId: input.taskId,
      phase: input.phase,
      text: input.text,
      ...(input.sourceMessageIds !== undefined ? { sourceMessageIds: input.sourceMessageIds } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.error !== undefined ? { error: input.error } : {}),
      ...(input.errorReason !== undefined ? { errorReason: input.errorReason } : {}),
      ...(input.delivery !== undefined ? { delivery: input.delivery } : {}),
      ...(input.questionMessageId !== undefined
        ? { questionMessageId: input.questionMessageId }
        : {}),
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.writes !== undefined ? { writes: input.writes } : {}),
      ...(input.continuesTaskId !== undefined ? { continuesTaskId: input.continuesTaskId } : {}),
      ...(input.capabilities !== undefined && input.capabilities.length > 0
        ? { capabilities: input.capabilities }
        : {}),
    };
    const write = this.db.transaction((): { message: Message; created: boolean } => {
      if (terminal) {
        const existing = this.terminalTaskEvent(input.taskId);
        if (existing) return { message: existing, created: false };
      }
      const message = this.append({
        conversationId: input.conversationId,
        senderType: 'system',
        kind: 'task_event',
        ownerBotId: input.ownerBotId,
        taskId: input.taskId,
        taskEvent,
        at: input.at,
      });
      return { message, created: true };
    });
    try {
      return write.immediate();
    } catch (error) {
      // Backstop for a writer outside this transaction (another connection):
      // the unique index still guarantees a single terminal entry.
      if (terminal && isUniqueViolation(error)) {
        const existing = this.terminalTaskEvent(input.taskId);
        if (existing) return { message: existing, created: false };
      }
      throw error;
    }
  }

  /** The task's terminal entry (result / failure), or null (D75 §3.2 recovery). */
  terminalTaskEvent(taskId: string): Message | null {
    const row = this.db
      .prepare(
        `select * from messages where task_id = ? and kind = 'task_event' and json_extract(content_json, '$.phase') in (${TERMINAL_PHASES_SQL}) limit 1`,
      )
      .get(taskId) as MessageRow | undefined;
    return row ? messageRowToMessage(row) : null;
  }

  /** All task_event entries of one task, in seq order. */
  taskEvents(taskId: string): Message[] {
    const rows = this.db
      .prepare("select * from messages where task_id = ? and kind = 'task_event' order by seq")
      .all(taskId) as MessageRow[];
    return rows.map(messageRowToMessage);
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

  /**
   * Every row of the conversation regardless of viewer, private task_event
   * rows of all bots included (D75). Host-internal / test use only: anything
   * that feeds a bot reads `listForBot` / `listShared`, the user UI reads
   * `listVisible` (design 30 §2.4.3).
   */
  list(conversationId: string, options: { beforeSeq?: number; limit?: number } = {}): Message[] {
    return this.#listWhere(conversationId, { sql: '1 = 1', params: [] }, options);
  }

  /**
   * What bot `botId` sees of the conversation (D75 design 30 §2.4.3): shared
   * rows plus its own private rows, by seq. Filtered in SQL so a page holds
   * `limit` rows the bot may see (same paging as `list`).
   */
  listForBot(
    conversationId: string,
    botId: string,
    options: { beforeSeq?: number; limit?: number } = {},
  ): Message[] {
    return this.#listWhere(conversationId, viewerFilter(botId), options);
  }

  /**
   * Shared rows only (`owner_bot_id IS NULL`): what every member may see — a
   * task's conversation layer, the rolling summary, cross-conversation reads.
   */
  listShared(
    conversationId: string,
    options: { beforeSeq?: number; limit?: number } = {},
  ): Message[] {
    return this.#listWhere(conversationId, viewerFilter(null), options);
  }

  #listWhere(
    conversationId: string,
    filter: { sql: string; params: string[] },
    options: { beforeSeq?: number; limit?: number },
  ): Message[] {
    const limit = options.limit ?? 60;
    const params: Array<string | number> = [conversationId, ...filter.params];
    let where = `conversation_id = ? and ${filter.sql}`;
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
    return this.#listWhere(conversationId, userVisibleFilter(), options);
  }

  /**
   * Unread count for the user (D75 §2.4.3): user-visible messages after
   * `afterSeq` (the conversation's last_read_seq). `last_seq - last_read_seq`
   * would count private task_event rows and internal events the user never
   * sees — the renderer marks read up to the last VISIBLE message.
   */
  countVisibleAfter(conversationId: string, afterSeq: number): number {
    const filter = userVisibleFilter();
    const row = this.db
      .prepare(
        `select count(*) as n from messages where conversation_id = ? and seq > ? and ${filter.sql} and ` +
          // D90: the receipt card of a workbench schedule is the user's own action (or the butler's,
          // explained in its chat): visible, but not "unread".
          `not (kind = 'system_event' and coalesce(json_extract(content_json, '$.event'), '') = 'schedule_created' ` +
          `and coalesce(json_extract(content_json, '$.schedule.origin'), '') = 'workbench')`,
      )
      .get(conversationId, afterSeq, ...filter.params) as { n: number };
    return row.n;
  }

  /**
   * Deletes every auto interim status bubble of a task (legacy stacked D54
   * rows). Status now lives on `runs.last_progress` as a single overlay.
   * Returns deleted message ids (caller may push UI removals).
   */
  purgeTaskInterim(taskId: string): string[] {
    const rows = this.db
      .prepare(
        "select id from messages where kind = 'text' and json_extract(content_json, '$.origin') = 'task' and json_extract(content_json, '$.taskId') = ? and coalesce(json_extract(content_json, '$.interim'), 0) = 1",
      )
      .all(taskId) as Array<{ id: string }>;
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const placeholders = ids.map(() => '?').join(', ');
    this.db.prepare(`delete from messages_fts where message_id in (${placeholders})`).run(...ids);
    this.db.prepare(`delete from messages where id in (${placeholders})`).run(...ids);
    return ids;
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
   * Full-text search inside one conversation, as seen by `viewerBotId` (D75
   * §2.4.3: shared rows + the viewer's own private rows; null = shared only).
   * messages_fts indexes task_event text too, so the owner filter joins
   * `messages` at query time. Recalled messages never match (their FTS rows
   * are deleted).
   */
  search(
    conversationId: string,
    query: string,
    options: { viewerBotId: string | null; limit?: number },
  ): Message[] {
    const ftsQuery = buildFtsQuery(query);
    if (!ftsQuery) return [];
    const limit = options.limit ?? 20;
    const viewer = viewerFilter(options.viewerBotId, 'm.');
    const rows = this.db
      .prepare(
        'select m.* from messages_fts f join messages m on m.id = f.message_id ' +
          "where f.conversation_id = ? and messages_fts match ? and m.status != 'recalled' " +
          `and ${viewer.sql} order by m.seq limit ?`,
      )
      .all(conversationId, ftsQuery, ...viewer.params, limit) as MessageRow[];
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
   * 每个会话最后一条可预览的文本消息（conversations.list 随列表一并下发，
   * 左栏启动即有「最后一条消息」预览，不必逐个打开会话）。可见性口径与
   * 渲染端 #noteLastMessage 对齐：text 且未撤回且正文非空。索引
   * messages_conv_seq 让 group by + max(seq) 走一趟索引扫描。
   */
  latestTextByConversation(): Record<string, string> {
    const rows = this.db
      .prepare(
        'select conversation_id, content_json, max(seq) from messages ' +
          // D75 §2.4.3: private rows never become the user's preview.
          "where kind = 'text' and status != 'recalled' and owner_bot_id is null " +
          // trim 的字符集对齐 JS 的 String#trim（ASCII 部分）：纯空白不算预览，
          // 且它被排除后 max(seq) 落到上一条真实文本（与打开会话时的重建一致）。
          "and coalesce(trim(json_extract(content_json, '$.text'), ' \t\n\r'), '') != '' " +
          'group by conversation_id',
      )
      .all() as Array<{ conversation_id: string; content_json: string }>;
    const result: Record<string, string> = {};
    for (const row of rows) {
      const content = JSON.parse(row.content_json) as { text?: string };
      if (typeof content.text === 'string') result[row.conversation_id] = content.text;
    }
    return result;
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

  /**
   * Messages around an anchor as seen by `viewerBotId` (D75 §2.4.3; null =
   * shared only): up to N viewer-visible, non-recalled rows before, the
   * anchor itself (when visible to the viewer), and up to N after, by seq.
   * Rows hidden from the viewer neither appear nor use up the N.
   */
  around(conversationId: string, seq: number, n: number, viewerBotId: string | null): Message[] {
    const viewer = viewerFilter(viewerBotId);
    const base = `conversation_id = ? and status != 'recalled' and ${viewer.sql}`;
    const before = this.db
      .prepare(`select * from messages where ${base} and seq < ? order by seq desc limit ?`)
      .all(conversationId, ...viewer.params, seq, n) as MessageRow[];
    const fromAnchor = this.db
      .prepare(`select * from messages where ${base} and seq >= ? order by seq limit ?`)
      .all(conversationId, ...viewer.params, seq, n + 1) as MessageRow[];
    const anchorAndAfter = fromAnchor[0]?.seq === seq ? fromAnchor : fromAnchor.slice(0, n);
    return [...before.reverse(), ...anchorAndAfter].map(messageRowToMessage);
  }

  setSummary(conversationId: string, summary: string, uptoSeq: number): void {
    this.db
      .prepare('update conversations set summary = ?, summary_upto_seq = ? where id = ?')
      .run(summary, uptoSeq, conversationId);
  }

  /**
   * Loads unsummarized messages (between summary_upto_seq and beforeSeq).
   * Shared rows only (D75 §2.4.3): the rolling summary is one per
   * conversation, read by every member bot — summarizing a private row would
   * leak it.
   */
  unsummarized(conversationId: string, beforeSeq: number): Message[] {
    const rows = this.db
      .prepare(
        "select * from messages where conversation_id = ? and seq > ? and seq <= ? and status != 'recalled' and owner_bot_id is null order by seq",
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
      fileName: r['file_name'] as string,
      mime: r['mime'] as string,
      size: r['size'] as number,
      sha256: r['sha256'] as string,
      relPath: r['rel_path'] as string,
      createdAt: r['created_at'] as number,
    }));
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE'
  );
}
