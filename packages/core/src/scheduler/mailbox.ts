import type { Message } from '@kepcup/shared';

export type TriggerReason =
  | 'direct'
  | 'mention'
  | 'broadcast'
  | 'reply'
  | 'chain'
  | 'scheduled'
  | 'event'
  /** 'delegation'（D71）：A 代用户转交给 B 的任务（B 私聊里的代发消息）。 */
  | 'delegation'
  /** D75 §3.2：任务结算条目（result / failure）唤醒 Bot。 */
  | 'task';

/** One source batch of a merged trigger (its own `<trigger>` segment). */
export interface TriggerPart {
  reason: TriggerReason;
  messages: Message[];
  extraAttributes?: Record<string, string | number>;
}

export interface TriggerBatch {
  conversationId: string;
  botId: string;
  /** Every trigger message of the turn (all parts, de-duplicated, seq order). */
  messages: Message[];
  /** The turn's trigger reason (a merged batch: its most user-facing part's). */
  reason: TriggerReason;
  extraAttributes?: Record<string, string | number>;
  /**
   * Batches buffered while the previous turn ran, merged into this one on
   * release (D75 design 30 §3.2 / §10.2): each keeps its own reason and
   * attributes in the trigger segment. Absent for a single batch.
   */
  parts?: TriggerPart[];
  /** Bot-to-bot @ chain binding (P05): stored on the created run. */
  chain?: { id: string; depth: number };
  /**
   * Sequential group-response hint appended after the trigger segment
   * ("在你之前，X 已经回复…", docs/dev/04-agent-runtime.md "触发段").
   */
  afterNote?: string;
}

/** Reasons where a user is waiting on the reply (scheduler priority 0). */
const USER_FACING_REASONS: ReadonlySet<TriggerReason> = new Set([
  'direct',
  'mention',
  'reply',
  'broadcast',
  'delegation',
  'task',
]);

export function isUserFacingReason(reason: TriggerReason): boolean {
  return USER_FACING_REASONS.has(reason);
}

/** The source batches of a (possibly merged) trigger batch. */
export function triggerParts(batch: TriggerBatch): TriggerPart[] {
  return (
    batch.parts ?? [
      {
        reason: batch.reason,
        messages: batch.messages,
        ...(batch.extraAttributes !== undefined ? { extraAttributes: batch.extraAttributes } : {}),
      },
    ]
  );
}

/**
 * Merges the batches buffered during a turn into the next turn's one batch
 * (D75 design 30 §3.2: tasks settling together wake a single turn). Parts
 * with the same reason and attributes collapse into one; a message shows up
 * once, in the first part that carried it. The turn's reason is the first
 * user-facing part's (else the first part's); the chain binding is the first
 * chained batch's; the group-order hint is the latest one.
 */
export function mergeTriggerBatches(batches: TriggerBatch[]): TriggerBatch {
  const first = batches[0];
  if (first === undefined) throw new Error('mergeTriggerBatches: no batches');
  if (batches.length === 1) return first;
  const seen = new Set<string>();
  const parts: TriggerPart[] = [];
  const partByKey = new Map<string, TriggerPart>();
  for (const batch of batches) {
    for (const part of triggerParts(batch)) {
      const fresh = part.messages.filter((message) => !seen.has(message.id));
      if (fresh.length === 0) continue;
      for (const message of fresh) seen.add(message.id);
      const key = `${part.reason}\u0000${JSON.stringify(part.extraAttributes ?? {})}`;
      const existing = partByKey.get(key);
      if (existing !== undefined) {
        existing.messages = [...existing.messages, ...fresh].sort((a, b) => a.seq - b.seq);
        continue;
      }
      const merged: TriggerPart = {
        reason: part.reason,
        messages: fresh,
        ...(part.extraAttributes !== undefined ? { extraAttributes: part.extraAttributes } : {}),
      };
      partByKey.set(key, merged);
      parts.push(merged);
    }
  }
  const primary = parts.find((part) => isUserFacingReason(part.reason)) ?? parts[0];
  const chain = batches.find((batch) => batch.chain !== undefined)?.chain;
  const afterNote = [...batches].reverse().find((batch) => batch.afterNote !== undefined)?.afterNote;
  return {
    conversationId: first.conversationId,
    botId: first.botId,
    messages: parts.flatMap((part) => part.messages).sort((a, b) => a.seq - b.seq),
    reason: primary?.reason ?? first.reason,
    ...(parts.length > 1 ? { parts } : {}),
    ...(parts.length === 1 && parts[0]?.extraAttributes !== undefined
      ? { extraAttributes: parts[0].extraAttributes }
      : {}),
    ...(chain !== undefined ? { chain } : {}),
    ...(afterNote !== undefined ? { afterNote } : {}),
  };
}

