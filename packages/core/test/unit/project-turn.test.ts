import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, Run } from '@kepcup/shared';
import type { TriggerBatch } from '../../src/scheduler/mailbox.js';
import {
  ProjectTurnCoordinator,
  type ProjectRoundEnd,
  type ProjectTurnDeps,
} from '../../src/dispatch/project-turn.js';
import type { ContinuationDecision } from '../../src/dispatch/dispatcher.js';
import { normalizeGateDecision, type LeadGateDecision } from '../../src/dispatch/lead-gate.js';

/** D92 T1a routing（WP3 §5）：ProjectTurnCoordinator 的假依赖单测（可控假时钟）。 */

let seq = 0;
function message(text: string, extra: Partial<Message> = {}): Message {
  seq += 1;
  return {
    id: `msg_${seq}`,
    conversationId: 'conv_1',
    seq,
    senderType: 'user',
    senderBotId: null,
    kind: 'text',
    content: { text },
    status: 'normal',
    batchId: 'batch_1',
    runId: null,
    replyTo: null,
    mentions: [],
    attachments: [],
    ownerBotId: null,
    taskId: null,
    createdAt: 1_000 + seq,
    editedAt: null,
    ...extra,
  } as unknown as Message;
}

const CONV = 'conv_1';
const LEAD = 'bot_lead';
const P = 'bot_p';
const X = 'bot_x';
const Y = 'bot_y';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (e: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface Harness {
  coordinator: ProjectTurnCoordinator;
  clock: { now: number };
  deliveries: TriggerBatch[];
  events: Array<[string, unknown]>;
  roundEnds: ProjectRoundEnd[];
  continuationCalls: Array<{ botId: string; continuation?: unknown }>;
  gateCalls: Array<{ leadBotId: string; continuation: ContinuationDecision | null }>;
  nextContinuation: (decision: ContinuationDecision | null) => void;
  nextGate: (decision: LeadGateDecision | null) => void;
  failContinuation: (error: unknown) => void;
  failGate: (error: unknown) => void;
  deps: ProjectTurnDeps;
  setLead: (lead: string | null) => void;
  setMembers: (members: string[]) => void;
  setLastReplier: (replier: { botId: string; at: number } | null) => void;
}

function bot(id: string) {
  return {
    id,
    status: 'active' as const,
    name: id,
    profile: { identity: { name: id }, role: { expertise: '', responsibilities: '' } },
  };
}

function makeHarness(): Harness {
  const clock = { now: 1_000_000 };
  let lead: string | null = LEAD;
  let members: string[] = [LEAD, P, X, Y];
  let lastReplier: { botId: string; at: number } | null = null;
  const deliveries: TriggerBatch[] = [];
  const events: Array<[string, unknown]> = [];
  const roundEnds: ProjectRoundEnd[] = [];
  const continuationCalls: Array<{ botId: string; continuation?: unknown }> = [];
  const gateCalls: Array<{ leadBotId: string; continuation: ContinuationDecision | null }> = [];
  let runCounter = 0;

  const deps: ProjectTurnDeps = {
    conversations: { memberBotIds: () => members } as never,
    bots: {
      get: (id: string) => (members.includes(id) || id === LEAD ? bot(id) : null),
    } as never,
    messages: { getById: () => null } as never,
    clock: { now: () => clock.now },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    } as never,
    timeZone: 'UTC',
    deliver: (batch: TriggerBatch) => {
      deliveries.push(batch);
      runCounter += 1;
      return `run_${runCounter}`;
    },
    isMailboxRunning: () => false,
    publish: (event, payload) => events.push([event, payload]),
    onRoundEnded: (info) => roundEnds.push(info),
    leadOf: () => lead,
    lastReplier: () => lastReplier,
    judgeContinuation: (input) => {
      continuationCalls.push({ botId: input.botId });
      return continuationDeferred.promise as never;
    },
    gate: (input) => {
      gateCalls.push({ leadBotId: input.leadBotId, continuation: input.continuation });
      // Mirror the real leadGate: the model's raw verdict is normalized
      // against the non-lead roster (过滤、去重、截断、空 route → self).
      return gateDeferred.promise.then((raw) =>
        normalizeGateDecision(raw as LeadGateDecision, new Set(members.filter((m) => m !== lead))),
      ) as never;
    },
  };

  const continuationDeferred = deferred<ContinuationDecision>();
  const gateDeferred = deferred<LeadGateDecision>();

  const harness: Harness = {
    coordinator: new ProjectTurnCoordinator(deps),
    clock,
    deliveries,
    events,
    roundEnds,
    continuationCalls,
    gateCalls,
    nextContinuation: (decision) => continuationDeferred.resolve(decision as never),
    nextGate: (decision) => gateDeferred.resolve(decision as never),
    failContinuation: (error) => continuationDeferred.reject(error),
    failGate: (error) => gateDeferred.reject(error),
    deps,
    setLead: (value) => {
      lead = value;
    },
    setMembers: (value) => {
      members = value;
    },
    setLastReplier: (value) => {
      lastReplier = value;
    },
  };
  return harness;
}

