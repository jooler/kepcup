import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { agentModelRef, AGENT_CATALOG, type AgentCatalogEntry } from '@kepcup/shared';
import {
  agentTurn,
  fakeAgentEntry,
  fakeAgentSpawner,
  type FakeAcpAgentHandle,
  type FakeAgentScript,
} from '@kepcup/testkit';
import { ExternalAgentEngine } from '../../src/agent/external/engine.js';
import { AgentHost } from '../../src/agent/external/host.js';
import { AgentInstaller, managedKindFor } from '../../src/agent/external/installer.js';
import { isForbiddenAgentMode } from '../../src/agent/external/permission-bridge.js';
import { classifierFor, toAgentError } from '../../src/agent/external/errors.js';
import { PROVIDERS } from '../../src/agent/external/providers/index.js';
import {
  antigravityGeminiHome,
  antigravityProvider,
  filterAntigravityAuthMethods,
} from '../../src/agent/external/providers/antigravity.js';
import { codexProvider } from '../../src/agent/external/providers/codex.js';
import {
  CURSOR_ASK_QUESTION_REASON,
  CURSOR_CREATE_PLAN_REASON,
  cursorProvider,
} from '../../src/agent/external/providers/cursor.js';
import { classifyDshError, dshProvider } from '../../src/agent/external/providers/dsh.js';
import {
  opencodePermissionConfig,
  opencodeProvider,
} from '../../src/agent/external/providers/opencode.js';
import type { AgentPermissionTier } from '@kepcup/shared';
import type { RunSpec } from '../../src/agent/types.js';

/**
 * P5 第一部分（todo §8.1）：OpenCode / DeepSeek Harness / Cursor / Antigravity
 * 的 Provider 差异——进程级配置、档位映射、禁止模式、登录方式过滤、错误分类、
 * 厂商扩展请求不悬挂；以及安装器拒绝未锁定 sha256 的平台。共用契约见
 * test/contract/agent-providers.test.ts。
 */

const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never;
const catalog = (id: string) => AGENT_CATALOG.find((entry) => entry.id === id)!;

