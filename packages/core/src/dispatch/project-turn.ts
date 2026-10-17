import { type Message, type Run } from '@kepcup/shared';
import {
  ROUTING_CONTINUATION_MIN_CONFIDENCE,
  ROUTING_CONTINUATION_WINDOW_MS,
  ROUTING_ROUTE_TARGETS_MAX,
} from '@kepcup/shared';
import type { TriggerBatch } from '../scheduler/mailbox.js';
import type { ConversationsService } from '../domain/conversations.js';
import type { BotsService } from '../domain/bots.js';
import type { MessagesService } from '../domain/messages.js';
import type { CoreLogger } from '../infra/logger.js';
import type { CoreEventsMap } from '../start-types.js';
import {
  explicitTargets,
  type ContinuationDecision,
  type DispatchTarget,
} from './dispatcher.js';
import type { LeadGateDecision } from './lead-gate.js';

/**
 * How a project round ended for the batch that opened it (D90 delivery
 * tracking):
 * - `silent`: the targets ran but none produced a visible reply (a routing
 *   `none` verdict ends here too — nothing was delivered);
 * - `failed`: nobody replied and an executed turn failed / was cancelled;
 * - `replied`: at least one target replied.
 */
export type ProjectRoundEnd = {
  conversationId: string;
  batchId: string;
  messages: Message[];
  /** The runs the round delivered to (empty for a silent routing). */
  runIds: string[];
} & (
  | { outcome: 'silent' | 'replied' }
  | { outcome: 'failed'; failure: ProjectRoundFailure }
);

export type ProjectRoundFailure = { kind: 'failed'; error: string | null } | { kind: 'cancelled' };

export interface ProjectTurnDeps {
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
  publish<K extends keyof CoreEventsMap>(event: K, payload: CoreEventsMap[K]): void;
  /** Reports how a round ended (workbench delivery tracking); optional in stripped setups. */
  onRoundEnded?: ((info: ProjectRoundEnd) => void) | undefined;
  /** The conversation's lead (`conversations.leadBotId`); null only in transient states. */
  leadOf(conversationId: string): string | null;
  /** Latest visible bot reply in the conversation (routing's "last replier"). */
  lastReplier(conversationId: string): { botId: string; at: number } | null;
  /** The last replier P's continuation check (a lightweight structured call). */
  judgeContinuation(input: {
    botId: string;
    conversationId: string;
    batchId: string;
    batchMessages: Message[];
  }): Promise<ContinuationDecision>;
  /** The lead's routing gate (a lightweight structured call). */
  gate(input: {
    leadBotId: string;
    conversationId: string;
    batchId: string;
    batchMessages: Message[];
    continuation: ContinuationDecision | null;
  }): Promise<LeadGateDecision>;
}

interface Turn {
  conversationId: string;
  batchId: string;
  messages: Message[];
  targets: DispatchTarget[];
  index: number;
  /**
   * The exact run the current target's batch was delivered to; only its
   * terminal state advances the turn (BR-P05-002: a same-bot episode run must
   * not advance it). Null only in the rare buffered-steer window, where the
   * fallback matches by bot id.
   */
  awaitingRunId: string | null;
  /**
   * The target's mailbox was busy (foreign run, e.g. an episode): the turn
   * waits for onMailboxIdle so the batch lands as its own run, not a steer.
   */
  awaitingIdle: boolean;
  /** Bot ids whose execution already finished inside this turn. */
  executed: string[];
  /** Display name of the most recent bot that actually replied. */
  lastReplier: string | null;
  /** Every run the round delivered to (D90 tracking). */
  runIds: string[];
  /** The latest failed / cancelled turn of the round (D90 tracking). */
  failure: ProjectRoundFailure | null;
  /**
   * The round came out of silent routing (continuation / routed / routed_also):
   * when it ends with no visible reply and no failure, the lead answers it
   * once (`lead_fallback`, D92 T1a 兜底不变式).
   */
  guarded: boolean;
}

interface PendingBatch {
  batchId: string;
  messages: Message[];
  /**
   * Forced single target: beats explicit targets and routing. Kept per the WP3
   * contract (DEV-031: the workbench dispatch itself aims via a structured @,
   * so nothing in production passes this today).
   */
  forcedTarget?: string;
}

/**
 * Project-conversation dispatch (D92 T1a routing, design 41 §6): one
 * conversation holds at most one round ("轮次") — an ordered list of targets
 * delivered one after another, each only after the previous bot's supervisor
 * turn reached a terminal state (D75 design 30 §6.2: a round never waits for
 * the tasks a turn started; tasks take no part in rounds). A batch with no
 * explicit target (no @ / reply) is routed silently: the last replier P may
 * claim it (continuation), else the lead's gate picks members (`routed` /
 * `routed_also`), answers itself (`lead_fallback`) or ends the round silently
 * (`none`). Batches flushed mid-round wait and are dispatched after the round.
 * Removed/deleted members are skipped, their runs cancelled.
 */
export class ProjectTurnCoordinator {
  readonly #deps: ProjectTurnDeps;
  readonly #turns = new Map<string, Turn>();
  readonly #pending = new Map<string, PendingBatch[]>();
  readonly #routing = new Set<string>();

