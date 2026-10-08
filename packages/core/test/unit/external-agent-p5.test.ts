import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Type } from '@earendil-works/pi-ai';
import {
  AGENT_CATALOG,
  AGENT_DEFAULT_CONCURRENCY,
  AGENT_TURN_BUDGET_TOKENS,
  agentModelRef,
} from '@kepcup/shared';
import {
  agentTurn,
  fakeAgentSpawner,
  type FakeAcpAgentHandle,
  type FakeAgentScript,
} from '@kepcup/testkit';
import { AcpEventMapper, ExternalAgentEngine } from '../../src/agent/external/engine.js';
import { AgentHost } from '../../src/agent/external/host.js';
import { HostMcpBridge } from '../../src/agent/external/mcp-bridge.js';
import { genericAcpProvider } from '../../src/agent/external/providers/generic-acp.js';
import { claudeProvider, CLAUDE_PROCESS_ENV } from '../../src/agent/external/providers/claude.js';
import { codexProvider } from '../../src/agent/external/providers/codex.js';
import type { AgentProvider, ProviderRegistry } from '../../src/agent/external/types.js';
import type {
  AgentSessionMode,
  EngineEvent,
  RunHandle,
  RunSpec,
  ToolDefinition,
} from '../../src/agent/types.js';
import { Scheduler } from '../../src/scheduler/scheduler.js';
import { openDatabase } from '../../src/infra/db.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { migrationsUrl } from '../../src/start.js';
import { runMigrations } from '../../src/infra/migrate.js';
import { UsageService } from '../../src/domain/usage.js';

/**
 * 外部智能体 P5 第二部分（todo §8.1）：steering、会话复用（同进程 / resume /
 * load / 新建、指纹、桥 token 随会话）、用量（turn / session 口径、缺失记轮数、
 * 连锁预算）、子代理调用不切分、状态行标题、桥工具转入后台 + follow-up、
 * 丢弃会话、调度器并发缺省。
 */

const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never;
const FAKE = AGENT_CATALOG.find((entry) => entry.id === 'fake')!;

function withFeatures(
  features: Partial<AgentProvider['features']>,
  extra: Partial<AgentProvider> = {},
) {
  return {
    'generic-acp': {
      ...genericAcpProvider,
      ...extra,
      features: { ...genericAcpProvider.features, ...features },
    },
  } satisfies ProviderRegistry;
}