const dirs: string[] = [];
const hosts: AgentHost[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.dispose();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function setup(entry: AgentCatalogEntry, script: FakeAgentScript) {
  const started: FakeAcpAgentHandle[] = [];
  const launches: Array<{ env: Record<string, string> }> = [];
  const spawner = fakeAgentSpawner({ [entry.id]: script }, started);
  const stateRoot = tempDir('kepcup-p5-state-');
  const host = new AgentHost({
    logger,
    redact: (text) => text,
    appVersion: '1.0.0',
    resolveLaunch: () => ({ command: 'unused', args: [], env: {} }),
    spawn: ((input: { entry: { id: string }; launch: { env: Record<string, string> } }) => {
      launches.push(input.launch);
      return spawner(input);
    }) as never,
    dataHome: '/data/kepcup-home',
    stateDirFor: (agentId) => path.join(stateRoot, agentId),
  });
  hosts.push(host);
  const engine = new ExternalAgentEngine({
    host,
    catalog: () => [entry],
    logger,
    cancelGraceMs: 200,
  });
  const workdir = tempDir('kepcup-p5-work-');
  const spec = (permission: AgentPermissionTier = 'read_only'): RunSpec => ({
    identity: { runId: 'run_1', botId: 'bot_1', conversationId: 'conv_1', loopType: 'response' },
    model: agentModelRef(entry.id, ''),
    buildSystemPrompt: async () => 'SYSTEM',
    messages: [{ role: 'user', content: 'HELLO', timestamp: 0 }],
    tools: [],
    limits: { maxTurns: 60 },
    workdir,
    external: { agentId: entry.id, permission, capabilities: [], sessionKey: 'k' },
  });
  return { engine, started, launches, spec, stateRoot };
}

function tierContext(modes: string[] | null, current: string, modeOption: string[] | null = null) {
  const calls: string[] = [];
  return {
    calls,
    ctx: {
      sessionId: 's',
      modes:
        modes === null
          ? null
          : { currentModeId: current, availableModes: modes.map((id) => ({ id, name: id })) },
      configOptions:
        modeOption === null
          ? []
          : [
              {
                id: 'mode',
                name: 'Mode',
                category: 'mode',
                type: 'select' as const,
                currentValue: current,
                options: modeOption.map((value) => ({ value, name: value })),
              },
            ],
      setMode: async (modeId: string) => {
        calls.push(`mode:${modeId}`);
      },
      setConfigOption: async (configId: string, value: string) => {
        calls.push(`config:${configId}=${value}`);
      },
    },
  };
}

describe('provider registry', () => {
  it('every catalog entry resolves to a registered provider', () => {
    for (const entry of AGENT_CATALOG) expect(PROVIDERS[entry.provider], entry.id).toBeDefined();
    expect(PROVIDERS.opencode).toBe(opencodeProvider);
    expect(PROVIDERS.dsh).toBe(dshProvider);
    expect(PROVIDERS.cursor).toBe(cursorProvider);
    expect(PROVIDERS.antigravity).toBe(antigravityProvider);
  });

  it('forbidden modes: global table, provider additions and the Cursor `agent` exemption', () => {
    expect(isForbiddenAgentMode('agent')).toBe(true);
    expect(isForbiddenAgentMode('agent', codexProvider)).toBe(true);
    expect(isForbiddenAgentMode('agent', cursorProvider)).toBe(false);
    expect(isForbiddenAgentMode('yolo', cursorProvider)).toBe(true);
    expect(isForbiddenAgentMode('yolo', antigravityProvider)).toBe(true);
    expect(isForbiddenAgentMode('auto_edit', antigravityProvider)).toBe(true);
    expect(isForbiddenAgentMode('default', antigravityProvider)).toBe(false);
    expect(isForbiddenAgentMode('bypassPermissions', cursorProvider)).toBe(true);
  });
});

describe('OpenCode', () => {
  it('process config: global items only, commands / edits ask, data directory denied', () => {
    const launch = opencodeProvider.launch({
      entry: catalog('opencode'),
      target: { command: '/x/opencode', args: ['acp'], env: { OPENCODE_CONFIG_CONTENT: 'evil' } },
      platform: 'linux',
      dataHome: '/home/u/.kepcup',
    });
    expect(launch.command).toBe('/x/opencode');
    expect(launch.args).toEqual(['acp']);
    expect(launch.env).toMatchObject({
      OPENCODE_DISABLE_CLAUDE_CODE: '1',
      OPENCODE_DISABLE_AUTOUPDATE: '1',
    });
    const content = JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT!) as Record<string, unknown>;
    expect(content).toEqual({
      $schema: 'https://opencode.ai/config.json',
      autoupdate: false,
      share: 'disabled',
      permission: {
        edit: 'ask',
        bash: 'ask',
        external_directory: {
          '*': 'ask',
          '/home/u/.kepcup': 'deny',
          '/home/u/.kepcup/*': 'deny',
        },
      },
    });
    // Re-applied after every config layer (incl. a project's opencode.json).
    expect(JSON.parse(launch.env.OPENCODE_PERMISSION!)).toEqual(content.permission);
    // No persona / per-session text in the process-level config.
    expect(launch.env.OPENCODE_CONFIG_CONTENT).not.toMatch(/instructions|prompt/);
    // Windows data directories become forward-slash patterns; deny rules come last.
    const windows = opencodePermissionConfig('C:\\Users\\u\\.kepcup\\');
    expect(Object.entries(windows.external_directory as object)).toEqual([
      ['*', 'ask'],
      ['C:/Users/u/.kepcup', 'deny'],
      ['C:/Users/u/.kepcup/*', 'deny'],
    ]);
  });

  it('tier → mode config option (read_only → plan, else build); unknown mode fails closed', async () => {
    for (const [tier, mode] of [
      ['read_only', 'plan'],
      ['ask', 'build'],
      ['workspace', 'build'],
    ] as const) {
      const { ctx, calls } = tierContext(null, 'build', ['build', 'plan']);
      await opencodeProvider.applyPermissionTier(tier, ctx);
      expect(calls).toEqual(mode === 'build' ? [] : [`config:mode=${mode}`]);
    }
    const { ctx } = tierContext(null, 'build', ['build']);
    await expect(opencodeProvider.applyPermissionTier('read_only', ctx)).rejects.toMatchObject({
      code: 'AGENT_INCOMPATIBLE',
    });
  });

  it('no OS sandbox, opencode option ids, `{server}_{tool}` MCP names, steering off', () => {
    expect(opencodeProvider.features).toMatchObject({ osSandbox: false, steering: false });
    expect(opencodeProvider.execSandboxed?.({ kind: 'execute', title: 'ls' })).toBe(false);
    expect(opencodeProvider.permissionOptions).toEqual({
      allowOnce: ['once'],
      rejectOnce: ['reject'],
    });
    expect(opencodeProvider.toolName('kepcup_ab12cd34', 'send_message')).toBe(
      'kepcup_ab12cd34_send_message',
    );
    expect(opencodeProvider.agentSideConfigFiles).toEqual(
      expect.arrayContaining(['AGENTS.md', 'opencode.json', '.opencode/']),
    );
  });

  it('works logged out (anonymous free models): a session opens without any authenticate', async () => {
    const entry = fakeAgentEntry('fake-opencode', {
      provider: 'opencode',
      auth: { kinds: ['subscription', 'api-key', 'anonymous'], note: '' },
    });
    const { engine, started, spec, launches } = setup(entry, {
      authMethods: [
        {
          id: 'opencode-login',
          name: 'Login with opencode',
          _meta: { 'terminal-auth': { command: 'opencode', args: ['auth', 'login'] } },
        },
      ],
      configOptions: [
        {
          id: 'mode',
          name: 'Session Mode',
          category: 'mode',
          type: 'select',
          currentValue: 'build',
          options: [
            { value: 'build', name: 'build' },
            { value: 'plan', name: 'plan' },
          ],
        },
      ],
      turns: [agentTurn().text('匿名模型回答')],
    });
    const outcome = await engine.startRun(spec('read_only')).done;
    expect(outcome).toMatchObject({ status: 'completed', finalText: '匿名模型回答' });
    expect(started[0]!.observed.events.some((event) => event.kind === 'authenticate')).toBe(false);
    expect(started[0]!.observed.configSets).toEqual([
      { sessionId: 'fake-session-1', configId: 'mode', value: 'plan' },
    ]);
    expect(JSON.parse(launches[0]!.env.OPENCODE_CONFIG_CONTENT!)).toMatchObject({
      permission: { external_directory: { '/data/kepcup-home/*': 'deny' } },
    });
  });
});

