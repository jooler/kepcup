import {
  buildNewMessagesInjection,
  buildMessageEventInjection,
  type RenderMessageOptions,
} from '../agent/context/conversation.js';
import type { Message } from '@kepcup/shared';

export interface TriggerBatch {
  conversationId: string;
  botId: string;
  messages: Message[];
  /** 'delegation'（D71）：A 代用户转交给 B 的任务（B 私聊里的代发消息）。 */
  reason:
    | 'direct'
    | 'mention'
    | 'broadcast'
    | 'reply'
    | 'chain'
    | 'scheduled'
    | 'event'
    | 'delegation';
  extraAttributes?: Record<string, string | number>;
  /** Bot-to-bot @ chain binding (P05): stored on the created run. */
  chain?: { id: string; depth: number };
  /**
   * Sequential group-response hint appended after the trigger segment
   * ("在你之前，X 已经回复…", docs/dev/04-agent-runtime.md "触发段").
   */
  afterNote?: string;
}

export interface MailboxHooks {
  /** No loop is running for this mailbox: start one with this batch. */
  startRun(batch: TriggerBatch): string | null;
  /** A loop is running: inject the formatted batch into it. */
  steer(batch: TriggerBatch, text: string): string | null;
  /** A loop is running: inject an edit notice. */
  injectEvent(batch: TriggerBatch, text: string): void;
  renderOptions(): RenderMessageOptions;
}

/**
 * One mailbox per "Bot + conversation" (docs/design/02-execution.md): at most
 * one response loop at a time; batches arriving mid-run are injected via
 * steer instead of spawning a second loop.
 */
export class Mailbox {
  readonly #key: string;
  readonly #hooks: MailboxHooks;
  #running = false;

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

  /**
   * Delivers the batch; returns the id of the run that absorbed it (the fresh
   * run, or the running one it was steered into), null when buffered.
   */
  deliver(batch: TriggerBatch): string | null {
    if (batch.messages.length === 0) return null;
    if (!this.#running) {
      this.#running = true;
      return this.#hooks.startRun(batch);
    }
    return this.#hooks.steer(
      batch,
      buildNewMessagesInjection(batch.messages, this.#hooks.renderOptions()),
    );
  }

  /** Edit of a message the running loop has already seen. */
  injectMessageEvent(input: {
    conversationId: string;
    botId: string;
    type: 'edited';
    messageId: string;
    newText?: string | undefined;
  }): boolean {
    if (!this.#running) return false;
    this.#hooks.injectEvent(
      {
        conversationId: input.conversationId,
        botId: input.botId,
        messages: [],
        reason: 'event',
      },
      buildMessageEventInjection(input),
    );
    return true;
  }

  /** The run loop finished; the next batch will start a new run. */
  release(): void {
    this.#running = false;
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
}
