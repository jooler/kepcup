import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGENT_CATALOG, agentModelRef, HOST_CAPABILITIES, type AgentCatalogEntry } from '@kepcup/shared';
import {
  agentTurn,
  fakeAgentSpawner,
  type FakeAcpAgentHandle,
  type FakeAgentScript,
} from '@kepcup/testkit';
import { AcpEventMapper, ExternalAgentEngine } from '../../src/agent/external/engine.js';
import {
  AgentHost,
  buildAgentEnv,
  findOnPath,
  prepareSpawn,
  spawnAgentProcess,
} from '../../src/agent/external/host.js';
import { decidePermission } from '../../src/agent/external/acp/client.js';
import {
  agentErrorInfo,
  defaultClassifyError,
  toAgentError,
  type AgentErrorInfo,
} from '../../src/agent/external/errors.js';
import type { ProviderRegistry } from '../../src/agent/external/types.js';
import { genericAcpProvider } from '../../src/agent/external/providers/generic-acp.js';
import type { EngineEvent, RunSpec } from '../../src/agent/types.js';
import { mcpToolName } from '../../src/mcp/service.js';

/**
 * ExternalAgentEngine 单测（D72 P1）：ACP 更新 → 引擎事件的映射（与 PiEngine
 * 字段对齐、中间说明切分）、取消 / refusal / 崩溃 / 未登录、配置项、图片、
 * 权限默认拒绝的纯函数与进程环境白名单。
 */

const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never;
const FAKE = AGENT_CATALOG.find((entry) => entry.id === 'fake')!;

/** PiEngine payload keys (pi-engine.ts RunHandleImpl / tool wrapper). */
const PI_KEYS = {
  assistant: ['errorMessage', 'stopReason', 'text'],
  tool_call: ['args', 'toolCallId', 'toolName'],
  tool_result: ['content', 'ok', 'toolCallId', 'toolName'],
};

function expectPiShape(events: EngineEvent[]): void {
  for (const event of events) {
    const keys = PI_KEYS[event.type as keyof typeof PI_KEYS];
    if (keys !== undefined) expect(Object.keys(event.payload as object).sort()).toEqual(keys);
  }
}