describe('DeepSeek Harness', () => {
  it('classifies -32603 「no API key」 as auth_required in every phase', () => {
    const missingKey = {
      code: -32603,
      message:
        'Internal error: turn failed: llm-deepseek: no API key for provider route "deepseek-official"; store DEEPSEEK_API_KEY …',
    };
    expect(classifyDshError(missingKey)).toBe('auth_required');
    for (const phase of ['initialize', 'session_new', 'prompt', 'other'] as const) {
      expect(classifierFor(dshProvider)(missingKey, phase)).toBe('auth_required');
      expect(
        toAgentError(
          Object.assign(new Error(missingKey.message), { code: -32603 }),
          'dsh',
          classifierFor(dshProvider),
          phase,
        ).code,
      ).toBe('AGENT_AUTH_REQUIRED');
    }
    expect(classifyDshError({ code: -32603, message: 'Internal error: disk full' })).toBe('other');
    expect(classifyDshError({ code: -32000, message: 'Authentication required' })).toBe(
      'auth_required',
    );
    expect(classifyDshError({ code: -32602, message: 'no API key' })).toBe('other');
  });

  it('a prompt failing without DEEPSEEK_API_KEY settles as AGENT_AUTH_REQUIRED', async () => {
    const entry = fakeAgentEntry('fake-dsh', {
      provider: 'dsh',
      auth: { kinds: ['api-key'], note: '', apiKeyEnv: 'DEEPSEEK_API_KEY' },
    });
    const { engine, started, spec } = setup(entry, {
      authMethods: [],
      turns: [
        agentTurn().fail(
          -32603,
          'Internal error: turn failed: llm-deepseek: no API key for provider route "deepseek-official"',
        ),
      ],
    });
    const outcome = await engine.startRun(spec('ask')).done;
    expect(outcome).toMatchObject({ status: 'failed', error: { code: 'AGENT_AUTH_REQUIRED' } });
    // No modes to switch: nothing but session/new + prompt reached the agent.
    expect(started[0]!.observed.events.filter((event) => event.kind === 'mode')).toEqual([]);
    expect(started[0]!.observed.configSets).toEqual([]);
  });

  it('features: no steering, no load (resume only), no OS sandbox', () => {
    expect(dshProvider.features).toEqual({
      steering: false,
      loadSession: false,
      resume: true,
      osSandbox: false,
      httpMcp: true,
    });
    expect(dshProvider.permissionOptions).toEqual({
      allowOnce: ['allow-once'],
      rejectOnce: ['reject-once'],
    });
  });
});