async function eventually<T>(probe: () => T | null | undefined, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const dirs: string[] = [];
const hosts: AgentHost[] = [];
const bridges: HostMcpBridge[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) host.dispose();
  for (const bridge of bridges.splice(0)) await bridge.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function setup(
  scripts: FakeAgentScript | FakeAgentScript[],
  options: { providers?: ProviderRegistry; bridge?: boolean } = {},
) {
  const workdir = mkdtempSync(path.join(tmpdir(), 'kepcup-p5-'));
  dirs.push(workdir);
  const started: FakeAcpAgentHandle[] = [];
  const host = new AgentHost({
    logger,
    redact: (text) => text,
    appVersion: '1.0.0',
    resolveLaunch: () => ({ command: 'unused', args: [], env: {} }),
    spawn: fakeAgentSpawner({ [FAKE.id]: scripts }, started) as never,
    ...(options.providers !== undefined ? { providers: options.providers } : {}),
  });
  hosts.push(host);
  let bridge: HostMcpBridge | undefined;
  if (options.bridge === true) {
    bridge = new HostMcpBridge({ logger, appVersion: '1.0.0' });
    await bridge.start();
    bridges.push(bridge);
  }
  const engine = new ExternalAgentEngine({
    host,
    ...(bridge !== undefined ? { bridge } : {}),
    catalog: () => [FAKE],
    logger,
    cancelGraceMs: 300,
  });
  let counter = 0;
  const spec = (
    overrides: Partial<RunSpec> = {},
    external: Partial<RunSpec['external']> = {},
  ): RunSpec => {
    counter += 1;
    return {
      identity: {
        runId: `run_${counter}`,
        botId: 'bot_1',
        conversationId: 'conv_1',
        loopType: 'response',
      },
      model: agentModelRef(FAKE.id, ''),
      buildSystemPrompt: async () => 'SYSTEM',
      messages: [{ role: 'user', content: 'HELLO', timestamp: 0 }],
      promptParts: {
        session: 'SESSION-PROMPT',
        run: `RUN-${counter}`,
        conversation: `FULL-${counter}`,
        conversationDelta: `DELTA-${counter}`,
      },
      tools: [],
      limits: { maxTurns: 60 },
      workdir,
      ...overrides,
      external: {
        agentId: FAKE.id,
        permission: 'read_only',
        capabilities: [],
        sessionKey: 'bot_1:conv_1:fake',
        ...external,
      },
    };
  };
  return { engine, host, started, spec, workdir, bridge };
}

function collect(handle: RunHandle): EngineEvent[] {
  const events: EngineEvent[] = [];
  handle.onEvent((event) => events.push(event));
  return events;
}

describe('ACP steering (P5)', () => {
  it('injects a steer into the running prompt with idleBehavior promptRequired', async () => {
    const { engine, started, spec } = await setup(
      { steering: true, turns: [agentTurn().sleep(150).echoSteers().text(' 完')] },
      { providers: withFeatures({ steering: true }) },
    );
    const rejected: string[] = [];
    const handle = engine.startRun(spec({ onSteerRejected: (text) => rejected.push(text) }));
    const events = collect(handle);
    await eventually(() => started[0]?.observed.prompts.length === 1);
    expect(handle.steer('补充一句')).toBe(true);
    const outcome = await handle.done;
    expect(outcome).toMatchObject({ status: 'completed', finalText: 'steered: 补充一句 完' });
    expect(started[0]!.observed.steerings[0]).toMatchObject({
      sessionId: 'fake-session-1',
      prompt: [{ type: 'text', text: '补充一句' }],
      _meta: { steering: { idleBehavior: 'promptRequired' } },
    });
    expect(events.filter((event) => event.type === 'steer')).toEqual([
      { type: 'steer', payload: { text: '补充一句' } },
    ]);
    expect(rejected).toEqual([]);
  });

  it.each(['promptRequired', 'startedNewTurn', 'error'] as const)(
    'hands a refused steer back (%s)',
    async (steeringOutcome) => {
      const { engine, started, spec } = await setup(
        { steering: true, steeringOutcome, turns: [agentTurn().sleep(200).text('ok')] },
        { providers: withFeatures({ steering: true }) },
      );
      const rejected: string[] = [];
      const handle = engine.startRun(spec({ onSteerRejected: (text) => rejected.push(text) }));
      const events = collect(handle);
      await eventually(() => started[0]?.observed.prompts.length === 1);
      expect(handle.steer('再说一句')).toBe(true);
      await eventually(() => (rejected.length === 1 ? true : null));
      expect(rejected).toEqual(['再说一句']);
      await handle.done;
      expect(events.some((event) => event.type === 'steer')).toBe(false);
      // A detached turn the agent started on its own is cancelled.
      if (steeringOutcome === 'startedNewTurn') {
        expect(started[0]!.observed.cancels).toContain('fake-session-1');
      }
    },
  );

  it('without provider steering a running prompt refuses; before the prompt it merges', async () => {
    const { engine, started, spec } = await setup({
      steering: true,
      turns: [agentTurn().sleep(150).text('ok')],
    });
    const handle = engine.startRun(spec());
    const events = collect(handle);
    // Not prompted yet: joins the prompt (any provider).
    expect(handle.steer('先到的')).toBe(true);
    await eventually(() => started[0]?.observed.prompts.length === 1);
    expect(started[0]!.observed.prompts[0]!.text).toContain('先到的');
    expect(handle.steer('后到的')).toBe(false);
    await handle.done;
    expect(handle.steer('结束后')).toBe(false);
    expect(started[0]!.observed.steerings).toEqual([]);
    expect(events.filter((event) => event.type === 'steer')).toHaveLength(1);
  });

  it('a run that fails before prompting hands its merged steers back', async () => {
    const { engine, spec } = await setup({ requireAuth: true, turns: [] });
    const rejected: string[] = [];
    const handle = engine.startRun(spec({ onSteerRejected: (text) => rejected.push(text) }));
    expect(handle.steer('还没发')).toBe(true);
    expect((await handle.done).status).toBe('failed');
    expect(rejected).toEqual(['还没发']);
  });
});

describe('agent session reuse (P5)', () => {
  it('reuses the kept session in the same process: delta only, no session prompt', async () => {
    const { engine, started, spec } = await setup({
      turns: [agentTurn().text('一'), agentTurn().text('二')],
    });
    const modes: AgentSessionMode[] = [];
    const ids: string[] = [];
    const onSession = (id: string, mode: AgentSessionMode) => {
      ids.push(id);
      modes.push(mode);
    };
    const first = engine.startRun(
      spec({}, { session: { reuseId: null, fingerprint: 'fp' }, onSession }),
    );
    expect((await first.done).finalText).toBe('一');
    const second = engine.startRun(
      spec({}, { session: { reuseId: ids[0]!, fingerprint: 'fp' }, onSession }),
    );
    const events = collect(second);
    expect((await second.done).finalText).toBe('二');
    expect(modes).toEqual(['new', 'reused']);
    expect(ids).toEqual(['fake-session-1', 'fake-session-1']);
    const observed = started[0]!.observed;
    expect(observed.sessions).toHaveLength(1);
    expect(observed.closedSessions).toEqual([]);
    expect(observed.prompts[0]!.text).toContain('SESSION-PROMPT');
    expect(observed.prompts[0]!.text).toContain('FULL-1');
    expect(observed.prompts[1]!.text).not.toContain('SESSION-PROMPT');
    expect(observed.prompts[1]!.text).toContain('RUN-2');
    expect(observed.prompts[1]!.text).toContain('DELTA-2');
    expect(observed.prompts[1]!.text).not.toContain('FULL-2');
    expect(events[0]).toMatchObject({ type: 'request', payload: { session: 'reused' } });
  });

  it('a changed fingerprint starts a new session and closes the kept one', async () => {
    const { engine, started, spec } = await setup({
      sessionClose: true,
      turns: [agentTurn().text('一'), agentTurn().text('二')],
    });
    const ids: string[] = [];
    const onSession = (id: string) => ids.push(id);
    await engine.startRun(spec({}, { session: { reuseId: null, fingerprint: 'a' }, onSession }))
      .done;
    await engine.startRun(spec({}, { session: { reuseId: ids[0]!, fingerprint: 'b' }, onSession }))
      .done;
    expect(ids).toEqual(['fake-session-1', 'fake-session-2']);
    expect(started[0]!.observed.prompts[1]!.text).toContain('FULL-2');
    await eventually(() => started[0]!.observed.closedSessions.length === 1);
    expect(started[0]!.observed.closedSessions).toEqual(['fake-session-1']);
  });

  it('runs without session reuse keep the P1 behavior (session closed with the run)', async () => {
    const { engine, started, spec } = await setup({
      sessionClose: true,
      turns: [agentTurn().text('一')],
    });
    await engine.startRun(spec()).done;
    await eventually(() => started[0]!.observed.closedSessions.length === 1);
  });

  it('after the process is gone: resume (with a fresh bridge token) when supported', async () => {
    const script: FakeAgentScript = {
      resume: true,
      turns: [agentTurn().text('一')],
    };
    const { engine, host, started, spec } = await setup(
      [script, { resume: true, turns: [agentTurn().text('二')] }],
      { providers: withFeatures({ resume: true }), bridge: true },
    );
    const tool: ToolDefinition = {
      name: 'remember',
      description: 'r',
      parameters: Type.Object({}),
      execute: async () => ({ ok: true, content: 'ok' }),
    };
    const ids: string[] = [];
    const modes: AgentSessionMode[] = [];
    const onSession = (id: string, mode: AgentSessionMode) => {
      ids.push(id);
      modes.push(mode);
    };
    await engine.startRun(
      spec(
        { tools: [tool] },
        {
          session: { reuseId: null, fingerprint: 'fp' },
          hostServerName: 'kepcup_aaaa0000',
          onSession,
        },
      ),
    ).done;
    expect(host.stop(FAKE.id)).toBe(true);
    await eventually(() => !host.isRunning(FAKE.id));
    const second = engine.startRun(
      spec(
        { tools: [tool] },
        {
          session: { reuseId: ids[0]!, fingerprint: 'fp' },
          hostServerName: 'kepcup_aaaa0000',
          onSession,
        },
      ),
    );
    expect((await second.done).finalText).toBe('二');
    expect(modes).toEqual(['new', 'resumed']);
    const resumed = started[1]!.observed.resumedSessions;
    expect(resumed).toHaveLength(1);
    expect(resumed[0]!.sessionId).toBe('fake-session-1');
    const firstToken = JSON.stringify(started[0]!.observed.sessions[0]!.mcpServers);
    const resumedServers = JSON.stringify(resumed[0]!.mcpServers);
    expect(resumedServers).toContain('kepcup_aaaa0000');
    expect(resumedServers).not.toBe(firstToken);
    expect(started[1]!.observed.prompts[0]!.text).toContain('DELTA-2');
  });

  it('falls back to session/load (replay muted), then to a new session', async () => {
    const history = [agentTurn().text('旧的回放').toolCall('h1', 'Old').actions].flat();
    const { engine, host, started, spec } = await setup(
      [
        { history, turns: [agentTurn().text('一')] },
        { history, turns: [agentTurn().text('二')] },
      ],
      { providers: withFeatures({ loadSession: true }) },
    );
    const ids: string[] = [];
    const modes: AgentSessionMode[] = [];
    const onSession = (id: string, mode: AgentSessionMode) => {
      ids.push(id);
      modes.push(mode);
    };
    await engine.startRun(spec({}, { session: { reuseId: null, fingerprint: 'fp' }, onSession }))
      .done;
    host.stop(FAKE.id);
    await eventually(() => !host.isRunning(FAKE.id));
    const second = engine.startRun(
      spec({}, { session: { reuseId: ids[0]!, fingerprint: 'fp' }, onSession }),
    );
    const events = collect(second);
    expect((await second.done).finalText).toBe('二');
    expect(modes).toEqual(['new', 'loaded']);
    expect(started[1]!.observed.loadedSessions).toEqual(['fake-session-1']);
    // The replay never reaches the run.
    expect(JSON.stringify(events)).not.toContain('旧的回放');
    expect(events.some((event) => event.type === 'tool_call')).toBe(false);
  });

  it('without resume / load a lost session is replaced by a new one (full context)', async () => {
    const { engine, host, started, spec } = await setup([
      { turns: [agentTurn().text('一')] },
      { turns: [agentTurn().text('二')] },
    ]);
    const modes: AgentSessionMode[] = [];
    const ids: string[] = [];
    const onSession = (id: string, mode: AgentSessionMode) => {
      ids.push(id);
      modes.push(mode);
    };
    await engine.startRun(spec({}, { session: { reuseId: null, fingerprint: 'fp' }, onSession }))
      .done;
    host.stop(FAKE.id);
    await eventually(() => !host.isRunning(FAKE.id));
    await engine.startRun(spec({}, { session: { reuseId: ids[0]!, fingerprint: 'fp' }, onSession }))
      .done;
    expect(modes).toEqual(['new', 'new']);
    expect(started[1]!.observed.prompts[0]!.text).toContain('SESSION-PROMPT');
    expect(started[1]!.observed.prompts[0]!.text).toContain('FULL-2');
  });

  it('a crashed process fails the active run; the next run can still continue the session', async () => {
    const { engine, started, spec } = await setup(
      [
        { resume: true, turns: [agentTurn().text('半截').crash()] },
        { resume: true, turns: [agentTurn().text('恢复了')] },
      ],
      { providers: withFeatures({ resume: true }) },
    );
    const ids: string[] = [];
    const onSession = (id: string) => ids.push(id);
    const first = await engine.startRun(
      spec({}, { session: { reuseId: null, fingerprint: 'fp' }, onSession }),
    ).done;
    expect(first.status).toBe('failed');
    const second = await engine.startRun(
      spec({}, { session: { reuseId: ids[0]!, fingerprint: 'fp' }, onSession }),
    ).done;
    expect(second).toMatchObject({ status: 'completed', finalText: '恢复了' });
    expect(started[1]!.observed.resumedSessions.map((s) => s.sessionId)).toEqual([
      'fake-session-1',
    ]);
  });

  it('discardSession deletes a kept session when supported (else closes it)', async () => {
    const { engine, started, spec } = await setup({
      sessionDelete: true,
      sessionClose: true,
      turns: [agentTurn().text('一')],
    });
    const ids: string[] = [];
    await engine.startRun(
      spec({}, { session: { reuseId: null, fingerprint: 'fp' }, onSession: (id) => ids.push(id) }),
    ).done;
    await engine.discardSession({
      agentId: FAKE.id,
      agentSessionId: ids[0]!,
      sessionKey: 'bot_1:conv_1:fake',
      deleteHistory: true,
    });
    expect(started[0]!.observed.deletedSessions).toEqual(['fake-session-1']);
    // Gone from the process: discarding again is a no-op.
    await engine.discardSession({
      agentId: FAKE.id,
      agentSessionId: ids[0]!,
      sessionKey: 'bot_1:conv_1:fake',
      deleteHistory: true,
    });
    expect(started[0]!.observed.deletedSessions).toHaveLength(1);
  });

  it('a session discarded while its run is active is deleted on release, not kept', async () => {
    const { engine, started, spec } = await setup({
      sessionDelete: true,
      turns: [agentTurn().sleep(150).text('一')],
    });
    const ids: string[] = [];
    const handle = engine.startRun(
      spec({}, { session: { reuseId: null, fingerprint: 'fp' }, onSession: (id) => ids.push(id) }),
    );
    await eventually(() => ids.length === 1);
    await engine.discardSession({
      agentId: FAKE.id,
      agentSessionId: ids[0]!,
      sessionKey: 'bot_1:conv_1:fake',
      deleteHistory: true,
    });
    await handle.done;
    await eventually(() => started[0]!.observed.deletedSessions.length === 1);
  });
});

describe('external agent usage (P5)', () => {
  it('session-cumulative usage is diffed per prompt', async () => {
    const usage = (input: number, output: number) => ({
      inputTokens: input,
      outputTokens: output,
      totalTokens: input + output,
    });
    const { engine, spec } = await setup({
      turns: [
        agentTurn().text('一').usage(usage(100, 10)),
        agentTurn().text('二').usage(usage(250, 30)),
      ],
    });
    const ids: string[] = [];
    const first = await engine.startRun(
      spec({}, { session: { reuseId: null, fingerprint: 'fp' }, onSession: (id) => ids.push(id) }),
    ).done;
    const second = await engine.startRun(
      spec({}, { session: { reuseId: ids[0]!, fingerprint: 'fp' } }),
    ).done;
    expect(first.usage).toEqual([
      { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, costUsd: null },
    ]);
    expect(second.usage).toEqual([
      { input: 150, output: 20, cacheRead: 0, cacheWrite: 0, costUsd: null },
    ]);
  });

  it("per-turn providers ('turn') take the report as is", async () => {
    const { engine, spec } = await setup(
      {
        turns: [
          agentTurn().text('一').usage({ inputTokens: 100, outputTokens: 10, totalTokens: 110 }),
          agentTurn().text('二').usage({ inputTokens: 120, outputTokens: 12, totalTokens: 132 }),
        ],
      },
      { providers: withFeatures({}, { usageSemantics: 'turn' }) },
    );
    const ids: string[] = [];
    await engine.startRun(
      spec({}, { session: { reuseId: null, fingerprint: 'fp' }, onSession: (id) => ids.push(id) }),
    ).done;
    const second = await engine.startRun(
      spec({}, { session: { reuseId: ids[0]!, fingerprint: 'fp' } }),
    ).done;
    expect(second.usage).toEqual([
      { input: 120, output: 12, cacheRead: 0, cacheWrite: 0, costUsd: null },
    ]);
  });

  it('missing usage records one zero entry per model round; the chain budget counts rounds', async () => {
    const { engine, started, spec } = await setup({
      turns: [
        agentTurn()
          .text('先看看')
          .toolCall('t1', 'Read a', { kind: 'read' })
          .toolResult('t1', 'A')
          .sleep(150)
          .text('好了'),
      ],
    });
    const handle = engine.startRun(spec());
    await eventually(() => started[0]?.observed.prompts.length === 1);
    await eventually(() => (handle.tokensSoFar() >= AGENT_TURN_BUDGET_TOKENS ? true : null));
    const outcome = await handle.done;
    expect(outcome.usage).toHaveLength(2);
    expect(outcome.usage.every((entry) => entry.input === 0 && entry.costUsd === null)).toBe(true);
    expect(handle.tokensSoFar()).toBe(2 * AGENT_TURN_BUDGET_TOKENS);
  });

  it('UsageService.sumForRuns charges token-less agent rows per round', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'kepcup-usage-'));
    dirs.push(dir);
    const db = openDatabase({
      path: path.join(dir, 'main.db'),
      key: deriveKey(Buffer.alloc(32, 7), KEY_INFO.mainDb),
    });
    try {
      runMigrations(db, migrationsUrl('main'));
      const usage = new UsageService(db, { now: () => 1 } as never);
      const base = { botId: null, conversationId: null, loopType: 'response' as const };
      usage.record({
        ...base,
        runId: 'r1',
        provider: 'agent:fake',
        model: 'default',
        inputTokens: 0,
        outputTokens: 0,
      });
      usage.record({
        ...base,
        runId: 'r1',
        provider: 'agent:fake',
        model: 'default',
        inputTokens: 0,
        outputTokens: 0,
      });
      usage.record({
        ...base,
        runId: 'r1',
        provider: 'agent:fake',
        model: 'default',
        inputTokens: 30,
        outputTokens: 5,
      });
      usage.record({
        ...base,
        runId: 'r2',
        provider: 'openai',
        model: 'x',
        inputTokens: 0,
        outputTokens: 0,
      });
      expect(usage.sumForRuns(['r1', 'r2'])).toBe(2 * AGENT_TURN_BUDGET_TOKENS + 35);
    } finally {
      db.close();
    }
  });
});