describe('AcpEventMapper', () => {
  it('only text: one final assistant with stopReason stop', () => {
    const mapper = new AcpEventMapper();
    expect(
      mapper.map({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '你' } }),
    ).toEqual([]);
    mapper.map({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '好' } });
    mapper.map({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '想想' } });
    const { events, finalText } = mapper.finish('end_turn');
    expect(finalText).toBe('你好');
    expect(events).toEqual([
      { type: 'assistant', payload: { text: '你好', stopReason: 'stop', errorMessage: undefined } },
    ]);
    expectPiShape(events);
  });

  it('splits interim prose at tool boundaries (D54) and pairs tool calls', () => {
    const mapper = new AcpEventMapper();
    const events: EngineEvent[] = [];
    const push = (update: Parameters<AcpEventMapper['map']>[0]) => events.push(...mapper.map(update));
    push({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '先查两个文件' } });
    push({ sessionUpdate: 'tool_call', toolCallId: 'a', title: 'Read a', kind: 'read', rawInput: { p: 'a' } });
    push({ sessionUpdate: 'tool_call', toolCallId: 'b', title: 'Read b', kind: 'read' });
    push({ sessionUpdate: 'tool_call_update', toolCallId: 'a', status: 'in_progress' });
    push({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'a',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'A' } }],
    });
    push({ sessionUpdate: 'tool_call_update', toolCallId: 'b', status: 'failed', rawOutput: { error: 'nope' } });
    // A tool-only model turn after the results: still one (empty) assistant.
    push({ sessionUpdate: 'tool_call', toolCallId: 'c', title: 'Edit', kind: 'edit', status: 'completed' });
    push({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '都好了' } });
    const finish = mapper.finish('end_turn');
    events.push(...finish.events);

    expect(events.map((e) => e.type)).toEqual([
      'assistant',
      'tool_call',
      'tool_call',
      'tool_result',
      'tool_result',
      'assistant',
      'tool_call',
      'tool_result',
      'assistant',
    ]);
    expect(events[0]!.payload).toMatchObject({ text: '先查两个文件', stopReason: 'toolUse' });
    expect(events[1]!.payload).toEqual({ toolCallId: 'a', toolName: 'Read a', args: { p: 'a' } });
    expect(events[3]!.payload).toMatchObject({ toolCallId: 'a', ok: true, content: 'A' });
    expect(events[4]!.payload).toMatchObject({ toolCallId: 'b', ok: false, content: '{"error":"nope"}' });
    expect(events[5]!.payload).toMatchObject({ text: '', stopReason: 'toolUse' });
    expect(events[8]!.payload).toMatchObject({ text: '都好了', stopReason: 'stop' });
    expect(finish.finalText).toBe('都好了');
    expectPiShape(events);
  });

  it('prefers the tool name over its title and maps plans to progress', () => {
    const mapper = new AcpEventMapper();
    expect(
      mapper.map({ sessionUpdate: 'tool_call', toolCallId: 'x', title: 'Run ls', name: 'Bash' })[1],
    ).toMatchObject({ type: 'tool_call', payload: { toolName: 'Bash' } });
    expect(
      mapper.map({
        sessionUpdate: 'plan',
        entries: [
          { content: '读代码', priority: 'high', status: 'completed' },
          { content: '改代码', priority: 'high', status: 'in_progress' },
        ],
      }),
    ).toEqual([{ type: 'progress', payload: { text: '计划 1/2：改代码' } }]);
  });

  it('cancel / refusal / dangling calls end without a final text', () => {
    const cancelled = new AcpEventMapper();
    cancelled.map({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '半句' } });
    expect(cancelled.finish('cancelled')).toEqual({
      events: [
        { type: 'assistant', payload: { text: '半句', stopReason: 'aborted', errorMessage: undefined } },
      ],
      finalText: '',
    });

    const refused = new AcpEventMapper();
    expect(refused.finish('refusal').events[0]!.payload).toEqual({
      text: '',
      stopReason: 'error',
      errorMessage: 'refusal',
    });

    const dangling = new AcpEventMapper();
    dangling.map({ sessionUpdate: 'tool_call', toolCallId: 'd', title: 'Long task' });
    const { events, finalText } = dangling.finish('end_turn');
    expect(events[0]).toMatchObject({
      type: 'tool_result',
      payload: { toolCallId: 'd', toolName: 'Long task', ok: false },
    });
    expect(finalText).toBe('');
  });
});

