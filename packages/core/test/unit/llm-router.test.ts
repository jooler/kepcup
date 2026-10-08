import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_BACKGROUND_EVERY_N_RUNS,
  AGENT_TRIAGE_MIN_INTERVAL_MS,
  AGENT_TRIAGE_TIMEOUT_MS,
  settingsSchema,
  TRIAGE_TIMEOUT_MS,
  type AgentView,
  type Bot,
  type Settings,
} from '@kepcup/shared';
import { fakeAgentEntry } from '@kepcup/testkit';
import {
  agentBackgroundBlocker,
  backgroundRunSpec,
  engineKeyOf,
  LlmRouter,
  routeFor,
  type LlmPurpose,
} from '../../src/agent/llm-router.js';
import { triageOneBot } from '../../src/dispatch/dispatcher.js';
import type { AgentEngine, RunSpec } from '../../src/agent/types.js';

/** D72 P6 `agent/llm-router.ts`：后台调用路由、降配与降频。 */

const builtin = { startRun: vi.fn(), complete: vi.fn() } as unknown as AgentEngine;
const external = { startRun: vi.fn(), complete: vi.fn() } as unknown as AgentEngine;
const ALPHA = fakeAgentEntry('alpha');
const BETA = fakeAgentEntry('beta');

function bot(
  runtime: Partial<Bot['profile']['runtime']> = {},
  agent: Partial<Bot['profile']['runtime']['agent']> = {},
): Bot {
  return {
    id: 'bot_1',
    profile: {
      runtime: {
        model: '',
        light_model: '',
        ...runtime,
        agent: {
          id: '',
          model: '',
          effort: '',
          permission: 'workspace',
          capabilities: null,
          ...agent,
        },
      },
    },
  } as unknown as Bot;
}