export interface MailboxHooks {
  /** No turn is running for this mailbox: start one with this batch. */
  startRun(batch: TriggerBatch): string | null;
}

/**
 * One mailbox per "Bot + conversation": the supervisor-turn serializer (D75
 * design 30 §2.1 / D2 revised). At most one turn at a time; batches arriving
 * while a turn runs are never steered into it — they are buffered and merged
 * into the next turn when the running one releases the mailbox, so the bot
 * decides about them with the whole picture (answer, start / inject / cancel
 * a task).
 */
export class Mailbox {
  readonly #key: string;
  readonly #hooks: MailboxHooks;
  #running = false;
  #buffer: TriggerBatch[] = [];

  constructor(key: string, hooks: MailboxHooks) {
    this.#key = key;
    this.#hooks = hooks;
  }

  get id(): string {
    return this.#key;
  }

  get isRunning(): boolean {
    return this.#running;
  }

  /** Batches waiting for the next turn. */
  get bufferedCount(): number {
    return this.#buffer.length;
  }

  /**
   * Delivers the batch: starts a turn when idle (returns its run id), else
   * buffers it for the next turn (returns null).
   */
  deliver(batch: TriggerBatch): string | null {
    if (batch.messages.length === 0) return null;
    if (this.#running) {
      this.#buffer.push(batch);
      return null;
    }
    this.#running = true;
    try {
      return this.#hooks.startRun(batch);
    } catch (error) {
      this.#running = false;
      throw error;
    }
  }

  /**
   * The user edited a message the running turn already saw: the edited
   * message reaches the next turn as an `event` trigger (`message_edited`).
   * False when no turn is running (the caller triggers a fresh turn).
   */
  bufferMessageEdit(input: { conversationId: string; botId: string; message: Message }): boolean {
    if (!this.#running) return false;
    this.#buffer.push({
      conversationId: input.conversationId,
      botId: input.botId,
      messages: [input.message],
      reason: 'event',
      extraAttributes: { event: 'message_edited' },
    });
    return true;
  }

  /**
   * The turn reached its terminal state. Buffered batches start the next
   * turn right away, merged into one batch; returns that turn's run id.
   */
  release(): string | null {
    this.#running = false;
    if (this.#buffer.length === 0) return null;
    const merged = mergeTriggerBatches(this.#buffer.splice(0));
    return this.deliver(merged);
  }

  /** Drops the buffered batches (conversation / bot teardown). */
  clear(): void {
    this.#buffer = [];
  }
}

/** Registry of mailboxes keyed by `botId:conversationId`. */
export class MailboxRegistry {
  readonly #mailboxes = new Map<string, Mailbox>();

  constructor(private readonly factory: (key: string) => Mailbox) {}

  for(botId: string, conversationId: string): Mailbox {
    const key = `${botId}:${conversationId}`;
    let mailbox = this.#mailboxes.get(key);
    if (!mailbox) {
      mailbox = this.factory(key);
      this.#mailboxes.set(key, mailbox);
    }
    return mailbox;
  }

  get(botId: string, conversationId: string): Mailbox | null {
    return this.#mailboxes.get(`${botId}:${conversationId}`) ?? null;
  }

  /** Clears the buffers of every mailbox matching the filter (teardown). */
  clearWhere(filter: { botId?: string; conversationId?: string }): void {
    for (const [key, mailbox] of this.#mailboxes) {
      const separator = key.indexOf(':');
      const botId = key.slice(0, separator);
      const conversationId = key.slice(separator + 1);
      if (filter.botId !== undefined && filter.botId !== botId) continue;
      if (filter.conversationId !== undefined && filter.conversationId !== conversationId) continue;
      mailbox.clear();
    }
  }
}
