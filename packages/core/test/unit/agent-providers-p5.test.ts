import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
  opencodeConfigHome,
  opencodeProvider,
  opencodeUserConfigIssues,
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

// Model of opencode 1.18.35 (bundled source, 复审 #8): config layers merged
// with remeda mergeDeep ({...target, ...source}: existing keys keep their
// position, new keys are appended, objects merge recursively), mode.* folded
// into agent.* after every layer, OPENCODE_PERMISSION merged into the top
// level; Permission.fromConfig expands each object in key order into rules,
// merge concatenates [defaults, top level, agent], and evaluate takes the
// findLast rule whose permission (wildcard) matches.
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const mergeDeep = (target: unknown, source: unknown): unknown => {
  if (!isObject(target) || !isObject(source)) return source;
  const out: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(source)) out[key] = mergeDeep(out[key], value);
  return out;
};
const wildcard = (pattern: string, value: string) =>
  new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(value);
const fromConfig = (permission: Record<string, unknown>) =>
  Object.entries(permission).flatMap(([name, action]) =>
    typeof action === 'string'
      ? [{ permission: name, pattern: '*', action }]
      : Object.entries(action as Record<string, string>).map(([pattern, inner]) => ({
          permission: name,
          pattern,
          action: inner,
        })),
  );
const evaluate = (permission: string, rules: ReturnType<typeof fromConfig>) =>
  rules.findLast((rule) => wildcard(rule.permission, permission))?.action ?? 'ask';
interface Layered {
  permission: Record<string, unknown>;
  agent: Record<string, { permission: Record<string, unknown> }>;
  mode?: Record<string, unknown>;
}
function resolveConfig(layers: unknown[], opencodePermission: string): Layered {
  let config = layers.reduce((acc, layer) => mergeDeep(acc, layer), {}) as Layered;
  for (const [name, mode] of Object.entries(config.mode ?? {})) {
    config = mergeDeep(config, {
      agent: { [name]: { ...(mode as object), mode: 'primary' } },
    }) as Layered;
  }
  config.permission = mergeDeep(config.permission, JSON.parse(opencodePermission)) as Record<
    string,
    unknown
  >;
  return config;
}
function rulesFor(config: Layered, agent: string) {
  return [
    ...fromConfig({ '*': 'allow', question: 'deny' }),
    ...fromConfig(config.permission),
    ...fromConfig(config.agent[agent]!.permission),
  ];
}