function turnRun(h: Harness, botId: string, status: Run['status'], outputMessageIds: string[] = []): Run {
  return {
    id: `run_${h.deliveries.length}`,
    botId,
    conversationId: CONV,
    status,
    outputMessageIds,
    error: null,
  } as unknown as Run;
}

/** Phases of the project.turn events (latest state per publish). */
function phases(h: Harness): string[] {
  return h.events.filter(([event]) => event === 'project.turn').map(([, p]) => (p as { phase: string }).phase);
}

const DECIDE = (botId: string, decision: ContinuationDecision['decision'], confidence: number): ContinuationDecision => ({
  botId,
  decision,
  confidence,
  reason: '因为一些理由',
});

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('ProjectTurnCoordinator (D92 T1a routing)', () => {
  it('a. an explicit @ delivers only the mentioned bot; no judgement is consulted', async () => {
    const h = makeHarness();
    h.coordinator.onUserBatch(CONV, 'batch_a', [message('帮我看下', { mentions: [X] })]);
    expect(h.deliveries.map((d) => [d.botId, d.reason])).toEqual([[X, 'mention']]);
    expect(h.continuationCalls).toHaveLength(0);
    expect(h.gateCalls).toHaveLength(0);
    h.coordinator.onRunSettled(turnRun(h, X, 'completed', ['msg_reply']));
    expect(h.roundEnds).toEqual([expect.objectContaining({ outcome: 'replied' })]);
    expect(phases(h)).toEqual(['running', 'idle']);
  });

  it('b. a forced target (workbench dispatch) beats everything, including an eligible P', async () => {
    const h = makeHarness();
    // A prior replier exists (P inside the window): the forced path ignores it.
    h.setLastReplier({ botId: P, at: h.clock.now - 1000 });
    h.coordinator.onUserBatch(CONV, 'batch_b', [message('做这件事')], { forcedTarget: X });
    expect(h.deliveries.map((d) => [d.botId, d.reason])).toEqual([[X, 'mention']]);
    expect(h.continuationCalls).toHaveLength(0);
    expect(h.gateCalls).toHaveLength(0);
    expect(phases(h)).toEqual(['running']);
    // An ineligible forced target delivers nothing (transient state).
    const h2 = makeHarness();
    h2.setMembers([LEAD, P]);
    h2.coordinator.onUserBatch(CONV, 'batch_b2', [message('做这件事')], { forcedTarget: X });
    expect(h2.deliveries).toHaveLength(0);
    expect(h2.roundEnds).toHaveLength(0);
  });

  it('c. a claiming P inside the window takes the round as continuation; the gate is never called', async () => {
    const h = makeHarness();
    h.setLastReplier({ botId: P, at: h.clock.now - 1000 });
    h.coordinator.onUserBatch(CONV, 'batch_c', [message('接着说')]);
    expect(phases(h)).toEqual(['routing']);
    expect(h.continuationCalls).toEqual([{ botId: P }]);
    h.nextContinuation(DECIDE(P, 'respond', 0.9));
    await vi.waitFor(() => expect(h.deliveries.map((d) => [d.botId, d.reason])).toEqual([[P, 'continuation']]));
    expect(h.gateCalls).toHaveLength(0);
    // The round is guarded: P going silent falls back to the lead.
    h.coordinator.onRunSettled(turnRun(h, P, 'completed', []));
    await vi.waitFor(() =>
      expect(h.deliveries.map((d) => [d.botId, d.reason])).toEqual([
        [P, 'continuation'],
        [LEAD, 'lead_fallback'],
      ]),
    );
  });

  it('d. an unconfident / unclaimed P hands its verdict to the gate', async () => {
    for (const verdict of [DECIDE(P, 'respond', 0.3), DECIDE(P, 'not_mine', 0.9), DECIDE(P, 'no_action', 0.9)]) {
      const h = makeHarness();
      h.setLastReplier({ botId: P, at: h.clock.now - 1000 });
      h.coordinator.onUserBatch(CONV, 'batch_d', [message('谁来处理')]);
      h.nextContinuation(verdict);
      await vi.waitFor(() =>
        expect(h.gateCalls).toEqual([{ leadBotId: LEAD, continuation: verdict }]),
      );
      h.nextGate({ decision: 'self', targets: [], reason: '归我' });
      await vi.waitFor(() =>
        expect(h.deliveries.map((d) => [d.botId, d.reason])).toEqual([[LEAD, 'lead_fallback']]),
      );
    }
  });

  it('e. no eligible P: the continuation check never runs, the gate gets a null verdict', async () => {
    // P is the lead.
    let h = makeHarness();
    h.setLastReplier({ botId: LEAD, at: h.clock.now - 1000 });
    h.coordinator.onUserBatch(CONV, 'batch_e1', [message('在吗')]);
    expect(h.continuationCalls).toHaveLength(0);
    h.nextGate({ decision: 'none', targets: [], reason: '寒暄' });
    await vi.waitFor(() => expect(h.gateCalls).toEqual([{ leadBotId: LEAD, continuation: null }]));

    // P is not a member any more.
    h = makeHarness();
    h.setLastReplier({ botId: 'bot_gone', at: h.clock.now - 1000 });
    h.coordinator.onUserBatch(CONV, 'batch_e2', [message('在吗')]);
    expect(h.continuationCalls).toHaveLength(0);
    h.nextGate({ decision: 'none', targets: [], reason: '寒暄' });
    await vi.waitFor(() => expect(h.gateCalls).toEqual([{ leadBotId: LEAD, continuation: null }]));

    // P is outside the window.
    h = makeHarness();
    h.setLastReplier({ botId: P, at: h.clock.now - 30 * 60_000 - 1 });
    h.coordinator.onUserBatch(CONV, 'batch_e3', [message('在吗')]);
    expect(h.continuationCalls).toHaveLength(0);
    h.nextGate({ decision: 'none', targets: [], reason: '寒暄' });
    await vi.waitFor(() => expect(h.gateCalls).toEqual([{ leadBotId: LEAD, continuation: null }]));

    // No bot ever replied.
    h = makeHarness();
    h.setLastReplier(null);
    h.coordinator.onUserBatch(CONV, 'batch_e4', [message('在吗')]);
    expect(h.continuationCalls).toHaveLength(0);
    h.nextGate({ decision: 'none', targets: [], reason: '寒暄' });
    await vi.waitFor(() => expect(h.gateCalls).toEqual([{ leadBotId: LEAD, continuation: null }]));
  });

  it('f. a gate self hands the round to the lead (lead_fallback, unguarded)', async () => {
    const h = makeHarness();
    h.setLastReplier(null);
    h.coordinator.onUserBatch(CONV, 'batch_f', [message('项目怎么样了')]);
    h.nextGate({ decision: 'self', targets: [], reason: '整体问题' });
    await vi.waitFor(() =>
      expect(h.deliveries.map((d) => [d.botId, d.reason])).toEqual([[LEAD, 'lead_fallback']]),
    );
    // Unguarded: the lead going silent ends the round as silent — no second lead turn.
    h.coordinator.onRunSettled(turnRun(h, LEAD, 'completed', []));
    await vi.waitFor(() => expect(h.roundEnds).toEqual([expect.objectContaining({ outcome: 'silent' })]));
    expect(h.deliveries).toHaveLength(1);
  });

  it('g. a gate route delivers the targets in order, host-filtered; empty route degrades to the lead', async () => {
    // X (routed) then Y (routed_also) — Y is delivered only after X settles.
    const h = makeHarness();
    h.coordinator.onUserBatch(CONV, 'batch_g1', [message('甲乙都看看')]);
    h.nextGate({ decision: 'route', targets: [X, Y], reason: '各管一摊' });
    await vi.waitFor(() => expect(h.deliveries.map((d) => [d.botId, d.reason])).toEqual([[X, 'routed']]));
    h.coordinator.onRunSettled(turnRun(h, X, 'completed', ['msg_x']));
    await vi.waitFor(() =>
      expect(h.deliveries.map((d) => [d.botId, d.reason])).toEqual([
        [X, 'routed'],
        [Y, 'routed_also'],
      ]),
    );
    h.coordinator.onRunSettled(turnRun(h, Y, 'completed', ['msg_y']));
    expect(h.roundEnds).toEqual([expect.objectContaining({ outcome: 'replied' })]);

    // Host-side filtering: the lead, a non-member, a duplicate and a fourth
    // target are dropped / capped to 3.
    const h2 = makeHarness();
    h2.coordinator.onUserBatch(CONV, 'batch_g2', [message('都看看')]);
    h2.nextGate({ decision: 'route', targets: [LEAD, X, 'bot_gone', X, Y, P], reason: '多目标' });
    await vi.waitFor(() =>
      expect(h2.deliveries.map((d) => [d.botId, d.reason])).toEqual([[X, 'routed']]),
    );
    h2.coordinator.onRunSettled(turnRun(h2, X, 'completed', ['msg_x2']));
    await vi.waitFor(() =>
      expect(h2.deliveries.map((d) => [d.botId, d.reason])).toEqual([
        [X, 'routed'],
        [Y, 'routed_also'],
      ]),
    );
    h2.coordinator.onRunSettled(turnRun(h2, Y, 'completed', ['msg_y2']));
    await vi.waitFor(() =>
      expect(h2.deliveries.map((d) => [d.botId, d.reason])).toEqual([
        [X, 'routed'],
        [Y, 'routed_also'],
        [P, 'routed_also'],
      ]),
    );

    // A route filtered to nothing degrades to the lead.
    const h3 = makeHarness();
    h3.coordinator.onUserBatch(CONV, 'batch_g3', [message('谁看看')]);
    h3.nextGate({ decision: 'route', targets: [LEAD, 'bot_gone'], reason: '都不可用' });
    await vi.waitFor(() =>
      expect(h3.deliveries.map((d) => [d.botId, d.reason])).toEqual([[LEAD, 'lead_fallback']]),
    );
  });

  it('h. a gate none ends the round silently; a queued batch is dispatched afterwards', async () => {
    const h = makeHarness();
    h.coordinator.onUserBatch(CONV, 'batch_h1', [message('谢谢大家')]);
    h.coordinator.onUserBatch(CONV, 'batch_h2', [message('这个归X', { mentions: [X], id: 'msg_h2' })]);
    h.nextGate({ decision: 'none', targets: [], reason: '纯致谢' });
    await vi.waitFor(() =>
      expect(h.roundEnds).toEqual([expect.objectContaining({ outcome: 'silent', batchId: 'batch_h1' })]),
    );
    // Nothing was delivered for the `none` batch itself; the queued batch
    // (explicit @) is dispatched once the routing is done.
    expect(h.deliveries.map((d) => [d.botId, d.reason])).toEqual([[X, 'mention']]);
    expect(h.deliveries[0]!.messages.map((m) => m.id)).toEqual(['msg_h2']);
    // routing (batch_h1), routing again (batch_h2 enqueued), idle, running.
    expect(phases(h)).toEqual(['routing', 'routing', 'idle', 'running']);
    h.coordinator.onRunSettled(turnRun(h, X, 'completed', ['msg_h2_reply']));
    expect(h.roundEnds[1]).toMatchObject({ outcome: 'replied', batchId: 'batch_h2' });
  });

  it('i. a rejected judgement dep degrades: continuation -> unclaimed, gate -> self', async () => {
    // judgeContinuation rejects (contract violation): treated as unclaimed.
    const h = makeHarness();
    h.setLastReplier({ botId: P, at: h.clock.now - 1000 });
    h.coordinator.onUserBatch(CONV, 'batch_i1', [message('看看')]);
    h.failContinuation(new Error('contract violated'));
    await vi.waitFor(() => expect(h.gateCalls).toEqual([{ leadBotId: LEAD, continuation: null }]));
    h.nextGate({ decision: 'none', targets: [], reason: '寒暄' });
    await vi.waitFor(() => expect(h.roundEnds).toEqual([expect.objectContaining({ outcome: 'silent' })]));

    // The gate rejects: the lead answers (self fallback).
    const h2 = makeHarness();
    h2.coordinator.onUserBatch(CONV, 'batch_i2', [message('看看')]);
    h2.failGate(new Error('contract violated'));
    await vi.waitFor(() =>
      expect(h2.deliveries.map((d) => [d.botId, d.reason])).toEqual([[LEAD, 'lead_fallback']]),
    );
  });

  it('j. the guarded-round fallback fires exactly once; a silent fallback ends the round', async () => {
    const h = makeHarness();
    h.coordinator.onUserBatch(CONV, 'batch_j', [message('这个给X')]);
    h.nextGate({ decision: 'route', targets: [X], reason: '归X' });
    await vi.waitFor(() => expect(h.deliveries.map((d) => [d.botId, d.reason])).toEqual([[X, 'routed']]));
    // X finishes with no visible reply and no failure.
    h.coordinator.onRunSettled(turnRun(h, X, 'completed', []));
    await vi.waitFor(() =>
      expect(h.deliveries.map((d) => [d.botId, d.reason])).toEqual([
        [X, 'routed'],
        [LEAD, 'lead_fallback'],
      ]),
    );
    // The fallback run also stays silent: silent end, no third turn.
    h.coordinator.onRunSettled(turnRun(h, LEAD, 'completed', []));
    await vi.waitFor(() => expect(h.roundEnds).toEqual([expect.objectContaining({ outcome: 'silent' })]));
    expect(h.deliveries).toHaveLength(2);
  });

  it('k. a failed / cancelled target never triggers the fallback', async () => {
    const h = makeHarness();
    h.coordinator.onUserBatch(CONV, 'batch_k', [message('这个给X')]);
    h.nextGate({ decision: 'route', targets: [X], reason: '归X' });
    await vi.waitFor(() => expect(h.deliveries).toHaveLength(1));
    h.coordinator.onRunSettled(turnRun(h, X, 'failed'));
    await vi.waitFor(() =>
      expect(h.roundEnds).toEqual([
        expect.objectContaining({ outcome: 'failed', failure: { kind: 'failed', error: null } }),
      ]),
    );
    expect(h.deliveries).toHaveLength(1);
    expect(phases(h).at(-1)).toBe('idle');

    // Cancelled likewise.
    const h2 = makeHarness();
    h2.coordinator.onUserBatch(CONV, 'batch_k2', [message('这个给X')]);
    h2.nextGate({ decision: 'route', targets: [X], reason: '归X' });
    await vi.waitFor(() => expect(h2.deliveries).toHaveLength(1));
    h2.coordinator.onRunSettled(turnRun(h2, X, 'cancelled'));
    await vi.waitFor(() =>
      expect(h2.roundEnds).toEqual([expect.objectContaining({ outcome: 'failed', failure: { kind: 'cancelled' } })]),
    );
  });

  it('l. batches flushed mid-routing wait and are dispatched after the round', async () => {
    const h = makeHarness();
    const first = message('第一条', { id: 'msg_l1' });
    const second = message('第二条', { id: 'msg_l2', mentions: [X] });
    h.coordinator.onUserBatch(CONV, 'batch_l1', [first]);
    expect(phases(h)).toEqual(['routing']);
    h.coordinator.onUserBatch(CONV, 'batch_l2', [second]);
    expect(h.deliveries).toHaveLength(0);
    h.nextGate({ decision: 'self', targets: [], reason: '归我' });
    await vi.waitFor(() =>
      expect(h.deliveries.map((d) => [d.botId, d.reason])).toEqual([[LEAD, 'lead_fallback']]),
    );
    // routing (batch_l1), routing again (batch_l2 enqueued), running.
    expect(phases(h)).toEqual(['routing', 'routing', 'running']);
    h.coordinator.onRunSettled(turnRun(h, LEAD, 'completed', ['msg_l1']));
    // The round ends (replied) and only then is the queued batch dispatched.
    await vi.waitFor(() =>
      expect(h.deliveries.map((d) => [d.botId, d.reason])).toEqual([
        [LEAD, 'lead_fallback'],
        [X, 'mention'],
      ]),
    );
    expect(h.deliveries[1]!.messages.map((m) => m.id)).toEqual(['msg_l2']);
    h.coordinator.onRunSettled(turnRun(h, X, 'completed', ['msg_l2_reply']));
    expect(h.roundEnds.at(-1)).toMatchObject({ outcome: 'replied', batchId: 'batch_l2' });
  });

  it('m. clear() during routing: late judgement results deliver and report nothing', async () => {
    const h = makeHarness();
    h.coordinator.onUserBatch(CONV, 'batch_m', [message('看看')]);
    expect(phases(h)).toEqual(['routing']);
    h.coordinator.clear(CONV);
    h.nextGate({ decision: 'self', targets: [], reason: '归我' });
    await new Promise((r) => setTimeout(r, 20));
    expect(h.deliveries).toHaveLength(0);
    expect(h.roundEnds).toHaveLength(0);
    expect(phases(h)).toEqual(['routing', 'idle']);
  });

  it('n. stateOf and the project.turn events walk routing -> running -> idle', async () => {
    const h = makeHarness();
    h.coordinator.onUserBatch(CONV, 'batch_n', [message('看看')]);
    // While routing the batch is not owned by a turn yet (batchId null).
    expect(h.coordinator.stateOf(CONV)).toMatchObject({ phase: 'routing', batchId: null });
    h.nextGate({ decision: 'route', targets: [X, Y], reason: '两目标' });
    await vi.waitFor(() => {
      const state = h.coordinator.stateOf(CONV);
      expect(state.phase).toBe('running');
      expect(state.currentBotId).toBe(X);
      expect(state.queue).toContain(Y);
    });
    expect(h.coordinator.stateOf(CONV)).toMatchObject({
      phase: 'running',
      currentBotId: X,
      queue: [Y],
      batchId: 'batch_n',
    });
    h.coordinator.onRunSettled(turnRun(h, X, 'completed', ['msg_x']));
    h.coordinator.onRunSettled(turnRun(h, Y, 'completed', ['msg_y']));
    expect(h.coordinator.stateOf(CONV)).toMatchObject({ phase: 'idle', batchId: null });
    // One publish per delivery (each target's) plus routing and idle.
    expect(phases(h)).toEqual(['routing', 'running', 'running', 'idle']);
  });

  it('o. no usable lead (violating the invariant transiently): silent end, no routing, error logged', async () => {
    const errors: unknown[] = [];
    const h = makeHarness();
    (h.deps.logger as { error: (payload: unknown, msg: string) => void }).error = (payload) =>
      errors.push(payload);
    h.setLead(null);
    h.coordinator.onUserBatch(CONV, 'batch_o1', [message('看看')]);
    expect(h.continuationCalls).toHaveLength(0);
    expect(h.gateCalls).toHaveLength(0);
    expect(h.deliveries).toHaveLength(0);
    expect(h.roundEnds).toEqual([expect.objectContaining({ outcome: 'silent' })]);
    expect(errors).toHaveLength(1);

    // The lead exists but is not an active member.
    const h2 = makeHarness();
    h2.setMembers([P, X, Y]);
    h2.coordinator.onUserBatch(CONV, 'batch_o2', [message('看看')]);
    expect(h2.roundEnds).toEqual([expect.objectContaining({ outcome: 'silent' })]);
    expect(h2.deliveries).toHaveLength(0);
  });
});
