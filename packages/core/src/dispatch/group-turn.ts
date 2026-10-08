import { type Message, type Run } from '@kepcup/shared';
import type { TriggerBatch } from '../scheduler/mailbox.js';
import type { ConversationsService } from '../domain/conversations.js';
import type { BotsService } from '../domain/bots.js';
import type { MessagesService } from '../domain/messages.js';
import type { CoreLogger } from '../infra/logger.js';
import type { CoreEventsMap } from '../start-types.js';
import {
  explicitTargets,
  sortResponders,
  type DispatchTarget,
  type TriageDecisionValue,
} from './dispatcher.js';

export interface GroupTurnDeps {
  conversations: ConversationsService;
  bots: BotsService;
  messages: MessagesService;
  clock: { now(): number };
  logger: CoreLogger;
  timeZone: string;
  /**
   * Hands a batch to the target bot's mailbox. Returns the id of the run that
   * absorbed the batch (fresh run or an already-running one it was steered
   * into), or null when it was buffered for a later run.
   */
  deliver(batch: TriggerBatch): string | null;
  isMailboxRunning(botId: string, conversationId: string): boolean;
  /** Appends + publishes a system message; returns it. */
  appendSystemMessage(input: {
    conversationId: string;
    event: string;
    text: string;
    botIds?: string[];
    batchId?: string | null;
  }): Message;
  publish<K extends keyof CoreEventsMap>(event: K, payload: CoreEventsMap[K]): void;
  /** Runs one bot's triage decision through the scheduler (parallel). */
  triage(input: {
    botId: string;
    conversationId: string;
    batchId: string;
    batchMessages: Message[];
  }): Promise<{ botId: string; decision: TriageDecisionValue; confidence: number }>;
  /** Test override of TRIAGE_TIMEOUT_MS. */
  triageTimeoutMs?: number;
}

interface Turn {
  conversationId: string;
  batchId: string;
  messages: Message[];
  targets: DispatchTarget[];
  index: number;
  /**
   * The exact run the current target's batch was delivered to; only its
   * terminal state advances the turn (BR-P05-002: a same-bot chain run must
   * not advance it). Null only in the rare buffered-steer window, where the
   * fallback matches by bot id.
   */
  awaitingRunId: string | null;
  /**
   * The target's mailbox was busy (foreign run, e.g. a chain): the turn waits
   * for onMailboxIdle so the batch lands as its own run, not a steer.
   */
  awaitingIdle: boolean;
  /** Bot ids whose execution already finished inside this turn. */
  executed: string[];
  /** Display name of the most recent bot that actually replied. */
  lastReplier: string | null;
}

interface PendingBatch {
  batchId: string;
  messages: Message[];
  /** groups.redistribute click: force this single target. */
  forcedTarget?: string;
}

/**
 * Group-chat dispatch (docs/dev/phases/P05-group-chat.md): one conversation
 * holds at most one round ("轮次") — an ordered list of targets delivered one
 * after another, each only after the previous bot's supervisor turn reached a
 * terminal state (D75 design 30 §6.2: a round never waits for the tasks a turn
 * started; tasks take no part in rounds). Batches flushed mid-round go to the
 * running bot's mailbox right away (it handles them in its next turn) and are
 * re-dispatched after the round; bots already handed a batch are not
 * re-triggered for it. Removed/deleted members are skipped, their runs cancelled.
 */
export class GroupTurnCoordinator {
  readonly #deps: GroupTurnDeps;
  readonly #turns = new Map<string, Turn>();
  readonly #pending = new Map<string, PendingBatch[]>();
  /** `${conversationId}:${batchId}` -> bots injected with that batch mid-run. */
  readonly #injected = new Map<string, Set<string>>();
  readonly #triaging = new Set<string>();

  constructor(deps: GroupTurnDeps) {
    this.#deps = deps;
  }

  /** A flushed user batch in a group conversation. */
  onUserBatch(conversationId: string, batchId: string, messages: Message[]): void {
    const turn = this.#turns.get(conversationId);
    if (turn) {
      const current = turn.targets[turn.index];
      if (current) this.#injectIntoRunning(conversationId, batchId, current.botId, messages);
      this.#enqueuePending(conversationId, { batchId, messages });
      this.#publishTurnState(conversationId);
      return;
    }
    if (this.#triaging.has(conversationId)) {
      this.#enqueuePending(conversationId, { batchId, messages });
      this.#publishTurnState(conversationId);
      return;
    }
    this.#dispatch(conversationId, { batchId, messages });
  }

