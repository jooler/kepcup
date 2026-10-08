import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AGENT_CATALOG,
  AGENT_DEFAULT_CONCURRENCY,
  agentModelRef,
  settingsSchema,
  type AgentCatalogEntry,
  type Settings,
} from '@kepcup/shared';
import {
  agentTurn,
  fakeAgentEntry,
  fakeAgentSpawner,
  type FakeAcpAgentHandle,
  type FakeAgentScript,
} from '@kepcup/testkit';
import { ExternalAgentEngine } from '../../src/agent/external/engine.js';
import { AgentHost } from '../../src/agent/external/host.js';
import {
  agentConcurrency,
  parallelSessionsFor,
  PROVIDERS,
} from '../../src/agent/external/providers/index.js';
import { genericAcpProvider } from '../../src/agent/external/providers/generic-acp.js';
import type { ProviderRegistry } from '../../src/agent/external/types.js';
import { agentBackgroundBlocker } from '../../src/agent/llm-router.js';
import type { RunOutcome, RunSpec } from '../../src/agent/types.js';
import { Scheduler } from '../../src/scheduler/scheduler.js';

/**
 * D72 `features.parallelSessions`（design 28 §7 / §9.2）：同一 Agent 的多个
 * 会话共用一个进程，只有经适配器源码核对能同进程并行会话的 Provider 才按
 * `AGENT_DEFAULT_CONCURRENCY` / 用户覆盖并发；其余并发恒为 1（覆盖被钳到
 * 1），也不合格后台路由。
 */

const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never;

/** Per-provider values, each backed by evidence next to the provider's `features`. */
const EXPECTED: Readonly<Record<string, boolean>> = {
  'generic-acp': false,
  claude: true,
  codex: true,
  opencode: true,
  dsh: true,
  cursor: false,
  antigravity: false,
};

function settings(patch: Partial<Settings> = {}): Settings {
  return settingsSchema.parse({ experimental: { externalAgents: true }, ...patch });
}

function catalogEntry(id: string): AgentCatalogEntry {
  return AGENT_CATALOG.find((entry) => entry.id === id)!;
}

describe('features.parallelSessions per provider', () => {
  it('every registered provider declares it, with the evidence-backed value', () => {
    expect(Object.keys(PROVIDERS).sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const [id, provider] of Object.entries(PROVIDERS)) {
      expect(typeof provider.features.parallelSessions, id).toBe('boolean');
      expect(provider.features.parallelSessions, id).toBe(EXPECTED[id]);
    }
  });

  it('the testkit fake agent is exempt (per-session state, never shipped)', () => {
    const fake = catalogEntry('fake');
    expect(fake.provider).toBe('generic-acp');
    expect(parallelSessionsFor(fake, genericAcpProvider)).toBe(true);
    const unknown = fakeAgentEntry('vendor-x', { releaseGate: 'vendor-x' });
    expect(parallelSessionsFor(unknown, genericAcpProvider)).toBe(false);
  });
});

describe('agentConcurrency (scheduler / router / settings view)', () => {
  it('defaults per feature: AGENT_DEFAULT_CONCURRENCY with parallel sessions, else 1', () => {
    const none = { default: 4 };
    for (const entry of AGENT_CATALOG) {
      const parallel = parallelSessionsFor(entry, PROVIDERS[entry.provider]!);
      expect(agentConcurrency(none, entry), entry.id).toBe(
        parallel ? AGENT_DEFAULT_CONCURRENCY : 1,
      );
    }
    expect(agentConcurrency(none, catalogEntry('claude-acp'))).toBe(AGENT_DEFAULT_CONCURRENCY);
    expect(agentConcurrency(none, catalogEntry('antigravity'))).toBe(1);
  });

  it('honours overrides with parallel sessions; clamps them to 1 without (fail-safe)', () => {
    const config = { default: 4, 'agent:codex-acp': 3, 'agent:antigravity': 4 };
    expect(agentConcurrency(config, catalogEntry('codex-acp'))).toBe(3);
    expect(agentConcurrency(config, catalogEntry('antigravity'))).toBe(1);
    expect(agentConcurrency({ default: 4, 'agent:codex-acp': 99 }, catalogEntry('codex-acp'))).toBe(
      16,
    );
    // An unregistered provider is treated as not verified.
    const orphan = fakeAgentEntry('orphan', { provider: 'nope', releaseGate: 'nope' });
    expect(agentConcurrency({ default: 4, 'agent:orphan': 3 }, orphan)).toBe(1);
  });

  it('the scheduler applies it through its resolver; without one agents run one at a time', () => {
    const catalog = [...AGENT_CATALOG];
    const scheduler = new Scheduler(logger, {
      agentConcurrency: (agentId, config) => {
        const entry = catalog.find((candidate) => candidate.id === agentId);
        return entry === undefined ? 1 : agentConcurrency(config, entry);
      },
    });
    expect(scheduler.concurrencyFor('agent:claude-acp')).toBe(AGENT_DEFAULT_CONCURRENCY);
    expect(scheduler.concurrencyFor('agent:antigravity')).toBe(1);
    expect(scheduler.concurrencyFor('agent:not-in-catalog')).toBe(1);
    expect(scheduler.concurrencyFor('openai')).toBe(4);
    scheduler.setConcurrency({ default: 6, 'agent:codex-acp': 3, 'agent:antigravity': 3 });
    expect(scheduler.concurrencyFor('agent:codex-acp')).toBe(3);
    expect(scheduler.concurrencyFor('agent:antigravity')).toBe(1);
    expect(scheduler.concurrencyFor('openai')).toBe(6);
    expect(new Scheduler(logger).concurrencyFor('agent:claude-acp')).toBe(1);
  });

  it('agents without parallel sessions are not eligible for background work', () => {
    const claude = fakeAgentEntry('claude-x', { provider: 'claude', releaseGate: 'claude' });
    expect(agentBackgroundBlocker(settings(), claude)).toBeNull();
    // Same provider, but declared without parallel sessions.
    const serial: ProviderRegistry = {
      ...PROVIDERS,
      claude: {
        ...PROVIDERS.claude!,
        features: { ...PROVIDERS.claude!.features, parallelSessions: false },
      },
    };
    expect(agentBackgroundBlocker(settings(), claude, serial)).toMatch(/该智能体未验证可并行会话/);
    // An override cannot lift it.
    expect(
      agentBackgroundBlocker(
        settings({ providerConcurrency: { default: 4, 'agent:claude-x': 4 } }),
        claude,
        serial,
      ),
    ).toMatch(/未验证可并行会话/);
  });
});

