import { AppError, newId, type Message, type Workdir } from '@kepcup/shared';
import type { SqliteDatabase } from '../infra/db.js';
import type { Clock } from '../infra/clock.js';
import type { CoreLogger } from '../infra/logger.js';
import type {
  ConversationPrincipal,
  ConversationPrincipalRole,
  ConversationsService,
} from '../domain/conversations.js';
import type { MessagesService } from '../domain/messages.js';
import type { Orchestrator } from '../dispatch/orchestrator.js';
import type { WorkdirRuntime } from '../workdir/service.js';
import type { PrincipalDirectory } from './types.js';
import type { CoreEventsMap } from '../start-types.js';

/**
 * 62.11 C15 host write entry (`CoreServices.principalOps`,
 * docs/design/62-team-server/11-core-seams.md). The host process calls these
 * directly (in-process only — no RPC binding is registered): roster writes for
 * dm / project conversations, host-visible system messages and cards, waking a
 * bot with a system event and provisioning a bound workdir. Every method is a
 * no-op for the single-user host simply because the host never calls it.
 */

/** Host card payload (`principalOps.appendCard`); the renderer owns the schema of `data`. */
export interface PrincipalCardInput {
  /** Card type id the host renderer understands (e.g. `resolution`, 62 号 T9). */
  cardType: string;
  /** Folded context / notification line (also what the model sees in context). */
  text?: string;
  /** Card payload (host-defined). Host cards are exactly the rows carrying it. */
  data: Record<string, unknown>;
}

/** Patch for `principalOps.updateCard`; omitted fields keep their stored value. */
export interface PrincipalCardPatch {
  cardType?: string;
  text?: string;
  data?: Record<string, unknown>;
}

export interface PrincipalOpsDeps {
  db: SqliteDatabase;
  clock: Clock;
  logger: CoreLogger;
  conversations: ConversationsService;
  messages: MessagesService;
  /** Publishes `message.created` / `message.updated` / `conversation.updated`. */
  publish: <K extends keyof CoreEventsMap>(event: K, payload: CoreEventsMap[K]) => void;
  /**
   * 62.11 C2 directory (optional): join / leave system messages resolve the
   * principal's display name through it; without one the opaque id is used.
   */
  principals?: PrincipalDirectory;
  /** `#appendSystemMessage` / `deliverEventToBot` capability holder. */
  orchestrator: Orchestrator;
  /** C15 `provisionWorkdir` (creates + binds under the first configured root). */
  workdirRuntime: WorkdirRuntime;
}

/** System event name a `wakeBot` round is triggered with. */
const HOST_WAKE_EVENT = 'host_wake';

/**
 * Fixed C15 contract (README「固定契约」; names must not change). Implemented
 * against the T1 seams: the roster lives in `conversation_principals`
 * (0077), joins / leaves write visible system messages and every write path
 * publishes the conversation update so open clients stay in sync.
 */
export class PrincipalOps {
  readonly #deps: PrincipalOpsDeps;

  constructor(deps: PrincipalOpsDeps) {
    this.#deps = deps;
  }