  /** Silent-message click: re-dispatch the original batch as an explicit @. */
  redistribute(conversationId: string, batchId: string, botId: string): void {
    const messages = this.#deps.messages.listByBatch(batchId).filter((m) => m.status !== 'recalled');
    if (messages.length === 0) return;
    const turn = this.#turns.get(conversationId);
    if (turn) {
      const current = turn.targets[turn.index];
      if (current) this.#injectIntoRunning(conversationId, batchId, current.botId, messages);
      this.#enqueuePending(conversationId, { batchId, messages, forcedTarget: botId });
      this.#publishTurnState(conversationId);
      return;
    }
    if (this.#triaging.has(conversationId)) {
      this.#enqueuePending(conversationId, { batchId, messages, forcedTarget: botId });
      this.#publishTurnState(conversationId);
      return;
    }
    this.#dispatch(conversationId, { batchId, messages, forcedTarget: botId });
  }

  /**
   * Terminal state of a run; drives turn advancement (any status advances).
   * Only the exact run the turn delivered to advances it (BR-P05-002).
   */
  onRunSettled(run: Run): void {
    if (run.conversationId === null || run.botId === null) return;
    const turn = this.#turns.get(run.conversationId);
    if (!turn) return;
    if (turn.awaitingRunId !== null) {
      if (run.id !== turn.awaitingRunId) return;
    } else if (turn.awaitingIdle) {
      // Nothing delivered yet; the mailbox-idle hook drives from here.
      return;
    } else {
      // Defensive fallback (buffered-steer window): match by bot id.
      const target = turn.targets[turn.index];
      if (!target || target.botId !== run.botId) return;
    }
    turn.executed.push(run.botId);
    if (run.status === 'completed' && run.outputMessageIds.length > 0) {
      turn.lastReplier = this.#botName(run.botId);
    }
    this.#completeCurrent(turn);
  }