describe('the clamp end to end (fake agent refusing concurrent prompts)', () => {
  const dirs: string[] = [];
  const hosts: AgentHost[] = [];
  const schedulers: Scheduler[] = [];
  afterEach(() => {
    for (const scheduler of schedulers.splice(0)) scheduler.stop();
    for (const host of hosts.splice(0)) host.dispose();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  // Not a testkit entry: the generic provider's `parallelSessions: false` holds.
  const SERIAL = fakeAgentEntry('serial', { releaseGate: 'serial-test' });

  function setup(resolver: (config: Readonly<Record<string, number | undefined>>) => number) {
    const workdir = mkdtempSync(path.join(tmpdir(), 'kepcup-parallel-'));
    dirs.push(workdir);
    const started: FakeAcpAgentHandle[] = [];
    const script: FakeAgentScript = {
      serialPrompts: true,
      turns: [agentTurn().sleep(150).text('one'), agentTurn().sleep(150).text('two')],
    };
    const host = new AgentHost({
      logger,
      redact: (text) => text,
      appVersion: '1.0.0',
      resolveLaunch: () => ({ command: 'unused', args: [], env: {} }),
      spawn: fakeAgentSpawner({ [SERIAL.id]: script }, started) as never,
    });
    hosts.push(host);
    const engine = new ExternalAgentEngine({
      host,
      catalog: () => [SERIAL],
      logger,
      cancelGraceMs: 300,
    });
    const scheduler = new Scheduler(logger, {
      agentConcurrency: (_agentId, config) => resolver(config),
    });
    schedulers.push(scheduler);
    const spec = (conversationId: string): RunSpec => ({
      identity: {
        runId: `run_${conversationId}`,
        botId: 'bot_1',
        conversationId,
        loopType: 'turn',
      },
      model: agentModelRef(SERIAL.id, ''),
      buildSystemPrompt: async () => 'SYSTEM',
      messages: [{ role: 'user', content: 'HELLO', timestamp: 0 }],
      promptParts: {
        session: 'SESSION-PROMPT',
        run: 'RUN',
        conversation: 'FULL',
        conversationDelta: 'DELTA',
      },
      tools: [],
      limits: { maxTurns: 60 },
      workdir,
      external: {
        agentId: SERIAL.id,
        permission: 'read_only',
        capabilities: [],
        sessionKey: `bot_1:${conversationId}:${SERIAL.id}`,
      },
    });
    const runTwo = () =>
      Promise.all(
        ['conv_a', 'conv_b'].map(
          (conversationId) =>
            new Promise<RunOutcome>((resolve) => {
              scheduler.submit({
                priority: 0,
                provider: `agent:${SERIAL.id}`,
                key: `bot_1:${conversationId}`,
                run: async () => {
                  resolve(await engine.startRun(spec(conversationId)).done);
                },
              });
            }),
        ),
      );
    return { runTwo, started };
  }

  it('without the clamp two conversations prompt concurrently and the agent refuses one', async () => {
    const { runTwo } = setup(() => 2);
    const outcomes = await runTwo();
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['completed', 'failed']);
  });

  it('agentConcurrency clamps an override to 1: both conversations complete in turn', async () => {
    const { runTwo, started } = setup((config) =>
      agentConcurrency({ ...config, [`agent:${SERIAL.id}`]: 3 }, SERIAL),
    );
    const outcomes = await runTwo();
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['completed', 'completed']);
    expect(outcomes.map((outcome) => outcome.finalText)).toEqual(['one', 'two']);
    // One process, two sessions, prompts strictly one after the other.
    expect(started).toHaveLength(1);
    expect(new Set(started[0]!.observed.prompts.map((prompt) => prompt.sessionId)).size).toBe(2);
  });
});