describe('event mapping details (P5)', () => {
  it('subagent calls and prose (parentToolUseId) never split the turn; the status line names them', () => {
    const mapper = new AcpEventMapper();
    const events: EngineEvent[] = [];
    const push = (update: Parameters<AcpEventMapper['map']>[0]) =>
      events.push(...mapper.map(update));
    push({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '派个子代理' } });
    push({ sessionUpdate: 'tool_call', toolCallId: 'task', title: 'Task: 调研', kind: 'other' });
    const nested = { _meta: { claudeCode: { parentToolUseId: 'task' } } };
    push({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '子代理的内部独白' },
      ...nested,
    });
    push({
      sessionUpdate: 'tool_call',
      toolCallId: 'n1',
      title: 'Grep foo',
      kind: 'search',
      ...nested,
    });
    push({ sessionUpdate: 'tool_call_update', toolCallId: 'n1', status: 'completed', ...nested });
    push({ sessionUpdate: 'tool_call_update', toolCallId: 'task', status: 'completed' });
    push({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '结论' } });
    const finish = mapper.finish('end_turn');
    events.push(...finish.events);
    expect(events.map((event) => event.type)).toEqual([
      'assistant',
      'tool_call',
      'progress',
      'tool_result',
      'assistant',
    ]);
    expect(events[2]).toEqual({ type: 'progress', payload: { text: '子任务：Grep foo' } });
    expect(finish.finalText).toBe('结论');
    expect(JSON.stringify(events)).not.toContain('内部独白');
  });

  it('tool_call carries the agent title for the status line when it differs from the name', () => {
    const mapper = new AcpEventMapper();
    const [, call] = mapper.map({
      sessionUpdate: 'tool_call',
      toolCallId: 'x',
      title: 'Run ls -la',
      name: 'Bash',
    });
    expect(call).toEqual({
      type: 'tool_call',
      payload: { toolCallId: 'x', toolName: 'Bash', args: {}, title: 'Run ls -la' },
    });
    const [only] = new AcpEventMapper()
      .map({ sessionUpdate: 'tool_call', toolCallId: 'y', title: 'Edit' })
      .slice(-1);
    expect(only!.payload).toEqual({ toolCallId: 'y', toolName: 'Edit', args: {} });
  });
});