describe('Cursor', () => {
  const entry = fakeAgentEntry('fake-cursor', { provider: 'cursor' });
  const modes = {
    currentModeId: 'agent',
    availableModes: [
      { id: 'agent', name: 'Agent' },
      { id: 'plan', name: 'Plan' },
      { id: 'ask', name: 'Ask' },
    ],
  };

  it('answers cursor/ask_question and cursor/create_plan at once — the turn never hangs', async () => {
    const { engine, started, spec } = setup(entry, {
      modes,
      turns: [
        agentTurn()
          .request('cursor/ask_question', {
            toolCallId: 'q1',
            title: '选哪个？',
            questions: [{ id: 'q', prompt: '用 A 还是 B？', options: [{ id: 'a', label: 'A' }] }],
          })
          .request('cursor/create_plan', { toolCallId: 'p1', plan: '# 计划', todos: [] })
          // Unknown vendor requests still get an immediate -32601.
          .request('cursor/update_todos', { todos: [] })
          .text('继续干活'),
      ],
    });
    const startedAt = Date.now();
    const outcome = await engine.startRun(spec('workspace')).done;
    expect(outcome).toMatchObject({ status: 'completed', finalText: '继续干活' });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    const requests = started[0]!.observed.requests;
    expect(requests).toEqual([
      {
        method: 'cursor/ask_question',
        result: { outcome: { outcome: 'skipped', reason: CURSOR_ASK_QUESTION_REASON } },
      },
      {
        method: 'cursor/create_plan',
        result: { outcome: { outcome: 'rejected', reason: CURSOR_CREATE_PLAN_REASON } },
      },
      { method: 'cursor/update_todos', error: expect.objectContaining({ code: -32601 }) },
    ]);
  });

  it('answers the extension requests outside any run too', async () => {
    const { engine, started, spec } = setup(entry, {
      modes,
      turns: [
        agentTurn()
          .text('好')
          .afterTurn([
            { type: 'request', method: 'cursor/ask_question', params: { questions: [] } },
          ]),
      ],
    });
    await engine.startRun(spec()).done;
    const answered = await new Promise<unknown>((resolve) => {
      const poll = () => {
        const hit = started[0]!.observed.requests[0];
        if (hit !== undefined) resolve(hit);
        else setTimeout(poll, 10);
      };
      poll();
    });
    expect(answered).toMatchObject({ result: { outcome: { outcome: 'skipped' } } });
  });

  it('tier → session mode: read_only → ask, ask / workspace stay in `agent` (never plan)', async () => {
    const read = setup(entry, { modes, turns: [agentTurn().text('只读')] });
    await read.engine.startRun(read.spec('read_only')).done;
    expect(read.started[0]!.observed.events.filter((event) => event.kind === 'mode')).toEqual([
      { kind: 'mode', sessionId: 'fake-session-1', modeId: 'ask' },
    ]);
    const work = setup(entry, { modes, turns: [agentTurn().text('干活')] });
    const outcome = await work.engine.startRun(work.spec('workspace')).done;
    // `agent` is globally forbidden (Codex semantics) but exempt for Cursor.
    expect(outcome.status).toBe('completed');
    expect(work.started[0]!.observed.events.filter((event) => event.kind === 'mode')).toEqual([]);
  });

  it('recognizes its MCP mirror rawInput {providerIdentifier, toolName} only on untyped calls', () => {
    const bridge = 'kepcup_ab12cd34';
    expect(
      cursorProvider.bridgeToolFromCall!(
        { kind: 'other', rawInput: { providerIdentifier: bridge, toolName: 'remember', args: {} } },
        bridge,
      ),
    ).toBe('remember');
    expect(
      cursorProvider.bridgeToolFromCall!(
        { kind: 'execute', rawInput: { providerIdentifier: bridge, toolName: 'remember' } },
        bridge,
      ),
    ).toBeNull();
    expect(
      cursorProvider.bridgeToolFromCall!(
        { kind: 'other', rawInput: { providerIdentifier: 'kepcup', toolName: 'remember' } },
        bridge,
      ),
    ).toBeNull();
    // A free-text title never counts.
    expect(cursorProvider.bridgeToolFromCall!({ title: `${bridge}: remember` }, bridge)).toBeNull();
  });
});

