import { describe, expect, it, vi } from 'vitest';
import { settingsSchema, type Bot } from '@kepcup/shared';
import { normalizeGateDecision, leadGate } from '../../src/dispatch/lead-gate.js';
import { judgeContinuation } from '../../src/dispatch/dispatcher.js';

/** D92 T1a：负责人网关（normalizeGateDecision 全表、fallback、run 行、提示词名册）。 */

const LEAD = 'bot_lead';
const CONV = 'conv_1';

function botOf(id: string, name = id): Bot {
  return {
    id,
    status: 'active',
    name,
    profile: {
      identity: { name },
      role: { expertise: `${id}-擅长`, responsibilities: `${id}-职责` },
    },
  } as unknown as Bot;
}

function gateDeps(options: {
  complete?: (req: { systemPrompt: string; messages: unknown[]; tools?: unknown }) => Promise<unknown>;
  router?: never;
  roster?: string[];
}) {
  const runs: Array<Record<string, unknown> & { id: string }> = [];
  const runsService = {
    create: vi.fn((input: { loopType: string; triggerReason: string }) => {
      const run = { id: `run_${runs.length + 1}`, ...input };
      runs.push(run);
      return run;
    }),
    update: vi.fn((id: string, patch: Record<string, unknown>) => {
      const run = runs.find((candidate) => candidate.id === id);
      if (run) Object.assign(run, patch);
    }),
  };
  const usage = { record: vi.fn() };
  const scheduler = {
    submit: vi.fn((job: { run: () => Promise<void> }) => void job.run()),
    cancelQueued: vi.fn(),
  };
  const members = options.roster ?? ['bot_m1', 'bot_m2'];
  const bots = new Map<string, Bot>([[LEAD, botOf(LEAD, '领队')], ...members.map((id) => [id, botOf(id)] as const)]);
  const input = {
    engine: {
      complete:
        options.complete ??
        (async () => ({
          text: '{"decision":"route","targets":["bot_m1"],"reason":"归他"}',
          toolCalls: [],
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, costUsd: null },
          stopReason: 'stop',
        })),
    } as never,
    scheduler: scheduler as never,
    runs: runsService as never,
    usage: usage as never,
    settings: { get: () => settingsSchema.parse({ defaultLightModel: 'custom:m/light' }) } as never,
    bots: { get: (id: string) => bots.get(id) ?? null, listActive: () => [...bots.values()] } as never,
    messages: { listForBot: () => [] } as never,
    conversations: {
      get: () => ({ id: CONV, goal: '把事情做成' }),
      memberBotIds: () => [LEAD, ...members],
    } as never,
    logger: { info() {}, warn() {}, error() {}, debug() {} } as never,
    timeZone: 'UTC',
    conversationId: CONV,
    batchId: 'batch_1',
    batchMessages: [],
    leadBotId: LEAD,
    continuation: null,
  };
  return { input, runs, usage, scheduler, bots };
}

const ROSTER = new Set(['bot_m1', 'bot_m2']);

describe('normalizeGateDecision (D92 T1a 网关结论的宿主硬化)', () => {
  it('filters to the roster, dedupes and caps at ROUTING_ROUTE_TARGETS_MAX', async () => {
    const { ROUTING_ROUTE_TARGETS_MAX } = await import('@kepcup/shared');
    expect(
      normalizeGateDecision(
        { decision: 'route', targets: ['bot_m1', 'ghost', 'bot_m1', LEAD, 'bot_m2'], reason: 'r' },
        ROSTER,
      ),
    ).toEqual({ decision: 'route', targets: ['bot_m1', 'bot_m2'], reason: 'r' });

    const wideRoster = new Set(['a', 'b', 'c', 'd', 'e']);
    expect(
      normalizeGateDecision({ decision: 'route', targets: ['a', 'b', 'c', 'd', 'e'], reason: 'r' }, wideRoster),
    ).toEqual({
      decision: 'route',
      targets: ['a', 'b', 'c'],
      reason: 'r',
    });
    void ROUTING_ROUTE_TARGETS_MAX;
  });

  it('an empty route degrades to self; self / none never carry targets', () => {
    expect(normalizeGateDecision({ decision: 'route', targets: [LEAD, 'ghost'], reason: '没人' }, ROSTER)).toEqual({
      decision: 'self',
      targets: [],
      reason: '没人',
    });
    expect(normalizeGateDecision({ decision: 'self', targets: ['bot_m1'], reason: '归我' }, ROSTER)).toEqual({
      decision: 'self',
      targets: [],
      reason: '归我',
    });
    expect(normalizeGateDecision({ decision: 'none', targets: ['bot_m1'], reason: '寒暄' }, ROSTER)).toEqual({
      decision: 'none',
      targets: [],
      reason: '寒暄',
    });
  });
});