describe('OpenCode', () => {
  // The launch scans the user's OpenCode config layers (复审 #8): keep the
  // tests independent of the machine's real ~/.opencode / ~/.config.
  const savedEnv = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  let fakeHome = '';
  beforeEach(() => {
    fakeHome = mkdtempSync(path.join(tmpdir(), 'kepcup-oc-home-'));
    process.env.HOME = fakeHome;
    delete process.env.XDG_CONFIG_HOME;
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it('process config: string-only rules led by "*":"ask" on every layer; project / plugin config off', () => {
    const launch = opencodeProvider.launch({
      entry: catalog('opencode'),
      target: { command: '/x/opencode', args: ['acp'], env: { OPENCODE_CONFIG_CONTENT: 'evil' } },
      platform: 'linux',
      dataHome: '/home/u/.kepcup',
      stateDir: '/home/u/.kepcup/agents/opencode',
    });
    expect(launch.command).toBe('/x/opencode');
    expect(launch.args).toEqual(['acp']);
    expect(launch.env).toMatchObject({
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      OPENCODE_PURE: '1',
      OPENCODE_DISABLE_CLAUDE_CODE: '1',
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      // The user's global config is not loaded (private config root).
      XDG_CONFIG_HOME: path.join('/home/u/.kepcup/agents/opencode', 'xdg-config'),
    });
    const content = JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT!) as {
      permission: Record<string, unknown>;
      agent: Record<string, { permission: Record<string, unknown> }>;
      mode: Record<string, { permission: Record<string, unknown> }>;
    };
    const top = content.permission;
    // Every action is a string; "*" comes first (findLast: later keys win).
    expect(Object.keys(top)[0]).toBe('*');
    expect(top['*']).toBe('ask');
    expect(Object.values(top).every((value) => typeof value === 'string')).toBe(true);
    expect(top).toMatchObject({
      edit: 'ask',
      bash: 'ask',
      external_directory: 'ask',
      task: 'ask',
      webfetch: 'ask',
      read: 'allow',
      question: 'deny',
    });
    expect(Object.keys(content.agent).sort()).toEqual(['build', 'explore', 'general', 'plan']);
    expect(Object.keys(content.mode).sort()).toEqual(['build', 'plan']);
    expect(content.agent.build!.permission).toEqual(top);
    expect(content.agent.plan!.permission).toEqual({ ...top, edit: 'deny' });
    expect(content.agent.explore!.permission.edit).toBe('deny');
    // Re-applied to the top level after every config layer.
    expect(JSON.parse(launch.env.OPENCODE_PERMISSION!)).toEqual(top);
    // No persona / per-session text in the process-level config.
    expect(launch.env.OPENCODE_CONFIG_CONTENT).not.toMatch(/instructions|prompt/);
    // 「加载我的个人配置」: the user's own config root stays.
    const user = opencodeProvider.launch({
      entry: catalog('opencode'),
      target: { command: '/x/opencode', args: ['acp'], env: {} },
      platform: 'linux',
      loadUserConfig: true,
    });
    expect(user.env.XDG_CONFIG_HOME).toBeUndefined();
    // No private state directory → refuses instead of using the user's config.
    expect(() =>
      opencodeProvider.launch({
        entry: catalog('opencode'),
        target: { command: '/x/opencode', args: ['acp'], env: {} },
        platform: 'linux',
      }),
    ).toThrow(/私有状态目录/);
  });

  it('layers overriding our named keys (incl. {"bash":"allow","*":"allow"}) lose to the host rules (H1, 审查 #7)', () => {
    const launch = opencodeProvider.launch({
      entry: catalog('opencode'),
      target: { command: 'opencode', args: ['acp'], env: {} },
      platform: 'linux',
      loadUserConfig: true,
      stateDir: '/s',
    });
    const permissive = {
      permission: {
        bash: 'allow',
        edit: 'allow',
        '*': 'allow',
        external_directory: { '*': 'allow' },
      },
    };
    const layers: unknown[] = [
      // user global ~/.config/opencode/opencode.json
      {
        permission: { bash: 'allow', '*': 'allow', webfetch: 'allow' },
        agent: { build: permissive, general: permissive },
      },
      // a project's opencode.json (disabled by OPENCODE_DISABLE_PROJECT_CONFIG, modelled anyway)
      { agent: { build: permissive, plan: permissive }, mode: { build: permissive } },
      // ~/.opencode/agent/*.md frontmatter
      { agent: { explore: permissive, general: { permission: { bash: 'allow', '*': 'allow' } } } },
      JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT!),
    ];
    const config = resolveConfig(layers, launch.env.OPENCODE_PERMISSION!);
    for (const name of ['build', 'plan', 'general', 'explore']) {
      const rules = rulesFor(config, name);
      expect(evaluate('bash', rules), name).toBe('ask');
      expect(evaluate('external_directory', rules), name).toBe('ask');
      expect(evaluate('task', rules), name).toBe('ask');
      expect(evaluate('webfetch', rules), name).toBe('ask');
      // A permission nobody named (e.g. a future tool) asks too.
      expect(evaluate('some_new_tool', rules), name).toBe('ask');
      // Never auto-allowed; plan / explore deny unless a permissive layer put a
      // later "*" key in their object (then the host still decides: ask).
      expect(evaluate('edit', rules), name).not.toBe('allow');
    }
  });

  it('unnamed user keys ("b*", "**") would win by key order → the launch refuses them (复审 #8)', () => {
    const launch = (loadUserConfig: boolean) =>
      opencodeProvider.launch({
        entry: catalog('opencode'),
        target: { command: '/x/opencode', args: ['acp'], env: {} },
        platform: 'linux',
        stateDir: path.join(fakeHome, 'state'),
        loadUserConfig,
      });
    const ours = launch(false);
    // Why a scan is needed: the model lets such a layer win.
    for (const [agent, layer] of [
      ['build', { mode: { build: { permission: { 'b*': 'allow' } } } }],
      [
        'general',
        { agent: { general: { permission: { '*': 'ask', bash: 'ask', '**': 'allow' } } } },
      ],
      ['build', { agent: { build: { permission: { '*': 'ask', bash: 'ask', 'b*': 'allow' } } } }],
    ] as const) {
      const config = resolveConfig(
        [layer, JSON.parse(ours.env.OPENCODE_CONFIG_CONTENT!)],
        ours.env.OPENCODE_PERMISSION!,
      );
      expect(evaluate('bash', rulesFor(config, agent)), JSON.stringify(layer)).toBe('allow');
    }
    // Layers that only ask / deny never produce an allow, whatever the order.
    const strict = resolveConfig(
      [
        { permission: { '*': 'ask', bash: 'ask', 'b*': 'deny', '**': 'ask' } },
        { mode: { build: { permission: { 'b*': 'ask', '**': 'deny' } } } },
        JSON.parse(ours.env.OPENCODE_CONFIG_CONTENT!),
      ],
      ours.env.OPENCODE_PERMISSION!,
    );
    for (const permission of ['bash', 'edit', 'external_directory', 'task', 'webfetch', 'skill']) {
      expect(evaluate(permission, rulesFor(strict, 'build')), permission).not.toBe('allow');
    }

    const dotDir = path.join(fakeHome, '.opencode');
    mkdirSync(dotDir, { recursive: true });
    // Read-only allows and ask / deny rules are fine.
    writeFileSync(
      path.join(dotDir, 'opencode.json'),
      JSON.stringify({ permission: { read: 'allow', bash: 'ask', '*': 'deny' } }),
    );
    expect(() => launch(false)).not.toThrow();
    for (const loadUserConfig of [false, true]) {
      writeFileSync(
        path.join(dotDir, 'opencode.jsonc'),
        '// mine\n{ "mode": { "build": { "permission": { "b*": "allow", } } }, }',
      );
      expect(() => launch(loadUserConfig)).toThrow(/mode\.build\.permission\.b\*/);
      try {
        launch(loadUserConfig);
      } catch (error) {
        expect(error).toMatchObject({ code: 'AGENT_INCOMPATIBLE' });
      }
      rmSync(path.join(dotDir, 'opencode.jsonc'));
    }
    // ~/.opencode agent markdown (frontmatter) and custom tools.
    mkdirSync(path.join(dotDir, 'agent', 'nested'), { recursive: true });
    writeFileSync(
      path.join(dotDir, 'agent', 'nested', 'helper.md'),
      '---\ndescription: helper\npermission:\n  "**": allow\n---\nbody',
    );
    expect(() => launch(false)).toThrow(/helper\.md/);
    rmSync(path.join(dotDir, 'agent'), { recursive: true });
    mkdirSync(path.join(dotDir, 'tools'));
    writeFileSync(path.join(dotDir, 'tools', 'x.ts'), 'export default {}');
    expect(() => launch(false)).toThrow(/自定义工具/);
    rmSync(path.join(dotDir, 'tools'), { recursive: true });

    // 「加载我的个人配置」: the user's global config is scanned too; off, it is not read.
    const userConfig = path.join(fakeHome, '.config', 'opencode');
    mkdirSync(userConfig, { recursive: true });
    writeFileSync(
      path.join(userConfig, 'opencode.json'),
      JSON.stringify({ permission: { '**': 'allow' }, tools: { bash: true } }),
    );
    expect(() => launch(false)).not.toThrow();
    expect(() => launch(true)).toThrow(/permission\.\*\*/);
    expect(
      opencodeUserConfigIssues({ home: fakeHome, configHome: userConfig }).map((issue) =>
        issue.slice(userConfig.length + 1),
      ),
    ).toEqual(['opencode.json: permission.**', 'opencode.json: tools.bash']);
    process.env.XDG_CONFIG_HOME = path.join(fakeHome, 'xdg');
    expect(() => launch(true)).not.toThrow();
    // The private config root is scanned as well; unparsable files fail closed.
    const privateDir = path.join(opencodeConfigHome(path.join(fakeHome, 'state')), 'opencode');
    mkdirSync(privateDir, { recursive: true });
    writeFileSync(path.join(privateDir, 'config.json'), '{ not json');
    expect(() => launch(false)).toThrow(/无法解析/);
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
    // Project config is off: AGENTS.md is injected by the host instead.
    expect(opencodeProvider.agentSideConfigFiles).toEqual([]);
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
      permission: { external_directory: 'ask', bash: 'ask' },
    });
    expect(launches[0]!.env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1');
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

  it('keeps only gemini-api-key (agent-platform hidden until its config entry exists, M3)', () => {
    expect(filterAntigravityAuthMethods(advertised).map((method) => method.id)).toEqual([
      'gemini-api-key',
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
    // Without a private state dir it refuses (never a shared temp dir, M4).
    expect(() => antigravityGeminiHome(undefined)).toThrow(/私有状态目录/);
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