function router(
  patch: Partial<Settings> = {},
  options: {
    bot?: Bot;
    ready?: string[];
    withExternal?: boolean;
    budgetExceeded?: (botId: string) => boolean;
    now?: () => number;
  } = {},
) {
  const settings = settingsSchema.parse({
    experimental: { externalAgents: true },
    agents: { alpha: { enabled: true }, beta: { enabled: true } },
    ...patch,
  });
  const ready = options.ready ?? ['alpha', 'beta'];
  return new LlmRouter({
    settings: { get: () => settings },
    bots: {
      get: (id) => (options.bot !== undefined && id === options.bot.id ? options.bot : null),
    },
    builtin,
    ...(options.withExternal !== false ? { external } : {}),
    catalog: () => [ALPHA, BETA],
    agentView: (id) =>
      ({
        enabled: true,
        status: ready.includes(id) ? 'ready' : 'needs_auth',
        statusDetail: null,
      }) as Pick<AgentView, 'enabled' | 'status' | 'statusDetail'>,
    ...(options.budgetExceeded !== undefined ? { budgetExceeded: options.budgetExceeded } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
}

/** An explicitly chosen background agent (routes bot-less purposes too). */
const CHOSEN = { backgroundAgentId: 'alpha' } satisfies Partial<Settings>;
/** Agent triage opted in (groupMentionOnly is on by default, 审查 C2). */
const TRIAGE_ON = {
  backgroundTasks: { agentEnabled: true, agentSkillAuthoring: false, groupMentionOnly: false },
} satisfies Partial<Settings>;

describe('LlmRouter', () => {
  it('built-in models win, with the per-purpose model rules of the old call sites', () => {
    const withModels = router({
      defaultMainModel: 'custom:m/main',
      defaultLightModel: 'custom:m/light',
    });
    const b = bot({ model: 'custom:b/main', light_model: 'custom:b/light' });
    const cases: Array<[LlmPurpose, string]> = [
      ['triage', 'custom:b/light'],
      ['subagent_compaction', 'custom:b/light'],
      ['wiki_maintenance', 'custom:b/main'],
      ['skill_authoring', 'custom:b/main'],
      ['summary', 'custom:m/light'],
      ['reflection', 'custom:m/light'],
      ['consolidation', 'custom:m/light'],
      ['profile_curation', 'custom:m/main'],
    ];
    for (const [purpose, ref] of cases) {
      expect(withModels.resolveForBot(b, purpose), purpose).toEqual({
        engine: builtin,
        modelRef: ref,
        provider: ref.slice(0, ref.indexOf('/')),
        agentId: null,
      });
    }
    // Main model only: light purposes fall back to it.
    expect(
      router({ defaultMainModel: 'custom:m/main' }).resolveDefault('reflection')?.modelRef,
    ).toBe('custom:m/main');
  });

  it('no built-in model: auto = the bot’s own agent only, never another vendor (审查 S2)', () => {
    // Auto without a bot: nothing (no cross-vendor fallback to the first agent).
    expect(router({}, { ready: ['beta'] }).resolveDefault('reflection')).toBeNull();
    const own = bot({}, { id: 'beta', model: 'beta-pro' });
    expect(router({}, { bot: own }).resolveForBot(own, 'summary')).toEqual({
      engine: external,
      modelRef: 'agent:beta/beta-pro',
      provider: 'agent:beta',
      agentId: 'beta',
    });
    expect(router({}, { bot: own }).resolveForBot('bot_1', 'summary')?.agentId).toBe('beta');
    // The bot's own agent unusable: skipped, alpha (ready) is NOT used instead.
    expect(router({}, { bot: own, ready: ['alpha'] }).resolveForBot(own, 'summary')).toBeNull();
    // A bot without an agent of its own: skipped.
    expect(router().resolveForBot(bot(), 'reflection')).toBeNull();
    // Global profile curation (cross-bot): only with an explicit choice.
    expect(router({}, { bot: own }).resolveForBot(own, 'profile_curation')).toBeNull();
    expect(router(CHOSEN).resolveDefault('profile_curation')?.agentId).toBe('alpha');
    // Explicit choice: used as is (bot or not); never swapped when unusable.
    expect(router(CHOSEN, { bot: own }).resolveForBot(own, 'summary')).toMatchObject({
      modelRef: 'agent:alpha/default',
    });
    expect(router(CHOSEN).resolveDefault('summary')?.agentId).toBe('alpha');
    expect(router(CHOSEN, { ready: ['beta'] }).resolveDefault('summary')).toBeNull();
    // Nothing usable / no external engine / experimental off → skip (P4 fallback).
    expect(router(CHOSEN, { ready: [] }).resolveDefault('summary')).toBeNull();
    expect(router(CHOSEN, { withExternal: false }).resolveDefault('summary')).toBeNull();
    expect(
      router({ ...CHOSEN, experimental: { externalAgents: false } }).resolveDefault('summary'),
    ).toBeNull();
  });

  it('background eligibility: no native tools, no personal config, concurrency ≥ 2 (审查 S1 / C1)', () => {
    const settings = (patch: Partial<Settings> = {}) =>
      settingsSchema.parse({ experimental: { externalAgents: true }, ...patch });
    const claude = fakeAgentEntry('claude-x', { provider: 'claude', releaseGate: 'claude' });
    const opencode = fakeAgentEntry('oc-x', { provider: 'opencode', releaseGate: 'opencode' });
    const codex = fakeAgentEntry('codex-x', { provider: 'codex', releaseGate: 'codex' });
    expect(agentBackgroundBlocker(settings(), claude)).toBeNull();
    // testkit fake agent: scripted, no native tools.
    expect(agentBackgroundBlocker(settings(), ALPHA)).toBeNull();
    expect(agentBackgroundBlocker(settings(), opencode)).toMatch(/原生工具/);
    expect(agentBackgroundBlocker(settings(), codex)).toMatch(/原生工具/);
    expect(
      agentBackgroundBlocker(
        settings({ agents: { 'claude-x': { loadUserConfig: true } } }),
        claude,
      ),
    ).toMatch(/个人配置/);
    expect(
      agentBackgroundBlocker(
        settings({ providerConcurrency: { default: 4, 'agent:claude-x': 1 } }),
        claude,
      ),
    ).toMatch(/并发/);
    // The router skips blocked agents (explicit or the bot's own).
    const blocked = router({
      ...CHOSEN,
      agents: { alpha: { enabled: true, loadUserConfig: true } },
    });
    expect(blocked.resolveDefault('summary')).toBeNull();
    const own = bot({}, { id: 'beta' });
    expect(
      router({ providerConcurrency: { default: 4, 'agent:beta': 1 } }, { bot: own }).resolveForBot(
        own,
        'summary',
      ),
    ).toBeNull();
  });

  it('agent-only degradations: skill authoring opt-in, triage opt-in + budget, off switch', () => {
    const r = router(CHOSEN);
    expect(r.resolveDefault('skill_authoring')).toBeNull();
    // Agent triage is off by default (groupMentionOnly defaults to on).
    expect(r.resolveDefault('triage')).toBeNull();
    expect(router({ ...CHOSEN, ...TRIAGE_ON }).resolveDefault('triage')).not.toBeNull();
    // Daily background budget used up: agent triage skipped for that bot.
    const own = bot({}, { id: 'alpha' });
    expect(
      router(TRIAGE_ON, { bot: own, budgetExceeded: () => true }).resolveForBot(own, 'triage'),
    ).toBeNull();
    expect(
      router(TRIAGE_ON, { bot: own, budgetExceeded: () => false }).resolveForBot(own, 'triage'),
    ).not.toBeNull();
    expect(
      router({
        ...CHOSEN,
        backgroundTasks: { agentEnabled: true, agentSkillAuthoring: true, groupMentionOnly: true },
      }).resolveDefault('skill_authoring'),
    ).not.toBeNull();
    expect(
      router({
        ...CHOSEN,
        backgroundTasks: {
          agentEnabled: false,
          agentSkillAuthoring: true,
          groupMentionOnly: false,
        },
      }).resolveDefault('reflection'),
    ).toBeNull();
  });

  it('admit throttles agent triage per (bot, group) to one per AGENT_TRIAGE_MIN_INTERVAL_MS', () => {
    let now = 1_000_000;
    const r = router({ ...CHOSEN, ...TRIAGE_ON }, { now: () => now });
    const route = r.resolveDefault('triage')!;
    expect(r.admit(route, 'triage', 'bot_1:conv_1')).toBe(true);
    expect(r.admit(route, 'triage', 'bot_1:conv_1')).toBe(false);
    expect(r.admit(route, 'triage', 'bot_1:conv_2')).toBe(true);
    now += AGENT_TRIAGE_MIN_INTERVAL_MS - 1;
    expect(r.admit(route, 'triage', 'bot_1:conv_1')).toBe(false);
    now += 1;
    expect(r.admit(route, 'triage', 'bot_1:conv_1')).toBe(true);
    // Built-in triage is never throttled.
    const builtinRoute = router({ defaultMainModel: 'custom:m/main' }).resolveDefault('triage')!;
    expect(r.admit(builtinRoute, 'triage', 'bot_1:conv_1')).toBe(true);
    expect(r.admit(builtinRoute, 'triage', 'bot_1:conv_1')).toBe(true);
  });

  it('admit throttles reflection / summary on agents only (1 in AGENT_BACKGROUND_EVERY_N_RUNS)', () => {
    const r = router(CHOSEN);
    const agentRoute = r.resolveDefault('reflection')!;
    const decisions = Array.from({ length: AGENT_BACKGROUND_EVERY_N_RUNS * 2 }, () =>
      r.admit(agentRoute, 'reflection', 'bot_1'),
    );
    expect(decisions.filter(Boolean)).toHaveLength(2);
    expect(decisions[0]).toBe(true);
    expect(decisions[AGENT_BACKGROUND_EVERY_N_RUNS]).toBe(true);
    // Keys are independent; other purposes and built-in routes always pass.
    expect(r.admit(agentRoute, 'reflection', 'bot_2')).toBe(true);
    expect(r.admit(agentRoute, 'consolidation', 'bot_1')).toBe(true);
    const builtinRoute = router({ defaultMainModel: 'custom:m/main' }).resolveDefault(
      'reflection',
    )!;
    for (let i = 0; i < 3; i += 1) expect(r.admit(builtinRoute, 'reflection', 'bot_1')).toBe(true);
  });

  it('backgroundRunSpec adds the background session only on agent routes', () => {
    const spec = {
      identity: {
        runId: 'run_9',
        botId: 'bot_1',
        conversationId: null,
        loopType: 'wiki_maintenance',
      },
      model: 'x',
      buildSystemPrompt: async () => '',
      messages: [],
      tools: [],
      limits: { maxTurns: 5 },
    } satisfies RunSpec;
    const agentRoute = router(CHOSEN).resolveDefault('wiki_maintenance')!;
    expect(backgroundRunSpec(agentRoute, spec)).toMatchObject({
      model: 'agent:alpha/default',
      external: {
        agentId: 'alpha',
        permission: 'read_only',
        capabilities: [],
        sessionKey: 'bg:run_9',
        background: true,
      },
    });
    expect(backgroundRunSpec(agentRoute, spec).workdir).toBeUndefined();
    expect(engineKeyOf(agentRoute)).toBe('agent:alpha');
    const builtinRoute = router({ defaultMainModel: 'custom:m/main' }).resolveDefault(
      'wiki_maintenance',
    )!;
    expect(backgroundRunSpec(builtinRoute, spec)).toBe(spec);
    expect(engineKeyOf(builtinRoute)).toBe('builtin');
  });

  it('routeFor without a router keeps the pre-P6 built-in-only behaviour', () => {
    const settings = settingsSchema.parse({});
    expect(
      routeFor({ engine: builtin, settings: { get: () => settings } }, 'reflection', null),
    ).toBeNull();
    const withModel = settingsSchema.parse({ defaultMainModel: 'custom:m/main' });
    expect(
      routeFor({ engine: builtin, settings: { get: () => withModel } }, 'reflection', 'bot_x'),
    ).toMatchObject({ engine: builtin, modelRef: 'custom:m/main' });
  });
});

describe('triageOneBot through the router (P6)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A router whose bot_1 runs on alpha, agent triage opted in. */
  function agentRouter(agentEngine: AgentEngine) {
    return new LlmRouter({
      settings: {
        get: () =>
          settingsSchema.parse({
            experimental: { externalAgents: true },
            agents: { alpha: { enabled: true } },
            ...TRIAGE_ON,
          }),
      },
      bots: { get: () => bot({}, { id: 'alpha' }) },
      builtin,
      external: agentEngine,
      catalog: () => [ALPHA],
      agentView: () => ({ enabled: true, status: 'ready', statusDetail: null }) as never,
    });
  }

  function triageDeps(r: LlmRouter, timeoutMs?: number) {
    const runs = { create: vi.fn(() => ({ id: 'run_t' })), update: vi.fn() };
    const usage = { record: vi.fn() };
    const scheduler = {
      submit: vi.fn((task: { run: () => Promise<void>; provider: string }) => void task.run()),
    };
    return {
      runs,
      usage,
      scheduler,
      input: {
        engine: builtin,
        router: r,
        scheduler: scheduler as never,
        runs: runs as never,
        usage: usage as never,
        settings: { get: () => settingsSchema.parse({}) } as never,
        bots: {
          get: () => {
            const base = bot();
            return {
              ...base,
              name: 'B',
              profile: {
                ...base.profile,
                identity: { name: 'B' },
                role: { expertise: '', responsibilities: '' },
              },
            };
          },
          listActive: () => [],
        } as never,
        messages: { listForBot: () => [] } as never,
        botId: 'bot_1',
        conversationId: 'conv_1',
        batchId: 'b1',
        batchMessages: [],
        timeZone: 'UTC',
        logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} } as never,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      },
    };
  }

  it('runs on the background agent (JSON only, agent concurrency key, usage under agent:{id})', async () => {
    const complete = vi.fn(async () => ({
      text: '{"decision":"respond","confidence":0.9,"reason":"被点名"}',
      toolCalls: [],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: null },
      stopReason: 'stop',
    }));
    const agentEngine = { startRun: vi.fn(), complete } as unknown as AgentEngine;
    const r = agentRouter(agentEngine);
    const { input, scheduler, usage } = triageDeps(r);
    const decision = await triageOneBot(input);
    expect(decision).toEqual({ botId: 'bot_1', decision: 'respond', confidence: 0.9 });
    expect(scheduler.submit.mock.calls[0]![0].provider).toBe('agent:alpha');
    const [req] = complete.mock.calls[0]! as unknown as [
      { model: string; tools?: unknown; systemPrompt: string },
    ];
    expect(req.model).toBe('agent:alpha/default');
    expect(req.tools).toBeUndefined();
    expect(req.systemPrompt).toContain('<output_format>');
    expect(usage.record).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'agent:alpha', model: 'default', loopType: 'triage' }),
    );
  });

  it('the timeout counts from submission: a triage queued behind busy slots fails open and leaves the queue (审查 M6)', async () => {
    vi.useFakeTimers();
    const complete = vi.fn();
    const r = agentRouter({ startRun: vi.fn(), complete } as unknown as AgentEngine);
    const { input } = triageDeps(r);
    // The agent's slots are all busy (long tasks): the job never starts.
    const queued: Array<{ key: string }> = [];
    const cancelQueued = vi.fn((key: string) => queued.some((job) => job.key === key));
    const scheduler = {
      submit: vi.fn((job: { key: string }) => void queued.push(job)),
      cancelQueued,
    };
    const pending = triageOneBot({ ...input, scheduler: scheduler as never });
    await vi.advanceTimersByTimeAsync(AGENT_TRIAGE_TIMEOUT_MS + 1);
    expect(await pending).toEqual({ botId: 'bot_1', decision: 'no_action', confidence: 0 });
    expect(cancelQueued).toHaveBeenCalledWith(queued[0]!.key);
    expect(complete).not.toHaveBeenCalled();
  });

  it('a slow agent times out into no_action', async () => {
    const agentEngine = {
      startRun: vi.fn(),
      complete: vi.fn(() => new Promise(() => {})),
    } as unknown as AgentEngine;
    const r = agentRouter(agentEngine);
    const { input } = triageDeps(r, 30);
    expect(await triageOneBot(input)).toEqual({
      botId: 'bot_1',
      decision: 'no_action',
      confidence: 0,
    });
  });

  it('agent triage: longer default timeout; a second batch within the interval is not triaged', async () => {
    vi.useFakeTimers();
    const complete = vi.fn(() => new Promise(() => {}));
    const r = agentRouter({ startRun: vi.fn(), complete } as unknown as AgentEngine);
    const { input } = triageDeps(r);
    let decided = false;
    const pending = triageOneBot(input).then((decision) => {
      decided = true;
      return decision;
    });
    await vi.advanceTimersByTimeAsync(TRIAGE_TIMEOUT_MS + 1);
    expect(decided).toBe(false);
    await vi.advanceTimersByTimeAsync(AGENT_TRIAGE_TIMEOUT_MS - TRIAGE_TIMEOUT_MS);
    expect(await pending).toMatchObject({ decision: 'no_action' });
    // Same bot + group right after: throttled — no second agent call.
    expect(await triageOneBot(triageDeps(r).input)).toMatchObject({ decision: 'no_action' });
    expect(complete).toHaveBeenCalledTimes(1);
  });
});