describe('background bridge tools (P5, Codex MCP timeout)', () => {
  it('answers a slow call with a notice and feeds its result back in a follow-up prompt', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tool: ToolDefinition = {
      name: 'install_skill',
      description: 'waits for approval',
      parameters: Type.Object({}),
      execute: async () => {
        await gate;
        return { ok: true, content: '用户已批准，技能装好了' };
      },
    };
    const { engine, started, spec } = await setup(
      {
        turns: [
          agentTurn()
            .text('我来装技能。')
            .mcpCall('m1', 'install_skill', {})
            .text('已提交，等结果。'),
          agentTurn().text('技能装好了，可以用了。'),
        ],
      },
      { providers: withFeatures({}, { bridgeToolDetachMs: 60 }), bridge: true },
    );
    const handle = engine.startRun(
      spec({ tools: [tool] }, { capabilities: ['skills'], hostServerName: 'kepcup_bbbb0000' }),
    );
    const events = collect(handle);
    await eventually(() => started[0]?.observed.mcp.some((call) => call.method === 'tools/call'));
    const notice = started[0]!.observed.mcp.find((call) => call.method === 'tools/call')!;
    expect(JSON.stringify(notice.result)).toContain('已转入后台');
    // The run waits for the background call instead of settling.
    await eventually(() =>
      events.some((e) => e.type === 'progress' && String(e.payload.text).includes('转入后台'))
        ? true
        : null,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(started[0]!.observed.prompts).toHaveLength(1);
    release();
    const outcome = await handle.done;
    expect(outcome).toMatchObject({ status: 'completed', finalText: '技能装好了，可以用了。' });
    const prompts = started[0]!.observed.prompts;
    expect(prompts).toHaveLength(2);
    expect(prompts[1]!.text).toContain('background_tool_results');
    expect(prompts[1]!.text).toContain('用户已批准，技能装好了');
    // The first prompt's closing prose became an interim message.
    expect(
      events.some(
        (event) =>
          event.type === 'assistant' &&
          (event.payload as { stopReason: string; text: string }).stopReason === 'toolUse' &&
          (event.payload as { text: string }).text.includes('已提交'),
      ),
    ).toBe(true);
    // Paired steps: the notice is the call's tool_result.
    const results = events.filter((event) => event.type === 'tool_result');
    expect(results).toHaveLength(1);
    expect(String((results[0]!.payload as { content: string }).content)).toContain('已转入后台');
  });

  it('aborting while waiting for a background call cancels the run (and the call)', async () => {
    let aborted = false;
    const tool: ToolDefinition = {
      name: 'generate_video',
      description: 'slow',
      parameters: Type.Object({}),
      execute: async (_params, ctx) =>
        new Promise((resolve) => {
          ctx.signal.addEventListener('abort', () => {
            aborted = true;
            resolve({ ok: false, content: 'aborted' });
          });
        }),
    };
    const { engine, started, spec } = await setup(
      { turns: [agentTurn().mcpCall('m1', 'generate_video', {}).text('稍等')] },
      { providers: withFeatures({}, { bridgeToolDetachMs: 50 }), bridge: true },
    );
    const handle = engine.startRun(
      spec({ tools: [tool] }, { capabilities: ['media'], hostServerName: 'kepcup_cccc0000' }),
    );
    await eventually(() => started[0]?.observed.mcp.some((call) => call.method === 'tools/call'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    handle.abort('user');
    expect((await handle.done).status).toBe('cancelled');
    await eventually(() => aborted);
  });
});

describe('scheduler and providers (P5)', () => {
  it('agent:{id} defaults to AGENT_DEFAULT_CONCURRENCY unless overridden', () => {
    const scheduler = new Scheduler(logger);
    expect(scheduler.concurrencyFor('agent:claude-acp')).toBe(AGENT_DEFAULT_CONCURRENCY);
    expect(scheduler.concurrencyFor('openai')).toBe(4);
    scheduler.setConcurrency({ default: 6, 'agent:codex-acp': 3 });
    expect(scheduler.concurrencyFor('agent:codex-acp')).toBe(3);
    expect(scheduler.concurrencyFor('agent:claude-acp')).toBe(AGENT_DEFAULT_CONCURRENCY);
    expect(scheduler.concurrencyFor('openai')).toBe(6);
  });

  it('Claude disables background tasks and cron at the process level; usage is per turn', () => {
    const launch = claudeProvider.launch({
      entry: AGENT_CATALOG.find((entry) => entry.id === 'claude-acp')!,
      target: { command: 'claude-agent-acp', args: [], env: {} },
      platform: 'linux',
    });
    expect(launch.env).toMatchObject(CLAUDE_PROCESS_ENV);
    expect(CLAUDE_PROCESS_ENV).toEqual({
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
      CLAUDE_CODE_DISABLE_CRON: '1',
    });
    expect(claudeProvider.usageSemantics).toBe('turn');
    expect(codexProvider.usageSemantics).toBe('turn');
    expect(claudeProvider.features.steering && codexProvider.features.steering).toBe(true);
  });
});

describe('shim transport (design 28 §10 `connect`)', () => {
  it('drives an in-process ACP agent the provider builds over the agent process', async () => {
    const entry = { ...FAKE, id: 'fake-shim', provider: 'shim-test', transport: 'shim' as const };
    const workdir = mkdtempSync(path.join(tmpdir(), 'kepcup-shim-'));
    dirs.push(workdir);
    const seen: string[] = [];
    const procs: Array<{ kill(): void }> = [];
    const providers: ProviderRegistry = {
      'shim-test': {
        ...genericAcpProvider,
        id: 'shim-test',
        connect: (proc, client) => {
          procs.push(proc);
          return {
            initialize: async () => ({
              protocolVersion: 1,
              agentCapabilities: { loadSession: false },
              authMethods: [],
            }),
            newSession: async () => ({ sessionId: 'shim-1' }),
            authenticate: async () => ({}),
            prompt: async (params) => {
              seen.push(
                params.prompt.map((block) => (block.type === 'text' ? block.text : '')).join(''),
              );
              await client.sessionUpdate({
                sessionId: params.sessionId,
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: '来自垫片' },
                },
              });
              return { stopReason: 'end_turn' };
            },
            cancel: async () => {},
          };
        },
      },
    };
    const host = new AgentHost({
      logger,
      redact: (text) => text,
      appVersion: '1.0.0',
      resolveLaunch: () => ({ command: 'unused', args: [], env: {} }),
      spawn: fakeAgentSpawner({ 'fake-shim': { turns: [] } }) as never,
      providers,
    });
    hosts.push(host);
    const engine = new ExternalAgentEngine({ host, catalog: () => [entry], logger });
    const outcome = await engine.startRun({
      identity: { runId: 'run_shim', botId: 'b', conversationId: 'c', loopType: 'response' },
      model: agentModelRef(entry.id, ''),
      buildSystemPrompt: async () => 'S',
      messages: [{ role: 'user', content: '经垫片', timestamp: 0 }],
      tools: [],
      limits: { maxTurns: 10 },
      workdir,
      external: { agentId: entry.id, permission: 'read_only', capabilities: [], sessionKey: 'k' },
    }).done;
    expect(outcome).toMatchObject({ status: 'completed', finalText: '来自垫片' });
    expect(seen[0]).toContain('经垫片');
    // The process going away closes the shim: the agent is no longer running.
    procs[0]!.kill();
    await eventually(() => !host.isRunning(entry.id));
  });

  it('a shim entry whose provider has no connect fails readably', async () => {
    const entry = { ...FAKE, id: 'fake-shim2', transport: 'shim' as const };
    const host = new AgentHost({
      logger,
      redact: (text) => text,
      appVersion: '1.0.0',
      resolveLaunch: () => ({ command: 'unused', args: [], env: {} }),
      spawn: fakeAgentSpawner({ 'fake-shim2': { turns: [] } }) as never,
    });
    hosts.push(host);
    await expect(host.acquire(entry)).rejects.toMatchObject({ code: 'AGENT_INCOMPATIBLE' });
  });
});