describe('leadGate (D92 T1a 负责人网关)', () => {
  it('parses the verdict and normalizes it; the run row is triage / routing_gate', async () => {
    const { input, runs, usage } = gateDeps({});
    const decision = await leadGate(input as never);
    expect(decision).toEqual({ decision: 'route', targets: ['bot_m1'], reason: '归他' });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ loopType: 'triage', triggerReason: 'routing_gate' });
    expect(usage.record).toHaveBeenCalledWith(expect.objectContaining({ loopType: 'triage' }));
  });

  it('the prompt roster never contains the lead and carries P\'s verdict', async () => {
    const requests: Array<{ systemPrompt: string; userText: string }> = [];
    const { input } = gateDeps({
      complete: async (req: { systemPrompt: string; messages: Array<{ content: string }> }) => {
        requests.push({ systemPrompt: req.systemPrompt, userText: req.messages.at(-1)!.content });
        return { text: '{"decision":"self","targets":[],"reason":"归我"}', toolCalls: [] };
      },
    });
    (input as { continuation: unknown }).continuation = {
      botId: 'bot_m1',
      decision: 'not_mine',
      confidence: 0.9,
      reason: '是别人的事',
    };
    const decision = await leadGate(input as never);
    expect(decision.decision).toBe('self');
    const prompt = requests[0]!;
    // The gate runs on the LEAD's light model with the gate system prompt.
    expect(prompt.systemPrompt).toContain('project lead');
    expect(prompt.systemPrompt).toContain("When in doubt choose self");
    // The roster excludes the lead; the continuation verdict is included.
    expect(prompt.userText).toContain('bot_m1');
    expect(prompt.userText).toContain('bot_m2');
    expect(prompt.userText).not.toContain(`${LEAD} `);
    expect(prompt.userText).toContain('not_mine');
    expect(prompt.userText).toContain('是别人的事');
    expect(prompt.userText).toContain('项目目标：把事情做成');
  });

  it('a gate whose verdict mentions no roster member still routes only real members', async () => {
    const { input } = gateDeps({
      complete: async () => ({
        text: JSON.stringify({ decision: 'route', targets: [LEAD, 'ghost'], reason: '瞎填' }),
        toolCalls: [],
      }),
    });
    const decision = await leadGate(input as never);
    expect(decision).toEqual({ decision: 'self', targets: [], reason: '瞎填' });
  });

  it('unparsable output degrades to self (the message is never dropped)', async () => {
    const { input, runs } = gateDeps({
      complete: async () => ({ text: '完全不是 JSON', toolCalls: [] }),
    });
    const decision = await leadGate(input as never);
    expect(decision).toEqual({ decision: 'self', targets: [], reason: 'gate failed' });
    expect(runs[0]).toMatchObject({ status: 'failed' });
  });

  it('no model at all degrades to self without any call', async () => {
    const { input, runs, scheduler } = gateDeps({});
    // No built-in model configured (empty defaults, empty profile runtime):
    // the route resolves to null and the gate never runs.
    (input as { settings: { get(): unknown } }).settings = {
      get: () => settingsSchema.parse({ defaultLightModel: '', defaultMainModel: '' }),
    };
    (input as { bots: { get(id: string): unknown } }).bots = { get: () => null };
    const decision = await leadGate(input as never);
    expect(decision).toEqual({ decision: 'self', targets: [], reason: 'gate failed' });
    expect(runs).toHaveLength(0);
    expect(scheduler.submit).not.toHaveBeenCalled();
  });
});

describe('judgeContinuation run row (D92 T1a 续接判断的留痕)', () => {
  it('creates a triage run with trigger_reason continuation and keeps the verdict reason', async () => {
    const runs: Array<Record<string, unknown> & { id: string }> = [];
    const runsService = {
      create: vi.fn((input: { loopType: string; triggerReason: string }) => {
        const run = { id: `run_${runs.length + 1}`, ...input };
        runs.push(run);
        return run;
      }),
      update: vi.fn(),
    };
    const decision = await judgeContinuation({
      engine: {
        complete: async () => ({
          text: JSON.stringify({ decision: 'respond', confidence: 0.9, reason: '在延续我的工作' }),
          toolCalls: [],
        }),
      } as never,
      scheduler: { submit: (job: { run: () => Promise<void> }) => void job.run() } as never,
      runs: runsService as never,
      usage: { record: vi.fn() } as never,
      settings: { get: () => settingsSchema.parse({ defaultLightModel: 'custom:m/light' }) } as never,
      bots: { get: () => botOf('bot_p'), listActive: () => [] } as never,
      messages: { listForBot: () => [] } as never,
      botId: 'bot_p',
      conversationId: CONV,
      batchId: 'batch_1',
      batchMessages: [],
      goal: '把事情做成',
      timeZone: 'UTC',
      logger: { info() {}, warn() {}, error() {}, debug() {} } as never,
    });
    expect(decision).toEqual({
      botId: 'bot_p',
      decision: 'respond',
      confidence: 0.9,
      reason: '在延续我的工作',
    });
    expect(runs[0]).toMatchObject({ loopType: 'triage', triggerReason: 'continuation' });
  });
});