describe('ACP client helpers', () => {
  const OPTIONS = [
    { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' as const },
    { optionId: 'allow_always', name: 'Always', kind: 'allow_always' as const },
    { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' as const },
  ];
  const request = (title: string, name?: string, options = OPTIONS) => ({
    sessionId: 's',
    toolCall: { toolCallId: 't', title, ...(name !== undefined ? { name } : {}) },
    options,
  });
  const BRIDGE = { serverName: 'kepcup_0a1b2c3d', toolNames: new Set(['send_message']) };
  const inRun = { hasRun: true, bridge: null };
  const bridged = { hasRun: true, bridge: BRIDGE };

  it('rejects once by default and never picks an *_always option', () => {
    expect(decidePermission(request('Write file'), genericAcpProvider, inRun)).toEqual({
      response: { outcome: { outcome: 'selected', optionId: 'reject_once' } },
      decision: 'rejected',
    });
  });

  it('never allows in P1: no bridge attached, or only a free-text title looks like kepcup', () => {
    const kepcup = 'mcp__kepcup_0a1b2c3d__send_message';
    expect(decidePermission(request(kepcup, kepcup), genericAcpProvider, inRun).decision).toBe(
      'rejected',
    );
    // With the bridge (P2) only the structured name counts, never the title.
    expect(decidePermission(request(kepcup), genericAcpProvider, bridged).decision).toBe(
      'rejected',
    );
    expect(decidePermission(request('rm -rf ~', kepcup), genericAcpProvider, bridged)).toEqual({
      response: { outcome: { outcome: 'selected', optionId: 'allow_once' } },
      decision: 'allowed',
    });
  });

  it('only allows this session\'s bridge server and the run\'s tools (no impersonation)', () => {
    // A user / project MCP server literally named "kepcup".
    expect(
      decidePermission(request('x', 'mcp__kepcup__send_message'), genericAcpProvider, bridged)
        .decision,
    ).toBe('rejected');
    // Right server, tool not injected into this run.
    expect(
      decidePermission(request('x', 'mcp__kepcup_0a1b2c3d__bash'), genericAcpProvider, bridged)
        .decision,
    ).toBe('rejected');
    // Codex-style structured rawInput is recognized by the generic hook too.
    const codexStyle = {
      sessionId: 's',
      toolCall: {
        toolCallId: 't',
        title: 'mcp.kepcup_0a1b2c3d.send_message',
        rawInput: { server: 'kepcup_0a1b2c3d', tool: 'send_message', arguments: {} },
      },
      options: OPTIONS,
    };
    expect(decidePermission(codexStyle, genericAcpProvider, bridged).decision).toBe('allowed');
  });

  it('cancels outside runs and when no once-option exists', () => {
    expect(
      decidePermission(request('Write file'), genericAcpProvider, {
        hasRun: false,
        bridge: BRIDGE,
      }).decision,
    ).toBe('cancelled');
    expect(
      decidePermission(
        request('Write file', undefined, [{ optionId: 'always', name: 'Always', kind: 'allow_always' }]),
        genericAcpProvider,
        inRun,
      ).response,
    ).toEqual({ outcome: { outcome: 'cancelled' } });
  });

  it('classifies errors: ACP auth_required by default, provider overrides per phase', () => {
    expect(defaultClassifyError(agentErrorInfo({ code: -32000, message: 'x' }))).toBe('auth_required');
    expect(defaultClassifyError(agentErrorInfo(new Error('boom')))).toBe('other');
    const err = Object.assign(new Error('no API key for provider route'), { code: -32603 });
    const classify = (info: AgentErrorInfo, phase: string) =>
      phase === 'prompt' && /no API key/.test(info.message) ? ('auth_required' as const) : ('other' as const);
    expect(toAgentError(err, 'dsh', classify, 'prompt').code).toBe('AGENT_AUTH_REQUIRED');
    expect(toAgentError(err, 'dsh', classify, 'session_new').code).toBe('AGENT_FAILED');
    expect(toAgentError(err, 'x', () => 'not_installed').code).toBe('AGENT_UNAVAILABLE');
    expect(toAgentError(err, 'x', () => 'incompatible').code).toBe('AGENT_INCOMPATIBLE');
  });

  it('finds system CLIs on Windows by PATHEXT only, never the extension-less sh shim', () => {
    const files = new Set([
      'C:\\npm\\codex',
      'C:\\npm\\codex.cmd',
      'C:\\bin\\agent.EXE',
    ]);
    const options = {
      platform: 'win32' as const,
      env: { PATH: 'C:\\npm;C:\\bin', PATHEXT: '.COM;.EXE;.BAT;.CMD' },
      // NTFS is case-insensitive.
      isExecutable: (file: string) =>
        [...files].some((known) => known.toLowerCase() === file.toLowerCase()),
    };
    expect(findOnPath('codex', options)?.toLowerCase()).toBe('c:\\npm\\codex.cmd');
    expect(findOnPath('agent', options)?.toLowerCase()).toBe('c:\\bin\\agent.exe');
    expect(findOnPath('codex.cmd', options)).toBe('C:\\npm\\codex.cmd');
    expect(findOnPath('missing', options)).toBeNull();
    // POSIX keeps the bare name.
    expect(
      findOnPath('codex', {
        platform: 'linux',
        env: { PATH: '/usr/bin:/opt/npm' },
        isExecutable: (file) => file === '/opt/npm/codex',
      }),
    ).toBe('/opt/npm/codex');
  });

  it('runs Windows .cmd shims through cmd.exe with escaped arguments', () => {
    expect(
      prepareSpawn({ command: '/usr/bin/agent', args: ['acp'], env: {} }, 'linux'),
    ).toEqual({ command: '/usr/bin/agent', args: ['acp'], windowsVerbatimArguments: false });
    expect(
      prepareSpawn({ command: 'C:\\a\\agent.exe', args: ['acp'], env: {} }, 'win32'),
    ).toMatchObject({ command: 'C:\\a\\agent.exe', windowsVerbatimArguments: false });
    const cmd = prepareSpawn(
      { command: 'C:\\npm\\codex.cmd', args: ['acp', 'a b&c', 'say "hi"'], env: { ComSpec: 'C:\\Windows\\cmd.exe' } },
      'win32',
    );
    expect(cmd.command).toBe('C:\\Windows\\cmd.exe');
    expect(cmd.windowsVerbatimArguments).toBe(true);
    expect(cmd.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    const line = cmd.args[3]!;
    expect(line.startsWith('"') && line.endsWith('"')).toBe(true);
    expect(line).toContain('C:\\npm\\codex.cmd');
    // Metacharacters are caret-escaped (twice for npm .cmd shims).
    expect(line).toContain('^^^&');
    expect(line).not.toMatch(/[^^]&/);
  });

  it('passes only whitelisted host environment to agent processes', () => {
    const env = buildAgentEnv(
      {
        PATH: '/usr/bin',
        HOME: '/home/u',
        KEPCUP_KEYSTORE: 'memory',
        OPENAI_API_KEY: 'sk-secret',
        NODE_OPTIONS: '--inspect',
      },
      { ELECTRON_RUN_AS_NODE: '1', HOME: '/override' },
    );
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/override', ELECTRON_RUN_AS_NODE: '1' });
    // Official login flows and keychains need the session bus / display / CA vars.
    const session = buildAgentEnv(
      {
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/bus',
        DISPLAY: ':0',
        WAYLAND_DISPLAY: 'wayland-0',
        XDG_RUNTIME_DIR: '/run/user/1000',
        SSL_CERT_FILE: '/etc/ca.pem',
        NODE_EXTRA_CA_CERTS: '/etc/extra.pem',
      },
      {},
    );
    expect(Object.keys(session).sort()).toEqual([
      'DBUS_SESSION_BUS_ADDRESS',
      'DISPLAY',
      'NODE_EXTRA_CA_CERTS',
      'SSL_CERT_FILE',
      'WAYLAND_DISPLAY',
      'XDG_RUNTIME_DIR',
    ]);
  });
});

describe('agent process proxy environment', () => {
  it('keeps loopback (the host MCP bridge) off the user proxy, preserving NO_PROXY', () => {
    const env = buildAgentEnv(
      { HTTPS_PROXY: 'http://proxy:3128', no_proxy: '.corp.example, localhost' },
      {},
    );
    expect(env.NO_PROXY).toBe('.corp.example,localhost,127.0.0.1,::1');
    expect(env.no_proxy).toBe(env.NO_PROXY);
    expect(env.HTTPS_PROXY).toBe('http://proxy:3128');
    // No proxy configured: nothing added.
    expect(buildAgentEnv({ PATH: '/usr/bin' }, {})).toEqual({ PATH: '/usr/bin' });
  });
});

describe('host capability registry vs real tools', () => {
  it('every packed tool name exists among the response tools', () => {
    const toolsDir = fileURLToPath(new URL('../../src/tools', import.meta.url));
    const names = new Set<string>();
    for (const file of readdirSync(toolsDir).filter((f) => f.endsWith('.ts'))) {
      const source = readFileSync(path.join(toolsDir, file), 'utf8');
      for (const match of source.matchAll(/^\s+name: '([a-z_]+)'/gm)) names.add(match[1]!);
    }
    for (const capability of HOST_CAPABILITIES) {
      for (const tool of [...capability.tools, ...capability.butlerTools]) {
        expect(names, `${capability.id}:${tool}`).toContain(tool);
      }
      for (const prefix of capability.toolPrefixes) {
        // User MCP tools are named at runtime (mcp/service.ts mcpToolName).
        const candidates = capability.id === 'mcp' ? [mcpToolName('srv', 'lookup')] : [...names];
        expect(candidates.some((name) => name.startsWith(prefix)), prefix).toBe(true);
      }
    }
  });
});

describe('ExternalAgentEngine', () => {
  const dirs: string[] = [];
  const hosts: AgentHost[] = [];
  afterEach(() => {
    for (const host of hosts.splice(0)) host.dispose();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function setup(
    scripts: FakeAgentScript | FakeAgentScript[],
    options: {
      idleShutdownMs?: number;
      entry?: AgentCatalogEntry;
      providers?: ProviderRegistry;
      realSpawn?: { command: string; args: string[]; env: Record<string, string> };
      cancelGraceMs?: number;
    } = {},
  ) {
    const entry = options.entry ?? FAKE;
    const workdir = mkdtempSync(path.join(tmpdir(), 'kepcup-ext-engine-'));
    dirs.push(workdir);
    const started: FakeAcpAgentHandle[] = [];
    const host = new AgentHost({
      logger,
      redact: (text) => text,
      appVersion: '1.0.0',
      resolveLaunch: () => options.realSpawn ?? { command: 'unused', args: [], env: {} },
      ...(options.realSpawn === undefined
        ? { spawn: fakeAgentSpawner({ [entry.id]: scripts }, started) as never }
        : {}),
      ...(options.providers !== undefined ? { providers: options.providers } : {}),
      ...(options.idleShutdownMs !== undefined ? { idleShutdownMs: options.idleShutdownMs } : {}),
    });
    hosts.push(host);
    const engine = new ExternalAgentEngine({
      host,
      catalog: () => [entry],
      logger,
      cancelGraceMs: options.cancelGraceMs ?? 200,
    });
    const spec = (overrides: Partial<RunSpec> = {}): RunSpec => ({
      identity: { runId: 'run_1', botId: 'bot_1', conversationId: 'conv_1', loopType: 'response' },
      model: agentModelRef(entry.id, ''),
      buildSystemPrompt: async () => 'SYSTEM',
      messages: [{ role: 'user', content: 'HELLO', timestamp: 0 }],
      tools: [],
      limits: { maxTurns: 60 },
      workdir,
      external: { agentId: entry.id, permission: 'read_only', capabilities: [], sessionKey: 'k' },
      ...overrides,
    });
    return { engine, host, started, spec, workdir };
  }

  it('settles a refusal as failed with no final text', async () => {
    const { engine, spec } = setup({ turns: [agentTurn().text('不行').end('refusal')] });
    const outcome = await engine.startRun(spec()).done;
    expect(outcome.status).toBe('failed');
    expect(outcome.finalText).toBe('');
    expect(outcome.error?.code).toBe('AGENT_FAILED');
  });

  it('fails the active run when the agent process crashes, then restarts it', async () => {
    const { engine, host, spec } = setup([
      { turns: [agentTurn().text('做到一半').crash(3)] },
      { turns: [agentTurn().text('重启后正常')] },
    ]);
    const crashed = await engine.startRun(spec()).done;
    expect(crashed.status).toBe('failed');
    expect(crashed.error?.code).toBe('AGENT_PROCESS_EXITED');
    expect(host.isRunning(FAKE.id)).toBe(false);
    const next = await engine.startRun(spec()).done;
    expect(next).toMatchObject({ status: 'completed', finalText: '重启后正常' });
  });

  it('maps auth_required on session/new to AGENT_AUTH_REQUIRED', async () => {
    const { engine, spec } = setup({ requireAuth: true, turns: [] });
    const outcome = await engine.startRun(spec()).done;
    expect(outcome).toMatchObject({ status: 'failed', error: { code: 'AGENT_AUTH_REQUIRED' } });
  });

  it('cancels before the session exists without contacting the agent prompt', async () => {
    const { engine, started, spec } = setup({ turns: [agentTurn().text('不该出现')] });
    const handle = engine.startRun(spec());
    handle.abort('user');
    expect((await handle.done).status).toBe('cancelled');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(started[0]?.observed.prompts ?? []).toHaveLength(0);
  });

  it('settles cancelled after the grace period when the agent ignores session/cancel', async () => {
    const { engine, started, spec } = setup({ turns: [agentTurn().text('卡住').sleep(5_000)] });
    const handle = engine.startRun(spec());
    const events: EngineEvent[] = [];
    handle.onEvent((event) => events.push(event));
    while (!events.some((event) => event.type === 'request')) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    handle.abort('user');
    expect((await handle.done).status).toBe('cancelled');
    // session/cancel really went out even though the agent ignored it.
    expect(started[0]!.observed.cancels).toEqual(['fake-session-1']);
  });

  it('clears the cancel grace timer when the agent answers the cancel', async () => {
    const GRACE = 7_777;
    const { engine, started, spec } = setup(
      { turns: [agentTurn().text('开始').waitCancel()] },
      { cancelGraceMs: GRACE },
    );
    const realSet = globalThis.setTimeout;
    const graceTimers: unknown[] = [];
    const setSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: () => void,
      ms?: number,
    ) => {
      const timer = realSet(fn, ms);
      if (ms === GRACE) graceTimers.push(timer);
      return timer;
    }) as never);
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    try {
      const handle = engine.startRun(spec());
      const events: EngineEvent[] = [];
      handle.onEvent((event) => events.push(event));
      while (!events.some((event) => event.type === 'request')) {
        await new Promise((resolve) => realSet(resolve, 10));
      }
      handle.abort('user');
      expect((await handle.done).status).toBe('cancelled');
      expect(started[0]!.observed.cancels).toEqual(['fake-session-1']);
      expect(graceTimers).toHaveLength(1);
      expect(clearSpy).toHaveBeenCalledWith(graceTimers[0]);
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });

  it('an abort during tier / config setup never starts the prompt', async () => {
    const { engine, started, spec } = setup({ turns: [agentTurn().text('不该出现')] });
    const events: EngineEvent[] = [];
    let handle: ReturnType<typeof engine.startRun> | null = null;
    handle = engine.startRun(
      spec({
        external: {
          agentId: FAKE.id,
          permission: 'read_only',
          capabilities: [],
          sessionKey: 'k',
          // Fires right after session/new, before applyPermissionTier / config.
          onSession: () => handle!.abort('user'),
        },
      }),
    );
    handle.onEvent((event) => events.push(event));
    expect((await handle.done).status).toBe('cancelled');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(events.some((event) => event.type === 'request')).toBe(false);
    expect(started[0]!.observed.prompts).toHaveLength(0);
  });

  it('pairs dangling tool calls with failed results when the agent crashes mid-call', async () => {
    const { engine, spec } = setup({
      turns: [agentTurn().text('开始').toolCall('t9', 'Long build', { name: 'Bash' }).crash(1)],
    });
    const handle = engine.startRun(spec());
    const events: EngineEvent[] = [];
    handle.onEvent((event) => events.push(event));
    const outcome = await handle.done;
    expect(outcome.error?.code).toBe('AGENT_PROCESS_EXITED');
    expect(events.map((event) => event.type)).toEqual([
      'request',
      'assistant',
      'tool_call',
      'tool_result',
    ]);
    expect(events[3]!.payload).toMatchObject({ toolCallId: 't9', toolName: 'Bash', ok: false });
  });

  it('lets the provider classify errors per phase (DeepSeek-style "no API key")', async () => {
    const phases: string[] = [];
    const providers: ProviderRegistry = {
      'generic-acp': {
        ...genericAcpProvider,
        classifyError: (info, phase) => {
          phases.push(phase);
          return /no API key/.test(info.message) ? 'auth_required' : 'other';
        },
      },
    };
    const { engine, spec } = setup(
      { turns: [agentTurn().fail(-32603, 'no API key for provider route "deepseek-official"')] },
      { providers },
    );
    const outcome = await engine.startRun(spec()).done;
    expect(outcome.error?.code).toBe('AGENT_AUTH_REQUIRED');
    expect(phases).toEqual(['prompt']);
  });

  it('reports a missing executable as AGENT_UNAVAILABLE', async () => {
    const { engine, spec } = setup(
      { turns: [] },
      { realSpawn: { command: path.join(tmpdir(), 'kepcup-no-such-agent-binary'), args: [], env: {} } },
    );
    const outcome = await engine.startRun(spec()).done;
    expect(outcome).toMatchObject({ status: 'failed', error: { code: 'AGENT_UNAVAILABLE' } });
  });

  it('does not settle active runs when the host is disposed (core shutdown)', async () => {
    const { engine, host, spec } = setup({ turns: [agentTurn().text('跑着').waitCancel()] });
    const handle = engine.startRun(spec());
    const events: EngineEvent[] = [];
    handle.onEvent((event) => events.push(event));
    while (!events.some((event) => event.type === 'request')) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    host.dispose();
    const settled = await Promise.race([
      handle.done.then(() => 'settled'),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 300)),
    ]);
    expect(settled).toBe('pending');
  });

  it('applies model / thought_level config options and reports the session id', async () => {
    const select = (id: string, category: string, value: string) => ({
      id,
      name: id,
      category,
      type: 'select' as const,
      currentValue: value,
      options: [{ value, name: value }],
    });
    const { engine, started, spec } = setup({
      configOptions: [select('model', 'model', 'm-default'), select('effort', 'thought_level', 'low')],
      turns: [agentTurn().text('ok')],
    });
    let sessionId = '';
    const outcome = await engine.startRun(
      spec({
        model: agentModelRef(FAKE.id, 'm-big'),
        external: {
          agentId: FAKE.id,
          permission: 'read_only',
          capabilities: [],
          sessionKey: 'k',
          effort: 'high',
          onSession: (id) => {
            sessionId = id;
          },
        },
      }),
    ).done;
    expect(outcome.status).toBe('completed');
    expect(sessionId).toBe('fake-session-1');
    expect(started[0]!.observed.configSets.map((c) => [c.configId, c.value])).toEqual([
      ['model', 'm-big'],
      ['effort', 'high'],
    ]);
  });

  it('builds one prompt from the system prompt and messages; images follow promptCapabilities', async () => {
    const image = { mimeType: 'image/png', base64: 'AAAA' };
    const withImages = setup({ promptCapabilities: { image: true }, turns: [agentTurn().text('a')] });
    await withImages.engine.startRun(
      withImages.spec({ messages: [{ role: 'user', content: 'HELLO', timestamp: 0, images: [image] }] }),
    ).done;
    const blocks = withImages.started[0]!.observed.prompts[0]!.blocks;
    expect(blocks[0]).toEqual({ type: 'text', text: 'SYSTEM\n\nHELLO' });
    expect(blocks[1]).toEqual({ type: 'image', data: 'AAAA', mimeType: 'image/png' });

    const textOnly = setup({ turns: [agentTurn().text('b')] });
    await textOnly.engine.startRun(
      textOnly.spec({ messages: [{ role: 'user', content: 'HELLO', timestamp: 0, images: [image] }] }),
    ).done;
    const only = textOnly.started[0]!.observed.prompts[0]!.blocks;
    expect(only).toHaveLength(1);
    expect(only[0]).toMatchObject({ type: 'text' });
    expect((only[0] as { text: string }).text).toContain('不支持图像输入');
  });

  it('honours promptParts when the caller provides them', async () => {
    const { engine, started, spec } = setup({ turns: [agentTurn().text('ok')] });
    await engine.startRun(
      spec({ promptParts: { session: 'S', run: 'R', conversation: 'C' } }),
    ).done;
    expect(started[0]!.observed.prompts[0]!.text).toBe('S\n\nR\n\nC');
  });

  it('closes sessions the agent can close and exits after the idle period', async () => {
    const { engine, host, started, spec } = setup(
      { sessionClose: true, turns: [agentTurn().text('ok')] },
      { idleShutdownMs: 30 },
    );
    await engine.startRun(spec()).done;
    await started[0]!.exited;
    expect(started[0]!.observed.closedSessions).toEqual(['fake-session-1']);
    expect(host.isRunning(FAKE.id)).toBe(false);
  });

  it('fails unknown agents, never steers, reports no tokens and refuses complete()', async () => {
    const { engine, spec } = setup({ turns: [] });
    const handle = engine.startRun(
      spec({ external: { agentId: 'nope', permission: 'read_only', capabilities: [], sessionKey: 'k' } }),
    );
    expect(handle.steer('追加')).toBe(false);
    expect(handle.tokensSoFar()).toBe(0);
    expect(await handle.done).toMatchObject({
      status: 'failed',
      error: { code: 'AGENT_UNAVAILABLE' },
    });
    await expect(
      engine.complete({
        identity: { runId: 'r', botId: null, conversationId: null, loopType: 'triage' },
        model: 'agent:fake/default',
        systemPrompt: '',
        messages: [],
      }),
    ).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
  });
});

describe.skipIf(process.platform === 'win32')('spawnAgentProcess', () => {
  it('kills the whole process group, escalating SIGTERM to SIGKILL', async () => {
    // A parent that ignores SIGTERM and owns a grandchild (npx-style tree).
    const script = [
      "const { spawn } = require('node:child_process');",
      "process.on('SIGTERM', () => {});",
      "const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', env: process.env });",
      "process.stderr.write('grandchild ' + g.pid + '\\n');",
      'setInterval(() => {}, 1000);',
    ].join('\n');
    let stderr = '';
    const proc = spawnAgentProcess({
      entry: FAKE,
      launch: {
        command: process.execPath,
        args: ['-e', script],
        env: { ...buildAgentEnv(process.env, {}), ELECTRON_RUN_AS_NODE: '1' },
      },
      cwd: tmpdir(),
      onStderr: (text) => {
        stderr += text;
      },
    });
    const deadline = Date.now() + 5_000;
    while (!/grandchild \d+/.test(stderr) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const grandchild = Number(/grandchild (\d+)/.exec(stderr)![1]);
    proc.kill();
    const exit = await proc.exited;
    expect(exit.signal).toBe('SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(() => process.kill(grandchild, 0)).toThrow();
  }, 15_000);
});