describe('Google Antigravity', () => {
  const advertised = [
    { id: 'oauth-personal', name: 'Google 账号' },
    { id: 'oauth-business', name: 'Gemini Enterprise' },
    { id: 'gemini-api-key', name: 'Gemini API key' },
    { id: 'agent-platform', name: 'Agent Platform' },
    { id: 'gateway', name: 'AI Gateway' },
  ];

  it('keeps only gemini-api-key and agent-platform', () => {
    expect(filterAntigravityAuthMethods(advertised).map((method) => method.id)).toEqual([
      'gemini-api-key',
      'agent-platform',
    ]);
    expect(antigravityProvider.authMethods!(advertised).map((method) => method.id)).not.toContain(
      'oauth-personal',
    );
  });

  it('every tier maps to `default`; auto_edit / yolo are never entered', async () => {
    for (const tier of ['read_only', 'ask', 'workspace'] as const) {
      const { ctx, calls } = tierContext(['default', 'auto_edit', 'yolo'], 'default');
      await antigravityProvider.applyPermissionTier(tier, ctx);
      expect(calls).toEqual([]);
    }
    // A session sitting in auto_edit is moved back to default.
    const { ctx, calls } = tierContext(['default', 'auto_edit', 'yolo'], 'auto_edit');
    await antigravityProvider.applyPermissionTier('workspace', ctx);
    expect(calls).toEqual(['mode:default']);
  });

  it('an agent switching itself into auto_edit is switched back by the engine', async () => {
    const entry = fakeAgentEntry('fake-agy', { provider: 'antigravity' });
    const { engine, started, spec } = setup(entry, {
      modes: {
        currentModeId: 'default',
        availableModes: [
          { id: 'default', name: 'Default' },
          { id: 'auto_edit', name: 'Auto Edit' },
          { id: 'yolo', name: 'YOLO' },
        ],
      },
      turns: [agentTurn().modeUpdate('auto_edit').sleep(50).text('完成')],
    });
    const outcome = await engine.startRun(spec('workspace')).done;
    expect(outcome.status).toBe('completed');
    expect(started[0]!.observed.events.filter((event) => event.kind === 'mode')).toEqual([
      { kind: 'mode', sessionId: 'fake-session-1', modeId: 'default' },
    ]);
  });

  it('runs with a private GEMINI_HOME and never disables workspace trust', async () => {
    const entry = fakeAgentEntry('fake-agy', { provider: 'antigravity' });
    const { engine, launches, spec, stateRoot } = setup(entry, {
      modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }] },
      turns: [agentTurn().text('ok')],
    });
    await engine.startRun(spec()).done;
    const env = launches[0]!.env;
    expect(env.GEMINI_HOME).toBe(path.join(stateRoot, 'fake-agy', 'gemini-home'));
    expect(readdirSync(path.join(stateRoot, 'fake-agy'))).toEqual(['gemini-home']);
    expect(env.AGY_ACP_DISABLE_WORKSPACE_TRUST).toBeUndefined();
    // Without a state dir it still never shares the user's ~/.gemini.
    expect(antigravityGeminiHome(undefined)).not.toContain('.gemini');
  });

  it('recognizes MCP calls by `_meta.mcp` of this bridge only', () => {
    const bridge = 'kepcup_ab12cd34';
    const meta = { mcp: { server: bridge, tool: 'send_message' }, is_mcp_tool_call: true };
    expect(antigravityProvider.bridgeToolFromCall!({ kind: 'other', _meta: meta }, bridge)).toBe(
      'send_message',
    );
    expect(
      antigravityProvider.bridgeToolFromCall!(
        { _meta: { ...meta, mcp: { server: 'kepcup', tool: 'send_message' } } },
        bridge,
      ),
    ).toBeNull();
    expect(
      antigravityProvider.bridgeToolFromCall!({ _meta: { mcp: meta.mcp } }, bridge),
    ).toBeNull();
    expect(antigravityProvider.permissionOptions).toEqual({
      allowOnce: ['allow'],
      rejectOnce: ['deny'],
    });
  });
});