  constructor(deps: ProjectTurnDeps) {
    this.#deps = deps;
  }

  /** A flushed user batch in a project conversation. */
  onUserBatch(
    conversationId: string,
    batchId: string,
    messages: Message[],
    options: { forcedTarget?: string } = {},
  ): void {
    const pending: PendingBatch = {
      batchId,
      messages,
      ...(options.forcedTarget !== undefined ? { forcedTarget: options.forcedTarget } : {}),
    };
    const turn = this.#turns.get(conversationId);
    if (turn) {
      this.#enqueuePending(conversationId, pending);
      this.#publishTurnState(conversationId);
      return;
    }
    if (this.#routing.has(conversationId)) {
      this.#enqueuePending(conversationId, pending);
      this.#publishTurnState(conversationId);
      return;
    }
    this.#dispatch(conversationId, pending);
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
    } else if (run.status === 'failed') {
      turn.failure = { kind: 'failed', error: run.error };
    } else if (run.status === 'interrupted') {
      turn.failure = { kind: 'failed', error: '执行被中断' };
    } else if (run.status === 'cancelled') {
      turn.failure = { kind: 'cancelled' };
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
   * states and async routing completions cannot advance, deliver or enqueue
   * anything afterwards (BR-P05-001). Must run BEFORE runs are aborted.
   */
  clear(conversationId: string): void {
    this.#turns.delete(conversationId);
    this.#pending.delete(conversationId);
    this.#routing.delete(conversationId);
    this.#publishTurnState(conversationId);
  }

  /** Current turn state for queries (same payload as the project.turn event). */
  stateOf(conversationId: string): {
    conversationId: string;
    batchId: string | null;
    phase: 'routing' | 'running' | 'idle';
    currentBotId: string | null;
    queue: string[];
    pendingBatches: number;
  } {
    const turn = this.#turns.get(conversationId);
    return {
      conversationId,
      batchId: turn?.batchId ?? null,
      phase: turn ? 'running' : this.#routing.has(conversationId) ? 'routing' : 'idle',
      currentBotId: turn?.targets[turn.index]?.botId ?? null,
      queue: turn ? turn.targets.slice(turn.index + 1).map((t) => t.botId) : [],
      pendingBatches: this.#pending.get(conversationId)?.length ?? 0,
    };
  }

  // --- internals -------------------------------------------------------------

  #dispatch(conversationId: string, pending: PendingBatch): void {
    const members = this.#activeMembers(conversationId);
    if (pending.forcedTarget !== undefined) {
      if (members.has(pending.forcedTarget)) {
        this.#startTurn(
          conversationId,
          pending.batchId,
          pending.messages,
          [{ botId: pending.forcedTarget, reason: 'mention' }],
          { guarded: false },
        );
      } else {
        this.#publishTurnState(conversationId);
      }
      return;
    }
    const targets = explicitTargets(pending.messages, members, (id) =>
      this.#deps.messages.getById(id),
    );
    if (targets.length > 0) {
      this.#startTurn(conversationId, pending.batchId, pending.messages, targets, {
        guarded: false,
      });
      return;
    }
    this.#startRouting(conversationId, pending);
  }

  #startRouting(conversationId: string, pending: PendingBatch): void {
    const lead = this.#deps.leadOf(conversationId);
    if (lead === null || !this.#activeMembers(conversationId).has(lead)) {
      // The DB CHECK guarantees a lead; an inactive one is a transient state —
      // end the round without a reply.
      this.#deps.logger.error({ conversationId }, 'project has no usable lead; message not routed');
      this.#reportRoundEnd({
        conversationId,
        batchId: pending.batchId,
        messages: pending.messages,
        runIds: [],
        outcome: 'silent',
      });
      this.#drainPending(conversationId);
      return;
    }
    this.#routing.add(conversationId);
    this.#publishTurnState(conversationId);
    void this.#route(conversationId, pending, lead);
  }

  async #route(conversationId: string, pending: PendingBatch, lead: string): Promise<void> {
    // P: the last replier, if it is a present non-lead member inside the
    // continuation window. P being the lead / absent / stale skips ①.
    const members = this.#activeMembers(conversationId);
    const last = this.#deps.lastReplier(conversationId);
    const p =
      last !== null && last.botId !== lead && members.has(last.botId) &&
      this.#deps.clock.now() - last.at <= ROUTING_CONTINUATION_WINDOW_MS
        ? last.botId
        : null;

    let continuation: ContinuationDecision | null = null;
    if (p !== null) {
      continuation = await this.#safely(
        () =>
          this.#deps.judgeContinuation({
            botId: p,
            conversationId,
            batchId: pending.batchId,
            batchMessages: pending.messages,
          }),
        null,
      );
      // Cleared mid-flight (conversation deleted): never touch it again
      // (BR-P05-001) — no turns, no further dispatch.
      if (!this.#routing.has(conversationId)) return;
      if (
        continuation !== null &&
        continuation.decision === 'respond' &&
        continuation.confidence >= ROUTING_CONTINUATION_MIN_CONFIDENCE
      ) {
        this.#finishRouting(conversationId, pending, [{ botId: p, reason: 'continuation' }], true);
        return;
      }
    }
    const gate = await this.#safely(
      () =>
        this.#deps.gate({
          leadBotId: lead,
          conversationId,
          batchId: pending.batchId,
          batchMessages: pending.messages,
          continuation,
        }),
      { decision: 'self' as const, targets: [] as string[], reason: 'gate failed' },
    );
    if (!this.#routing.has(conversationId)) return;
    // Host-side hardening: the model may name anyone — re-check against the
    // members present right now (membership may have changed during the call).
    const nowMembers = this.#activeMembers(conversationId);
    const targets =
      gate.decision === 'route'
        ? gate.targets
            .filter((id) => id !== lead && nowMembers.has(id))
            .slice(0, ROUTING_ROUTE_TARGETS_MAX)
        : [];
    if (gate.decision === 'none') {
      // Silent end: nothing was delivered and nothing is owed (纯致谢 / 寒暄).
      this.#routing.delete(conversationId);
      this.#reportRoundEnd({
        conversationId,
        batchId: pending.batchId,
        messages: pending.messages,
        runIds: [],
        outcome: 'silent',
      });
      this.#publishTurnState(conversationId);
      this.#drainPending(conversationId);
      return;
    }
    if (gate.decision === 'route' && targets.length > 0) {
      this.#finishRouting(
        conversationId,
        pending,
        targets.map((botId, i) => ({
          botId,
          reason: i === 0 ? ('routed' as const) : ('routed_also' as const),
        })),
        true,
      );
      return;
    }
    this.#finishRouting(conversationId, pending, [{ botId: lead, reason: 'lead_fallback' }], false);
  }

  #safely<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
    return fn().catch((error) => {
      // The two judgement deps never reject by contract; belt-and-braces.
      this.#deps.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'routing judgement failed',
      );
      return fallback;
    });
  }

  #finishRouting(
    conversationId: string,
    pending: PendingBatch,
    targets: DispatchTarget[],
    guarded: boolean,
  ): void {
    this.#routing.delete(conversationId);
    this.#startTurn(conversationId, pending.batchId, pending.messages, targets, { guarded });
  }

  #startTurn(
    conversationId: string,
    batchId: string,
    messages: Message[],
    targets: DispatchTarget[],
    options: { guarded: boolean; runIds?: string[] },
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
      runIds: options.runIds ? [...options.runIds] : [],
      failure: null,
      guarded: options.guarded,
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
      // A foreign run (e.g. an episode) holds the mailbox: wait for it to end
      // so the batch lands as its own run (BR-P05-002) instead of being
      // steered into that run.
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
    if (turn.awaitingRunId !== null) turn.runIds.push(turn.awaitingRunId);
    this.#publishTurnState(turn.conversationId);
  }

  #completeCurrent(turn: Turn): void {
    turn.awaitingRunId = null;
    turn.awaitingIdle = false;
    this.#advance(turn);
  }

  #endTurn(turn: Turn): void {
    this.#turns.delete(turn.conversationId);
    // A routed / continued round that produced no visible reply and did not
    // fail: the lead answers it (once). The fallback round itself is unguarded
    // — no reply there ends the round as `silent`, never a third turn. A failed
    // / cancelled round keeps the existing failure UI + retry instead.
    if (turn.guarded && turn.lastReplier === null && turn.failure === null) {
      const lead = this.#deps.leadOf(turn.conversationId);
      if (lead !== null && this.#isDispatchable(turn.conversationId, lead)) {
        this.#startTurn(
          turn.conversationId,
          turn.batchId,
          turn.messages,
          [{ botId: lead, reason: 'lead_fallback' }],
          { guarded: false, runIds: turn.runIds },
        );
        return;
      }
    }
    const base = {
      conversationId: turn.conversationId,
      batchId: turn.batchId,
      messages: turn.messages,
      runIds: turn.runIds,
    };
    this.#reportRoundEnd(
      turn.lastReplier !== null
        ? { ...base, outcome: 'replied' }
        : turn.failure !== null
          ? { ...base, outcome: 'failed', failure: turn.failure }
          : { ...base, outcome: 'silent' },
    );
    this.#publishTurnState(turn.conversationId);
    this.#drainPending(turn.conversationId);
  }

  #reportRoundEnd(info: ProjectRoundEnd): void {
    try {
      this.#deps.onRoundEnded?.(info);
    } catch (error) {
      // Tracking never breaks dispatch.
      this.#deps.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'project round end hook failed',
      );
    }
  }

  #drainPending(conversationId: string): void {
    if (this.#turns.has(conversationId) || this.#routing.has(conversationId)) return;
    const queue = this.#pending.get(conversationId);
    const next = queue?.shift();
    if (next) this.#dispatch(conversationId, next);
  }

  #enqueuePending(conversationId: string, pending: PendingBatch): void {
    const queue = this.#pending.get(conversationId) ?? [];
    queue.push(pending);
    this.#pending.set(conversationId, queue);
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
    this.#deps.publish('project.turn', this.stateOf(conversationId));
  }
}
