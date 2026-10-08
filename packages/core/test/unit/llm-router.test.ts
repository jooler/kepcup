import { describe, expect, it, vi } from 'vitest';
import {
  AGENT_BACKGROUND_EVERY_N_RUNS,
  settingsSchema,
  type AgentView,
  type Bot,
  type Settings,
} from '@kepcup/shared';
import { fakeAgentEntry } from '@kepcup/testkit';
import {
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
  options: { bot?: Bot; ready?: string[]; withExternal?: boolean } = {},
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
  });
}

describe('LlmRouter', () => {
  it('built-in models win, with the per-purpose model rules of the old call sites', () => {
    const withModels = router({
      defaultMainModel: 'custom:m/main',
      defaultLightModel: 'custom:m/light',
    });
    const b = bot({ model: 'custom:b/main', light_model: 'custom:b/light' });
    const cases: Array<[LlmPurpose, string]> = [
      ['triage', 'custom:b/light'],
      ['continuation', 'custom:b/light'],
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

  it('no built-in model: the first ready agent, the bot’s own agent first, or the chosen one', () => {
    expect(router({}, { ready: ['beta'] }).resolveDefault('reflection')).toEqual({
      engine: external,
      modelRef: 'agent:beta/default',
      provider: 'agent:beta',
      agentId: 'beta',
    });
    const own = bot({}, { id: 'beta', model: 'beta-pro' });
    expect(router({}, { bot: own }).resolveForBot(own, 'summary')?.modelRef).toBe(
      'agent:beta/beta-pro',
    );
    expect(router({}, { bot: own }).resolveForBot('bot_1', 'summary')?.agentId).toBe('beta');
    // Explicit choice: used as is; never swapped for another agent when unusable.
    expect(
      router({ backgroundAgentId: 'alpha' }, { bot: own }).resolveForBot(own, 'summary'),
    ).toMatchObject({
      modelRef: 'agent:alpha/default',
    });
    expect(
      router({ backgroundAgentId: 'alpha' }, { ready: ['beta'] }).resolveDefault('summary'),
    ).toBeNull();
    // Nothing usable / no external engine / experimental off → skip (P4 fallback).
    expect(router({}, { ready: [] }).resolveDefault('summary')).toBeNull();
    expect(router({}, { withExternal: false }).resolveDefault('summary')).toBeNull();
    expect(
      router({ experimental: { externalAgents: false } }).resolveDefault('summary'),
    ).toBeNull();
  });

  it('agent-only degradations: L2 off, skill authoring opt-in, mention-only groups, off switch', () => {
    const r = router();
    expect(r.resolveDefault('continuation')).toBeNull();
    expect(r.resolveDefault('skill_authoring')).toBeNull();
    expect(r.resolveDefault('triage')).not.toBeNull();
    expect(
      router({
        backgroundTasks: { agentEnabled: true, agentSkillAuthoring: true, groupMentionOnly: true },
      }).resolveDefault('skill_authoring'),
    ).not.toBeNull();
    expect(
      router({
        backgroundTasks: { agentEnabled: true, agentSkillAuthoring: false, groupMentionOnly: true },
      }).resolveDefault('triage'),
    ).toBeNull();
    expect(
      router({
        backgroundTasks: {
          agentEnabled: false,
          agentSkillAuthoring: true,
          groupMentionOnly: false,
        },
      }).resolveDefault('reflection'),
    ).toBeNull();
  });

  it('admit throttles reflection / summary on agents only (1 in AGENT_BACKGROUND_EVERY_N_RUNS)', () => {
    const r = router();
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
    const agentRoute = router().resolveDefault('wiki_maintenance')!;
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
        messages: { list: () => [] } as never,
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
    const r = new LlmRouter({
      settings: {
        get: () =>
          settingsSchema.parse({
            experimental: { externalAgents: true },
            agents: { alpha: { enabled: true } },
          }),
      },
      bots: { get: () => bot() },
      builtin,
      external: agentEngine,
      catalog: () => [ALPHA],
      agentView: () => ({ enabled: true, status: 'ready', statusDetail: null }) as never,
    });
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

  it('a slow agent times out into no_action', async () => {
    const agentEngine = {
      startRun: vi.fn(),
      complete: vi.fn(() => new Promise(() => {})),
    } as unknown as AgentEngine;
    const r = new LlmRouter({
      settings: {
        get: () =>
          settingsSchema.parse({
            experimental: { externalAgents: true },
            agents: { alpha: { enabled: true } },
          }),
      },
      bots: { get: () => bot() },
      builtin,
      external: agentEngine,
      catalog: () => [ALPHA],
      agentView: () => ({ enabled: true, status: 'ready', statusDetail: null }) as never,
    });
    const { input } = triageDeps(r, 30);
    expect(await triageOneBot(input)).toEqual({
      botId: 'bot_1',
      decision: 'no_action',
      confidence: 0,
    });
  });
});