describe('installer: binary platforms without a pinned sha256', () => {
  const unpinned = {
    ...catalog('cursor'),
    id: 'unpinned',
    distribution: {
      binary: {
        'linux-x86_64': {
          archive: 'https://example.invalid/agent.tar.gz',
          cmd: './agent',
          // sha256 missing (not computed yet)
        },
      },
    },
  } as unknown as AgentCatalogEntry;

  it('treats the platform as not installable and refuses to download', async () => {
    expect(managedKindFor(unpinned, 'linux', 'x64')).toBeNull();
    const root = tempDir('kepcup-p5-installer-');
    let downloads = 0;
    const installer = new AgentInstaller({
      toolchainsDir: path.join(root, 'toolchains'),
      downloadsDir: path.join(root, 'downloads'),
      nodeRuntime: async () => {
        throw new Error('unused');
      },
      platform: 'linux',
      arch: 'x64',
      download: async () => {
        downloads += 1;
      },
    });
    expect(installer.kindFor(unpinned)).toBe('none');
    await expect(installer.install(unpinned)).rejects.toMatchObject({ code: 'AGENT_INCOMPATIBLE' });
    expect(downloads).toBe(0);
    // Pinned catalog entries stay installable on every platform.
    for (const id of ['opencode', 'cursor', 'antigravity-acp']) {
      for (const [platform, arch] of [
        ['linux', 'x64'],
        ['linux', 'arm64'],
        ['darwin', 'x64'],
        ['darwin', 'arm64'],
        ['win32', 'x64'],
        ['win32', 'arm64'],
      ] as const) {
        expect(managedKindFor(catalog(id), platform, arch), `${id} ${platform}-${arch}`).toBe(
          'binary',
        );
      }
    }
  });
});