  /** Display entry of a principal, falling back to the opaque id. */
  #nameOf(principalId: string): string {
    return this.#deps.principals?.describe(principalId)?.name || principalId;
  }

  #requireRosterConversation(conversationId: string, action: string): void {
    const conversation = this.#deps.conversations.getOrThrow(conversationId);
    // The roster table only backs dm / project conversations (62.11 C3): a
    // direct chat's single principal lives in `owner_principal_id` instead.
    if (conversation.type !== 'project' && conversation.type !== 'dm') {
      throw new AppError(
        'INVALID_INPUT',
        `${action}只适用于项目组或主体私信（dm）会话：${conversationId} 是 ${conversation.type}`,
      );
    }
  }

  /** Marks the row active again (or creates it) and announces the join. */
  join(conversationId: string, principalId: string, role: ConversationPrincipalRole): void {
    this.#requireRosterConversation(conversationId, '加入会话');
    const id = principalId.trim();
    if (id.length === 0) throw new AppError('INVALID_INPUT', '缺少主体 id');
    if (this.#deps.conversations.hasPrincipal(conversationId, id)) {
      throw new AppError('INVALID_INPUT', '主体已在本会话中');
    }
    const now = this.#deps.clock.now();
    this.#deps.db
      .prepare(
        `insert into conversation_principals (conversation_id, principal_id, role, joined_at, left_at)
         values (?, ?, ?, ?, null)
         on conflict(conversation_id, principal_id) do update set
           role = excluded.role, joined_at = excluded.joined_at, left_at = null`,
      )
      .run(conversationId, id, role, now);
    this.#deps.logger.info({ conversationId, principalId: id, role }, 'principal joined');
    this.#deps.orchestrator.appendHostSystemMessage(conversationId, `${this.#nameOf(id)} 已加入`);
  }

  /** Writes `left_at` (the row stays for audit trails) and announces the leave. */
  leave(conversationId: string, principalId: string): void {
    this.#requireRosterConversation(conversationId, '离开会话');
    const id = principalId.trim();
    const result = this.#deps.db
      .prepare(
        'update conversation_principals set left_at = ? where conversation_id = ? and principal_id = ? and left_at is null',
      )
      .run(this.#deps.clock.now(), conversationId, id);
    if (result.changes === 0) return;
    this.#deps.logger.info({ conversationId, principalId: id }, 'principal left');
    this.#deps.orchestrator.appendHostSystemMessage(conversationId, `${this.#nameOf(id)} 已离开`);
  }

  /** Updates the role of an active principal; inactive rows are not resurrected. */
  setRole(conversationId: string, principalId: string, role: ConversationPrincipalRole): void {
    this.#requireRosterConversation(conversationId, '设置会话角色');
    const result = this.#deps.db
      .prepare(
        'update conversation_principals set role = ? where conversation_id = ? and principal_id = ? and left_at is null',
      )
      .run(role, conversationId, principalId.trim());
    if (result.changes === 0) {
      throw new AppError('NOT_FOUND', '主体不在本会话的在册名单中');
    }
    this.#deps.publish('conversation.updated', {
      conversation: this.#deps.conversations.getOrThrow(conversationId),
    });
  }

  /** Active (not left) principals of the conversation, in join order. */
  list(conversationId: string): ConversationPrincipal[] {
    return this.#deps.conversations.principals(conversationId);
  }

  /** Whether the principal is an active participant (left rows excluded). */
  hasPrincipal(conversationId: string, principalId: string): boolean {
    return this.#deps.conversations.hasPrincipal(conversationId, principalId);
  }

  /** Reuses the T1 dm opener (existing dm reused, otherwise created). */
  openDm(principalIds: string[]): { conversationId: string; created: boolean } {
    const { conversation, created } = this.#deps.conversations.openDm(principalIds);
    return { conversationId: conversation.id, created };
  }

  /** Host-written system message (`host_notice`, user-visible). */
  appendSystemMessage(conversationId: string, text: string): Message {
    return this.#deps.orchestrator.appendHostSystemMessage(conversationId, text);
  }

  /**
   * Appends a host card message (`kind: 'card'`, `cardType` + `data`) and
   * publishes `message.created`. The row layout mirrors the messages-service
   * card rows (seq / preview bump); the payload is host-defined, so the write
   * stays in this seam instead of growing a generic slot on MessagesService.
   */
  appendCard(conversationId: string, card: PrincipalCardInput): Message {
    const now = this.#deps.clock.now();
    const id = newId('msg');
    const created: { message: Message | null } = { message: null };
    const run = this.#deps.db.transaction(() => {
      const row = this.#deps.db
        .prepare('select last_seq from conversations where id = ?')
        .get(conversationId) as { last_seq: number } | undefined;
      if (row === undefined) {
        throw new AppError('NOT_FOUND', `Conversation ${conversationId} does not exist`);
      }
      const seq = row.last_seq + 1;
      // Content shape: a `card` row whose payload rides the schema-known
      // `hostCard` slot (shared cardContentSchema) — a bare top-level `text`
      // would make the message parse as a text row and lose the payload.
      const contentJson = JSON.stringify({
        cardType: card.cardType,
        hostCard: {
          ...(card.text !== undefined ? { text: card.text } : {}),
          data: card.data,
        },
      });
      this.#deps.db
        .prepare(
          "insert into messages (id, conversation_id, seq, sender_type, sender_bot_id, kind, content_json, reply_to, mentions_json, batch_id, run_id, status, created_at, owner_bot_id, task_id, sender_principal_id, sender_name) values (?, ?, ?, 'system', null, 'card', ?, null, '[]', null, null, 'normal', ?, null, null, null, null)",
        )
        .run(id, conversationId, seq, contentJson, now);
      // A host card is conversation content: advance seq and the preview time
      // (mirrors messages.append for non-ephemeral cards).
      this.#deps.db
        .prepare(
          'update conversations set last_seq = ?, last_message_at = max(coalesce(last_message_at, 0), ?) where id = ?',
        )
        .run(seq, now, conversationId);
      created.message = {
        id,
        conversationId,
        seq,
        senderType: 'system',
        senderBotId: null,
        kind: 'card',
        content: JSON.parse(contentJson) as Message['content'],
        replyTo: null,
        mentions: [],
        attachments: [],
        batchId: null,
        runId: null,
        status: 'normal',
        editedAt: null,
        createdAt: now,
        ownerBotId: null,
        taskId: null,
        senderPrincipalId: null,
        senderName: null,
      } as Message;
    });
    run.immediate();
    const message = created.message;
    if (message === null) {
      throw new AppError('INTERNAL', '宿主卡片写入失败（事务未产出消息行）');
    }
    this.#deps.publish('message.created', { conversationId, message });
    this.#deps.publish('conversation.updated', {
      conversation: this.#deps.conversations.getOrThrow(conversationId),
    });
    return message;
  }

  /**
   * Patches a host card row (`json_set` like the settings-card precedent,
   * settings/host.ts) and publishes `message.updated`. Only rows this seam
   * wrote (host cards carry the `hostCard` slot) can be patched.
   */
  updateCard(messageId: string, patch: PrincipalCardPatch): Message {
    const existing = this.#deps.messages.getById(messageId);
    const content = existing?.content as
      | { cardType?: unknown; hostCard?: { text?: string; data: Record<string, unknown> } }
      | undefined;
    if (
      existing === null ||
      existing.kind !== 'card' ||
      existing.senderType !== 'system' ||
      content?.hostCard === undefined
    ) {
      throw new AppError('NOT_FOUND', '找不到可更新的宿主卡片');
    }
    const nextCardType =
      patch.cardType !== undefined ? patch.cardType : String(content.cardType ?? '');
    const nextText = patch.text !== undefined ? patch.text : content.hostCard.text;
    const nextData = patch.data !== undefined ? patch.data : content.hostCard.data;
    const contentJson = JSON.stringify({
      cardType: nextCardType,
      hostCard: {
        ...(nextText !== undefined ? { text: nextText } : {}),
        data: nextData,
      },
    });
    this.#deps.db
      .prepare('update messages set content_json = ? where id = ?')
      .run(contentJson, messageId);
    const updated = this.#deps.messages.getById(messageId);
    if (updated === null) throw new AppError('NOT_FOUND', `Message ${messageId} does not exist`);
    this.#deps.publish('message.updated', {
      conversationId: updated.conversationId,
      message: updated,
    });
    return updated;
  }

  /**
   * Triggers a bot round with a system event (`host_wake` + the host's text),
   * preserving `deliverEventToBot` semantics: member / read-only / quiet-hours
   * handling included (a quiet-hours delivery is parked to the quiet end).
   */
  wakeBot(conversationId: string, botId: string, eventText: string): void {
    this.#deps.orchestrator.deliverEventToBot(botId, conversationId, HOST_WAKE_EVENT, eventText);
  }

  /** Creates a directory under the first workdir root and binds it (C9). */
  provisionWorkdir(conversationId: string, name: string): Workdir {
    return this.#deps.workdirRuntime.provisionWorkdir(conversationId, name);
  }
}