  /**
   * The current target's mailbox became free (BR-P05-002): deliver the turn's
   * batch now as a fresh run instead of having steered it into a foreign one.
   */
  onMailboxIdle(botId: string, conversationId: string): void {
    const turn = this.#turns.get(conversationId);
    if (!turn || !turn.awaitingIdle) return;
    const target = turn.targets[turn.index];
    if (!target || target.botId !== botId) return;
    if (this.#deps.isMailboxRunning(botId, conversationId)) return; // re-buffered delivery
    if (!this.#isDispatchable(conversationId, botId)) {
      // Removed while waiting: skip like a settled (cancelled) run would.
      this.#completeCurrent(turn);
      return;
    }
    this.#deliverToTarget(turn, target);
  }

  /** A member was removed (or its bot deleted): drop it from the queue. */
  onMemberRemoved(conversationId: string, botId: string): void {
    const turn = this.#turns.get(conversationId);
    if (turn) {
      // The CURRENT target stays in place: its run settles (aborted or not)
      // and the advancement skips it via the membership check — removing it
      // here would shift indices and orphan the awaited settle.
      const current = turn.targets[turn.index];
      if (!current || current.botId !== botId) {
        turn.targets = turn.targets.filter((t) => t.botId !== botId);
      }
      this.#publishTurnState(conversationId);
    }
  }

  /**
   * The conversation is being deleted / aborted: drop every trace so terminal
   * states and async triage completions cannot advance, deliver or enqueue
   * anything afterwards (BR-P05-001). Must run BEFORE runs are aborted.
   */
  clear(conversationId: string): void {
    this.#turns.delete(conversationId);
    this.#pending.delete(conversationId);
    this.#triaging.delete(conversationId);
    for (const key of [...this.#injected.keys()]) {
      if (key.startsWith(`${conversationId}:`)) this.#injected.delete(key);
    }
    this.#publishTurnState(conversationId);
  }

  /** Current turn state for queries (same payload as the group.turn event). */
  stateOf(conversationId: string): {
    conversationId: string;
    batchId: string | null;
    phase: 'triaging' | 'running' | 'idle';
    currentBotId: string | null;
    queue: string[];
    pendingBatches: number;
  } {
    const turn = this.#turns.get(conversationId);
    return {
      conversationId,
      batchId: turn?.batchId ?? null,
      phase: turn ? 'running' : this.#triaging.has(conversationId) ? 'triaging' : 'idle',
      currentBotId: turn?.targets[turn.index]?.botId ?? null,
      queue: turn ? turn.targets.slice(turn.index + 1).map((t) => t.botId) : [],
      pendingBatches: this.#pending.get(conversationId)?.length ?? 0,
    };
  }

  // --- internals -------------------------------------------------------------

  #dispatch(conversationId: string, pending: PendingBatch): void {
    const members = this.#activeMembers(conversationId);
    if (pending.forcedTarget !== undefined) {
      // Same no-repeat rule as explicit targets: a bot already injected with
      // this batch mid-run is not re-triggered (BR-P05-006).
      const alreadyInjected = this.#injected.get(this.#injectedKey(conversationId, pending.batchId))?.has(pending.forcedTarget) ?? false;
      if (members.has(pending.forcedTarget) && !alreadyInjected) {
        this.#startTurn(conversationId, pending.batchId, pending.messages, [
          { botId: pending.forcedTarget, reason: 'mention' },
        ]);
      } else {
        this.#publishTurnState(conversationId);
      }
      return;
    }
    const exclude = this.#injected.get(this.#injectedKey(conversationId, pending.batchId)) ?? new Set<string>();
    const targets = explicitTargets(pending.messages, members, (id) =>
      this.#deps.messages.getById(id),
    ).filter((t) => !exclude.has(t.botId));
    if (targets.length > 0) {
      this.#startTurn(conversationId, pending.batchId, pending.messages, targets);
      return;
    }
    this.#startTriage(conversationId, pending, members);
  }

  #startTriage(conversationId: string, pending: PendingBatch, members: Set<string>): void {
    const exclude =
      this.#injected.get(this.#injectedKey(conversationId, pending.batchId)) ?? new Set<string>();
    const candidates = [...members].filter((botId) => !exclude.has(botId));
    this.#triaging.add(conversationId);
    this.#publishTurnState(conversationId);
    if (candidates.length === 0) {
      this.#finishTriage(conversationId, pending, []);
      return;
    }
    let settled = 0;
    const decisions: Array<{ botId: string; decision: TriageDecisionValue; confidence: number }> = [];
    for (const botId of candidates) {
      this.#deps
        .triage({
          botId,
          conversationId,
          batchId: pending.batchId,
          batchMessages: pending.messages,
        })
        .then((decision) => {
          decisions.push(decision);
        })
        .catch((error) => {
          // triageOneBot never rejects; keep this belt-and-braces.
          this.#deps.logger.warn(
            { botId, error: error instanceof Error ? error.message : String(error) },
            'triage dispatch failed',
          );
        })
        .finally(() => {
          settled += 1;
          if (settled === candidates.length) {
            this.#finishTriage(conversationId, pending, decisions);
          }
        });
    }
  }

  #finishTriage(
    conversationId: string,
    pending: PendingBatch,
    decisions: Array<{ botId: string; decision: TriageDecisionValue; confidence: number }>,
  ): void {
    // Cleared mid-flight (conversation deleted): never touch it again
    // (BR-P05-001) — no turns, no system messages, no further dispatch.
    if (!this.#triaging.has(conversationId)) return;
    this.#triaging.delete(conversationId);
    const responders = sortResponders(
      decisions.filter((d): d is typeof d & { decision: 'respond' } => d.decision === 'respond'),
    );
    if (responders.length > 0) {
      this.#startTurn(
        conversationId,
        pending.batchId,
        pending.messages,
        responders.map((r) => ({ botId: r.botId, reason: 'broadcast' as const })),
      );
      return;
    }
    if (decisions.some((d) => d.decision === 'not_mine')) {
      const members = [...this.#activeMembers(conversationId)];
      this.#deps.appendSystemMessage({
        conversationId,
        event: 'group_no_claim',
        text: '没有 Bot 认领这条消息，请指定一个 Bot',
        botIds: members,
        batchId: pending.batchId,
      });
    }
    this.#publishTurnState(conversationId);
    this.#drainPending(conversationId);
  }

  #startTurn(
    conversationId: string,
    batchId: string,
    messages: Message[],
    targets: DispatchTarget[],
  ): void {
    const turn: Turn = {
      conversationId,
      batchId,
      messages,
      targets,
      index: -1,
      awaitingRunId: null,
      awaitingIdle: false,
      executed: [],
      lastReplier: null,
    };
    this.#turns.set(conversationId, turn);
    this.#advance(turn);
  }

  #advance(turn: Turn): void {
    turn.index += 1;
    while (turn.index < turn.targets.length) {
      const candidate = turn.targets[turn.index];
      if (candidate && this.#isDispatchable(turn.conversationId, candidate.botId)) break;
      turn.index += 1;
    }
    const target = turn.targets[turn.index];
    if (!target) {
      this.#endTurn(turn);
      return;
    }
    if (this.#deps.isMailboxRunning(target.botId, turn.conversationId)) {
      // A foreign run (e.g. a chain triggered mid-turn) holds the mailbox:
      // wait for it to end so the batch lands as its own run (BR-P05-002)
      // instead of being steered into that run.
      turn.awaitingIdle = true;
      this.#publishTurnState(turn.conversationId);
      return;
    }
    this.#deliverToTarget(turn, target);
  }

  #deliverToTarget(turn: Turn, target: DispatchTarget): void {
    turn.awaitingIdle = false;
    const afterNote =
      turn.lastReplier !== null
        ? `在你之前，${turn.lastReplier}已经回复（见最近消息）。如果你没有需要补充的，调用 skip_reply。`
        : undefined;
    turn.awaitingRunId = this.#deps.deliver({
      conversationId: turn.conversationId,
      botId: target.botId,
      messages: turn.messages,
      reason: target.reason,
      ...(afterNote !== undefined ? { afterNote } : {}),
    });
    this.#publishTurnState(turn.conversationId);
  }

  #completeCurrent(turn: Turn): void {
    turn.awaitingRunId = null;
    turn.awaitingIdle = false;
    this.#advance(turn);
  }

  #endTurn(turn: Turn): void {
    this.#turns.delete(turn.conversationId);
    this.#publishTurnState(turn.conversationId);
    this.#drainPending(turn.conversationId);
  }

  #drainPending(conversationId: string): void {
    if (this.#turns.has(conversationId) || this.#triaging.has(conversationId)) return;
    const queue = this.#pending.get(conversationId);
    const next = queue?.shift();
    if (next) this.#dispatch(conversationId, next);
  }

  #enqueuePending(conversationId: string, pending: PendingBatch): void {
    const queue = this.#pending.get(conversationId) ?? [];
    queue.push(pending);
    this.#pending.set(conversationId, queue);
  }

  /**
   * Copy of a fresh batch for the bot currently executing in a round: it waits
   * in that bot's mailbox and is merged into its next supervisor turn (D75 —
   * turns are never steered).
   */
  #injectIntoRunning(
    conversationId: string,
    batchId: string,
    botId: string,
    messages: Message[],
  ): void {
    const key = this.#injectedKey(conversationId, batchId);
    const injected = this.#injected.get(key) ?? new Set<string>();
    injected.add(botId);
    this.#injected.set(key, injected);
    this.#deps.deliver({ conversationId, botId, messages, reason: 'broadcast' });
  }

  #injectedKey(conversationId: string, batchId: string): string {
    return `${conversationId}:${batchId}`;
  }

  #activeMembers(conversationId: string): Set<string> {
    const members = new Set<string>();
    for (const botId of this.#deps.conversations.memberBotIds(conversationId)) {
      const bot = this.#deps.bots.get(botId);
      if (bot && bot.status === 'active') members.add(botId);
    }
    return members;
  }

  #isDispatchable(conversationId: string, botId: string): boolean {
    return this.#activeMembers(conversationId).has(botId);
  }

  #botName(botId: string): string {
    const bot = this.#deps.bots.get(botId);
    return bot ? bot.profile.identity.name || bot.name : botId;
  }

  #publishTurnState(conversationId: string): void {
    this.#deps.publish('group.turn', this.stateOf(conversationId));
  }
}
