import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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
import { hostBridgeToolOf } from '../../src/agent/external/acp/client.js';
import { ExternalAgentEngine } from '../../src/agent/external/engine.js';
import { AgentHost } from '../../src/agent/external/host.js';
import { AgentInstaller, managedKindFor } from '../../src/agent/external/installer.js';
import { isForbiddenAgentMode } from '../../src/agent/external/permission-bridge.js';
import { classifierFor, toAgentError } from '../../src/agent/external/errors.js';
import {
  describeAuthMethods,
  terminalLoginCommand,
} from '../../src/agent/external/terminal-auth.js';
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
  opencodePermissionConfig,
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
  const cwd = tempDir('kepcup-p5-work-');
  const spec = (permission: AgentPermissionTier = 'read_only'): RunSpec => ({
    identity: { runId: 'run_1', botId: 'bot_1', conversationId: 'conv_1', loopType: 'turn' },
    model: agentModelRef(entry.id, ''),
    buildSystemPrompt: async () => 'SYSTEM',
    messages: [{ role: 'user', content: 'HELLO', timestamp: 0 }],
    tools: [],
    limits: { maxTurns: 60 },
    cwd,
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

// Model of OpenCode 2.4.2 ConfigNormalize + ConfigAgentPlugin: V1 permission /
// tools / agent / mode fields normalize into native rule arrays, documents append
// top-level rules, agent rules append after all global rules, and findLast wins.
type Rule = { action: string; resource: string; effect: string };
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const wildcard = (pattern: string, value: string) =>
  new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')}$`,
  ).test(value);
const normalizeAction = (action: string) =>
  (
    ({
      write: 'edit',
      patch: 'edit',
      apply_patch: 'edit',
      task: 'subagent',
      bash: 'shell',
    }) as Record<string, string>
  )[action] ?? action;
const rule = (action: string, effect: string, resource = '*'): Rule => ({
  action,
  resource,
  effect,
});
const nativeRules = (value: unknown): Rule[] =>
  Array.isArray(value)
    ? value.flatMap((item) =>
        isObject(item) &&
        typeof item.action === 'string' &&
        typeof item.resource === 'string' &&
        typeof item.effect === 'string'
          ? [{ action: item.action, resource: item.resource, effect: item.effect }]
          : [],
      )
    : [];
const toolRules = (value: unknown): Rule[] =>
  isObject(value)
    ? Object.entries(value).flatMap(([action, enabled]) =>
        typeof enabled === 'boolean'
          ? [rule(normalizeAction(action), enabled ? 'allow' : 'deny')]
          : [],
      )
    : [];
const legacyPermissionRules = (value: unknown): Rule[] => {
  if (typeof value === 'string')
    return ['allow', 'ask', 'deny'].includes(value) ? [rule('*', value)] : [];
  if (!isObject(value)) return [];
  return Object.entries(value).flatMap(([action, raw]) => {
    if (typeof raw === 'string') {
      return ['allow', 'ask', 'deny'].includes(raw) ? [rule(normalizeAction(action), raw)] : [];
    }
    if (!isObject(raw)) return [];
    return Object.entries(raw).flatMap(([resource, effect]) =>
      typeof effect === 'string' && ['allow', 'ask', 'deny'].includes(effect)
        ? [rule(normalizeAction(action), effect, resource)]
        : [],
    );
  });
};
const legacyAgentRules = (agent: Record<string, unknown>): Rule[] => [
  ...toolRules(agent.tools),
  ...legacyPermissionRules(agent.permission),
];
function normalizeDocument(value: unknown): {
  permissions: Rule[];
  agents: Record<string, { permissions: Rule[] }>;
} {
  if (!isObject(value)) return { permissions: [], agents: {} };
  const agents: Record<string, { permissions: Rule[] }> = {};
  for (const section of ['agent', 'mode'] as const) {
    const entries = value[section];
    if (!isObject(entries)) continue;
    for (const [name, agent] of Object.entries(entries)) {
      if (isObject(agent)) agents[name] = { permissions: legacyAgentRules(agent) };
    }
  }
  // Within one document native agents replace the migrated V1 entry.
  if (isObject(value.agents)) {
    for (const [name, agent] of Object.entries(value.agents)) {
      if (isObject(agent)) agents[name] = { permissions: nativeRules(agent.permissions) };
    }
  }
  return {
    permissions: [
      ...toolRules(value.tools),
      ...legacyPermissionRules(value.permission),
      ...nativeRules(value.permissions),
    ],
    agents,
  };
}
interface Layered {
  permissions: Rule[];
  agents: Record<string, { permissions: Rule[] }>;
}
function resolveConfig(layers: unknown[]): Layered {
  const config: Layered = { permissions: [], agents: {} };
  for (const layer of layers.map(normalizeDocument)) {
    config.permissions.push(...layer.permissions);
    for (const [name, agent] of Object.entries(layer.agents)) {
      config.agents[name] ??= { permissions: [] };
      config.agents[name]!.permissions.push(...agent.permissions);
    }
  }
  return config;
}
const evaluate = (action: string, rules: Rule[], resource = '*') =>
  rules.findLast(
    (candidate) => wildcard(candidate.action, action) && wildcard(candidate.resource, resource),
  )?.effect ?? 'ask';
function rulesFor(config: Layered, agent: string): Rule[] {
  return [
    rule('*', 'allow'),
    rule('read', 'ask', '*.env'),
    rule('read', 'ask', '*.env.*'),
    rule('read', 'allow', '*.env.example'),
    ...config.permissions,
    ...(config.agents[agent]?.permissions ?? []),
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

  it('process config: native V2 rule arrays, plugin deny, dangerous flags off; V1 fields retained', () => {
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
      OPENCODE_CONFIG_PROJECT_DISABLE: '1',
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      OPENCODE_FILEWATCHER_DISABLE: '1',
      OPENCODE_DISABLE_FILEWATCHER: '1',
      OPENCODE_FLAGS:
        '-portable_shell_scanner,-codemode_vm,-todo,-media_blob,-artifacts,-console_watches,-recommended_api,-model_speeds,-full_codemode,-codemode_agents,-machines,-home_memory,-project_overlay,-opencode_api,-mcp_skills,-compaction_jobs,-sqlite_fts,-browser_stream_tunnel,-video_generate,-part_rows,-image_generate,-disable_paste_summary,-batch_tool,-openTelemetry,-continue_loop_on_deny',
      // Legacy V1 switches are not the V2 security boundary.
      OPENCODE_PURE: '1',
      OPENCODE_DISABLE_CLAUDE_CODE: '1',
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      // The user's global config is not loaded (private config root).
      XDG_CONFIG_HOME: path.join('/home/u/.kepcup/agents/opencode', 'xdg-config'),
    });
    const content = JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT!) as {
      permissions: Rule[];
      permission: Record<string, string>;
      agents: Record<string, { permissions: Rule[] }>;
      mode: Record<string, { permissions: Rule[]; permission: Record<string, string> }>;
      agent: Record<string, { permission: Record<string, string> }>;
      policies: unknown[];
      experimental: Record<string, boolean>;
      automations: boolean;
      update: string;
      autoupdate: boolean;
      share: string;
    };
    const top = content.permissions;
    expect(top).toEqual(opencodePermissionConfig());
    expect(top[0]).toEqual(rule('*', 'ask'));
    expect(top).toEqual(
      expect.arrayContaining([
        rule('read', 'allow'),
        rule('glob', 'allow'),
        rule('grep', 'allow'),
        rule('edit', 'ask'),
        rule('shell', 'ask'),
        rule('external_directory', 'ask'),
        rule('subagent', 'ask'),
        rule('webfetch', 'ask'),
        rule('websearch', 'ask'),
        rule('question', 'deny'),
        rule('execute', 'deny'),
        rule('opencode_session_*', 'deny'),
        rule('opencode_worktree_*', 'deny'),
        rule('automation_*', 'deny'),
      ]),
    );
    expect(content.permission).toMatchObject({ '*': 'ask', bash: 'ask', task: 'ask', edit: 'ask' });
    expect(Object.keys(content.agent).sort()).toEqual(['build', 'explore', 'general', 'plan']);
    expect(Object.keys(content.agents).sort()).toEqual(['build', 'explore', 'general', 'plan']);
    expect(Object.keys(content.mode).sort()).toEqual(['build', 'plan']);
    expect(content.agent.plan!.permission.edit).toBe('deny');
    expect(content.agents.build!.permissions).toEqual(top);
    expect(content.agents.plan!.permissions).toEqual([...top, rule('edit', 'deny')]);
    expect(content.agents.general!.permissions).toEqual([...top, rule('subagent', 'deny')]);
    expect(content.agents.explore!.permissions).toEqual([
      ...top,
      rule('edit', 'deny'),
      rule('subagent', 'deny'),
    ]);
    // V2 schema does not allow a legacy `permission` key inside agents.<id>.
    expect('permission' in content.agents.plan!).toBe(false);
    expect(content.mode.build!.permissions).toEqual(top);
    expect(content.policies).toEqual([{ action: 'plugin.use', resource: '*', effect: 'deny' }]);
    expect(content.automations).toBe(false);
    expect(content.update).toBe('disable');
    expect(content.autoupdate).toBe(false);
    expect(content.share).toBe('disabled');
    expect(content.experimental.all_flags).toBe(false);
    for (const flag of [
      'project_overlay',
      'sqlite_fts',
      'home_memory',
      'full_codemode',
      'machines',
      'artifacts',
      'console_watches',
      'opencode_api',
      'browser_stream_tunnel',
      'codemode_vm',
      'codemode_agents',
      'mcp_skills',
      'continue_loop_on_deny',
    ]) {
      expect(content.experimental[flag], flag).toBe(false);
    }
    expect(JSON.parse(launch.env.OPENCODE_PERMISSION!)).toEqual(content.permission);
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

  it('V2 layers append rule arrays; host global + built-in agent rules win by findLast', () => {
    const launch = opencodeProvider.launch({
      entry: catalog('opencode'),
      target: { command: 'opencode', args: ['acp'], env: {} },
      platform: 'linux',
      loadUserConfig: true,
      stateDir: '/s',
    });
    const permissive = {
      permissions: [
        rule('shell', 'allow'),
        rule('edit', 'allow'),
        rule('*', 'allow'),
        rule('external_directory', 'allow'),
      ],
    };
    const layers: unknown[] = [
      // user global ~/.config/opencode/opencode.json
      {
        permissions: [rule('shell', 'allow'), rule('*', 'allow'), rule('webfetch', 'allow')],
        agents: { build: permissive, general: permissive },
      },
      // a workdir's opencode.json (disabled by the enforced project switch, modelled anyway)
      { agents: { build: permissive, plan: permissive }, mode: { build: permissive } },
      // ~/.opencode/agent/*.md frontmatter normalizes into an agents document
      { agents: { explore: permissive, general: permissive } },
      JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT!),
    ];
    const config = resolveConfig(layers);
    for (const name of ['build', 'plan', 'general', 'explore']) {
      const rules = rulesFor(config, name);
      expect(evaluate('shell', rules), name).toBe('ask');
      expect(evaluate('external_directory', rules), name).toBe('ask');
      expect(evaluate('subagent', rules), name).toBe(
        name === 'general' || name === 'explore' ? 'deny' : 'ask',
      );
      expect(evaluate('webfetch', rules), name).toBe('ask');
      expect(evaluate('some_new_tool', rules), name).toBe('ask');
      expect(evaluate('edit', rules), name).toBe(
        name === 'plan' || name === 'explore' ? 'deny' : 'ask',
      );
      expect(evaluate('read', rules), name).toBe('allow');
      expect(evaluate('glob', rules), name).toBe('allow');
      expect(evaluate('grep', rules), name).toBe('allow');
      expect(evaluate('question', rules), name).toBe('deny');
      expect(evaluate('execute', rules), name).toBe('deny');
      expect(evaluate('opencode_session_move', rules), name).toBe('deny');
      expect(evaluate('opencode_worktree_remove', rules), name).toBe('deny');
      expect(evaluate('automation_create', rules), name).toBe('deny');
    }
    // V1 bash/task names normalize to V2 shell/subagent; native agents replace
    // the migrated entry within one document, then later documents append.
    const v1 = resolveConfig([
      {
        permission: { bash: 'allow', '*': 'allow' },
        agent: { custom: { permission: { 's*': 'allow' } } },
        mode: { build: { permission: { bash: 'allow' } } },
      },
      JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT!),
    ]);
    expect(evaluate('shell', rulesFor(v1, 'build'))).toBe('ask');
    expect(evaluate('shell', rulesFor(v1, 'custom'))).toBe('allow');
  });

  it.skipIf(process.platform === 'win32')(
    'V1 wildcard allows on custom agents bypass host rules → the config check refuses them',
    () => {
      const launch = (loadUserConfig: boolean) =>
        opencodeProvider.launch({
          entry: catalog('opencode'),
          target: { command: '/x/opencode', args: ['acp'], env: {} },
          platform: 'linux',
          stateDir: path.join(fakeHome, 'state'),
          loadUserConfig,
        });
      // The scan is the provider's checkConfig (run processes and every session
      // open); launch itself (control processes: logout …) never scans.
      const check = (loadUserConfig: boolean) =>
        opencodeProvider.checkConfig!({
          entry: catalog('opencode'),
          platform: 'linux',
          stateDir: path.join(fakeHome, 'state'),
          loadUserConfig,
        });
      const ours = launch(false);
      // Why a scan is needed: custom-agent rules append after our global rules.
      for (const [agent, layer] of [
        ['custom-mode', { mode: { 'custom-mode': { permission: { 's*': 'allow' } } } }],
        [
          'custom-general',
          {
            agent: { 'custom-general': { permission: { '*': 'ask', bash: 'ask', '**': 'allow' } } },
          },
        ],
        [
          'custom-build',
          { agent: { 'custom-build': { permission: { '*': 'ask', bash: 'ask', 's*': 'allow' } } } },
        ],
      ] as const) {
        const config = resolveConfig([layer, JSON.parse(ours.env.OPENCODE_CONFIG_CONTENT!)]);
        expect(evaluate('shell', rulesFor(config, agent)), JSON.stringify(layer)).toBe('allow');
      }
      // Layers that only ask / deny never produce an allow, whatever the order.
      const strict = resolveConfig([
        { permission: { '*': 'ask', bash: 'ask', 'b*': 'deny', '**': 'ask' } },
        { mode: { build: { permission: { 'b*': 'ask', '**': 'deny' } } } },
        JSON.parse(ours.env.OPENCODE_CONFIG_CONTENT!),
      ]);
      for (const permission of [
        'shell',
        'edit',
        'external_directory',
        'subagent',
        'webfetch',
        'skill',
      ]) {
        expect(evaluate(permission, rulesFor(strict, 'build')), permission).not.toBe('allow');
      }

      const dotDir = path.join(fakeHome, '.opencode');
      mkdirSync(dotDir, { recursive: true });
      // Read-only allows and ask / deny rules are fine.
      writeFileSync(
        path.join(dotDir, 'opencode.json'),
        JSON.stringify({ permission: { read: 'allow', bash: 'ask', '*': 'deny' } }),
      );
      expect(() => check(false)).not.toThrow();
      for (const loadUserConfig of [false, true]) {
        writeFileSync(
          path.join(dotDir, 'opencode.jsonc'),
          '// mine\n{ "mode": { "build": { "permission": { "b*": "allow", } } }, }',
        );
        expect(() => check(loadUserConfig)).toThrow(/mode\.build\.permission\.b\*/);
        try {
          check(loadUserConfig);
        } catch (error) {
          expect(error).toMatchObject({ code: 'AGENT_CONFIG_UNSAFE' });
        }
        // Control processes (probe / login / logout) still start.
        expect(() => launch(loadUserConfig)).not.toThrow();
        rmSync(path.join(dotDir, 'opencode.jsonc'));
      }
      // ~/.opencode agent markdown (frontmatter) and custom tools.
      mkdirSync(path.join(dotDir, 'agent', 'nested'), { recursive: true });
      writeFileSync(
        path.join(dotDir, 'agent', 'nested', 'helper.md'),
        '---\ndescription: helper\npermission:\n  "**": allow\n---\nbody',
      );
      expect(() => check(false)).toThrow(/helper\.md/);
      rmSync(path.join(dotDir, 'agent'), { recursive: true });
      mkdirSync(path.join(dotDir, 'tools'));
      writeFileSync(path.join(dotDir, 'tools', 'x.ts'), 'export default {}');
      expect(() => check(false)).toThrow(/自定义工具/);
      rmSync(path.join(dotDir, 'tools'), { recursive: true });

      // 「加载我的个人配置」: the user's global config is scanned too; off, it is not read.
      const userConfig = path.join(fakeHome, '.config', 'opencode');
      mkdirSync(userConfig, { recursive: true });
      writeFileSync(
        path.join(userConfig, 'opencode.json'),
        JSON.stringify({ permission: { '**': 'allow' }, tools: { bash: true } }),
      );
      expect(() => check(false)).not.toThrow();
      expect(() => check(true)).toThrow(/permission\.\*\*/);
      expect(
        opencodeUserConfigIssues({ home: fakeHome, configHome: userConfig }).map((issue) =>
          issue.slice(userConfig.length + 1),
        ),
      ).toEqual(['opencode.json: permission.**', 'opencode.json: tools.bash']);
      process.env.XDG_CONFIG_HOME = path.join(fakeHome, 'xdg');
      expect(() => check(true)).not.toThrow();
      // The private config root is scanned as well; unparsable files fail closed.
      const privateDir = path.join(opencodeConfigHome(path.join(fakeHome, 'state')), 'opencode');
      mkdirSync(privateDir, { recursive: true });
      writeFileSync(path.join(privateDir, 'config.json'), '{ not json');
      expect(() => check(false)).toThrow(/无法解析/);
    },
  );

  it('V2 native permissions, agents, plugin policies and dangerous flags fail closed', () => {
    const dotDir = path.join(fakeHome, '.opencode');
    const configHome = path.join(fakeHome, 'cfg', 'opencode');
    mkdirSync(dotDir, { recursive: true });
    const file = path.join(dotDir, 'opencode.json');
    const issuesFor = (config: unknown): string[] => {
      writeFileSync(file, JSON.stringify(config));
      try {
        return opencodeUserConfigIssues({ home: fakeHome, configHome }).map((issue) =>
          issue.slice(dotDir.length + 1),
        );
      } finally {
        rmSync(file);
      }
    };
    expect(issuesFor({ permissions: [rule('read', 'allow'), rule('shell', 'allow')] })).toEqual([
      'opencode.json: permissions.1.action',
    ]);
    expect(issuesFor({ agents: { custom: { permissions: [rule('*', 'allow')] } } })).toEqual([
      'opencode.json: agents.custom.permissions.0.action',
    ]);
    expect(
      issuesFor({
        permissions: [rule('read', 'allow'), rule('shell', 'ask'), rule('edit', 'deny')],
      }),
    ).toEqual([]);
    expect(issuesFor({ permissions: { shell: 'allow' } })).toEqual(['opencode.json: permissions']);
    expect(
      issuesFor({ policies: [{ action: 'plugin.use', resource: '*', effect: 'allow' }] }),
    ).toEqual(['opencode.json: policies.0']);
    expect(
      issuesFor({
        policies: [{ action: 'integration.use', resource: 'plugin:local', effect: 'allow' }],
      }),
    ).toEqual(['opencode.json: policies.0']);
    expect(
      issuesFor({
        experimental: {
          policies: [{ action: 'plugin.use', resource: '*', effect: 'allow' }],
        },
      }),
    ).toEqual(['opencode.json: experimental.policies.0']);
    expect(
      issuesFor({ policies: [{ action: 'plugin.use', resource: '*', effect: 'deny' }] }),
    ).toEqual([]);
    for (const flag of [
      'project_overlay',
      'sqlite_fts',
      'home_memory',
      'full_codemode',
      'machines',
      'artifacts',
      'console_watches',
      'opencode_api',
      'all_flags',
    ]) {
      expect(issuesFor({ experimental: { [flag]: true } }), flag).toEqual([
        `opencode.json: experimental.${flag}`,
      ]);
      expect(issuesFor({ experimental: { [flag]: false } }), flag).toEqual([]);
    }
    expect(issuesFor({ plugins: ['-*'] })).toEqual([]);
    expect(issuesFor({ plugins: ['opencode-example-plugin'] })).toEqual([
      'opencode.json: plugins.0',
    ]);
    expect(issuesFor({ plugins: [{ package: './plugins/local' }] })).toEqual([
      'opencode.json: plugins.0',
    ]);
    expect(issuesFor({ plugin: [['opencode-example-plugin', {}]] })).toEqual([
      'opencode.json: plugin.0',
    ]);
  });

  it.skipIf(process.platform === 'win32')(
    'scans project config from a task subdirectory up to the git root',
    () => {
      const repo = path.join(fakeHome, 'repo');
      const sub = path.join(repo, 'packages', 'app');
      mkdirSync(path.join(repo, '.git'), { recursive: true });
      mkdirSync(sub, { recursive: true });
      writeFileSync(
        path.join(repo, 'opencode.json'),
        JSON.stringify({ permissions: [rule('shell', 'allow')] }),
      );
      expect(() =>
        opencodeProvider.checkConfig!({
          entry: catalog('opencode'),
          platform: 'linux',
          stateDir: path.join(fakeHome, 'state'),
          cwd: sub,
        }),
      ).toThrow(/opencode\.json: permissions\.0\.action/);

      // The `.opencode` project layer is read too (config, plugins, agents).
      rmSync(path.join(repo, 'opencode.json'));
      const dotDir = path.join(repo, '.opencode');
      mkdirSync(path.join(dotDir, 'plugins'), { recursive: true });
      writeFileSync(
        path.join(dotDir, 'opencode.json'),
        JSON.stringify({ permissions: [rule('shell', 'allow')] }),
      );
      const check = () =>
        opencodeProvider.checkConfig!({
          entry: catalog('opencode'),
          platform: 'linux',
          stateDir: path.join(fakeHome, 'state'),
          cwd: sub,
        });
      expect(check).toThrow(/\.opencode[\\/]opencode\.json: permissions\.0\.action/);

      rmSync(path.join(dotDir, 'opencode.json'));
      writeFileSync(path.join(dotDir, 'plugins', 'evil.ts'), 'export default {}');
      expect(check).toThrow(/\.opencode[\\/]plugins[\\/]evil\.ts: 自动发现插件/);

      // Plain project `plugins/` / `tools/` / `agent/` directories are not
      // OpenCode config roots and must not cause a false refusal.
      rmSync(dotDir, { recursive: true, force: true });
      for (const [dir, file] of [
        ['plugins', 'plugin.ts'],
        ['tools', 'tool.js'],
        ['agent', 'agent.md'],
      ] as const) {
        mkdirSync(path.join(repo, dir), { recursive: true });
        writeFileSync(path.join(repo, dir, file), 'export default {}');
      }
      expect(check).not.toThrow();

      mkdirSync(path.join(dotDir, 'agent'), { recursive: true });
      writeFileSync(
        path.join(dotDir, 'agent', 'risky.md'),
        '---\npermission:\n  bash: allow\n---\n',
      );
      expect(check).toThrow(/\.opencode[\\/]agent[\\/]risky\.md: frontmatter/);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'V2 auto-discovered plugins and project overlays are scanned',
    () => {
      const dotDir = path.join(fakeHome, '.opencode');
      const configHome = path.join(fakeHome, 'cfg', 'opencode');
      const issues = () => opencodeUserConfigIssues({ home: fakeHome, configHome });
      const pluginDir = path.join(dotDir, 'plugins');
      mkdirSync(path.join(pluginDir, 'package'), { recursive: true });
      expect(issues()).toEqual([expect.stringMatching(/plugins[\\/]package: 自动发现插件/)]);
      rmSync(path.join(pluginDir, 'package'), { recursive: true });
      writeFileSync(path.join(pluginDir, 'direct.js'), 'export default {}');
      expect(issues()).toEqual([expect.stringMatching(/plugins[\\/]direct\.js: 自动发现插件/)]);
      rmSync(path.join(pluginDir, 'direct.js'));
      writeFileSync(path.join(pluginDir, 'README.txt'), 'not a plugin');
      expect(issues()).toEqual([]);

      const singularPlugin = path.join(dotDir, 'plugin', 'local');
      mkdirSync(singularPlugin, { recursive: true });
      expect(issues()).toEqual([expect.stringMatching(/plugin[\\/]local: 自动发现插件/)]);
      rmSync(path.join(dotDir, 'plugin'), { recursive: true });

      const agentsDir = path.join(dotDir, 'agents');
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(
        path.join(agentsDir, 'helper.md'),
        '---\npermissions:\n  - action: shell\n    resource: "*"\n    effect: allow\n---\nbody',
      );
      expect(issues()).toEqual([expect.stringMatching(/agents[\\/]helper\.md/)]);

      const overlay = path.join(configHome, 'project', 'project_1');
      mkdirSync(path.join(overlay, 'agents'), { recursive: true });
      writeFileSync(
        path.join(overlay, 'opencode.json'),
        JSON.stringify({ permissions: [rule('shell', 'allow')] }),
      );
      writeFileSync(
        path.join(overlay, 'agents', 'helper.md'),
        '---\npermissions:\n  - action: shell\n    resource: "*"\n    effect: allow\n---\nbody',
      );
      mkdirSync(path.join(overlay, 'plugin', 'local'), { recursive: true });
      expect(issues()).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/project[\\/]project_1[\\/]opencode\.json: permissions\.0\.action/),
          expect.stringMatching(/helpers?\.md: frontmatter permissions\.0\.action/),
          expect.stringMatching(/project[\\/]project_1[\\/]plugin[\\/]local: 自动发现插件/),
        ]),
      );
    },
  );

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'an unreadable plugin directory fails closed instead of scanning as empty',
    () => {
      const dotDir = path.join(fakeHome, '.opencode');
      const pluginDir = path.join(dotDir, 'plugins');
      mkdirSync(pluginDir, { recursive: true });
      chmodSync(pluginDir, 0o000);
      try {
        expect(
          opencodeUserConfigIssues({ home: fakeHome, configHome: path.join(fakeHome, 'cfg') }),
        ).toEqual([expect.stringMatching(/plugins: 无法读取目录/)]);
      } finally {
        chmodSync(pluginDir, 0o700);
      }
    },
  );

  it('frontmatter is parsed as gray-matter + YAML would; V1 and V2 permission fields count', () => {
    const configHome = path.join(fakeHome, 'cfg', 'opencode');
    const agentDir = path.join(fakeHome, '.opencode', 'agent');
    mkdirSync(agentDir, { recursive: true });
    const issuesFor = (name: string, text: string): string[] => {
      const file = path.join(agentDir, name);
      writeFileSync(file, text);
      try {
        return opencodeUserConfigIssues({ home: fakeHome, configHome }).map((issue) =>
          issue.slice(agentDir.length + 1),
        );
      } finally {
        rmSync(file);
      }
    };
    // Valid YAML the old regex missed (OpenCode: gray-matter + js-yaml).
    for (const [name, text] of [
      ['true-title.md', '---\ntools:\n  bash: True\n---\nbody'],
      ['true-upper.md', '---\ntools:\n  bash: TRUE\n---\n'],
      ['flow.md', '---\n{tools: {bash: true}}\n---\n'],
      ['quoted-key.md', '---\n"tools":\n  "bash": yes\n---\n'],
      ['json.md', '---\n{"permission": {"bash": "allow"}}\n---\n'],
      ['escaped.md', '---\npermission:\n  bash: "\\x61llow"\n---\n'],
      ['continued.md', '---\npermission:\n  bash: "al\\\n    low"\n---\n'],
      ['anchor.md', '---\nbase: &b {bash: allow}\npermission:\n  <<: *b\n---\n'],
      ['string-permission.md', '---\npermission: ALLOW\n---\n'],
      ['crlf-bom.md', '\uFEFF---\r\npermission:\r\n  edit: allow\r\n---\r\n'],
      // Raw YAML fails ("foo: bar" value) → OpenCode re-parses the sanitized text.
      ['sanitized.md', '---\ndescription: a: b\npermission:\n  bash: allow\n---\n'],
      ['upper-ext.MD', '---\npermission:\n  task: allow\n---\n'],
      [
        'native-permissions.md',
        '---\npermissions:\n  - action: shell\n    resource: "*"\n    effect: allow\n---\n',
      ],
    ] as const) {
      expect(issuesFor(name, text), name).toEqual([expect.stringMatching(/^\S+: frontmatter /)]);
    }
    // gray-matter language fences: js / javascript would be eval'ed.
    for (const fence of ['js', 'javascript', 'json', 'coffee', 'toml']) {
      expect(issuesFor('fence.md', `---${fence}\n({permission: {}})\n---\n`), fence).toEqual([
        `fence.md: frontmatter 语言「${fence}」（只接受 YAML）`,
      ]);
    }
    expect(issuesFor('broken.md', '---\npermission: [ask\n---\n')).toEqual([
      'broken.md: frontmatter 无法解析',
    ]);
    expect(issuesFor('env.md', '---\npermission:\n  bash: "{env:X}"\n---\n')).toEqual([
      'env.md: frontmatter 含 {file:…} / {env:…}',
    ]);
    // Prose elsewhere no longer counts; ask / deny / false and read-only allows are fine.
    for (const [name, text] of [
      [
        'prose.md',
        '---\ndescription: tools that allow true refactors\npermission:\n  edit: ask\n  bash:\n    "git *": deny\n  read: allow\ntools:\n  read: true\n  bash: false\n---\nallow: true',
      ],
      ['yaml-fence.md', '---yaml\npermission:\n  "*": deny\n---\n'],
      [
        'native-safe.md',
        '---\npermissions:\n  - {action: read, resource: "*", effect: allow}\n  - {action: shell, resource: "*", effect: ask}\n---\n',
      ],
      ['comments.md', '---\n# nothing here\n---\n'],
      ['no-frontmatter.md', '----\npermission:\n  bash: allow\n'],
      ['plain.md', 'permission: allow\n'],
    ] as const) {
      expect(issuesFor(name, text), name).toEqual([]);
    }

    // JSON layers: substitutions and non-ask/deny strings fail closed.
    const dotDir = path.join(fakeHome, '.opencode');
    const json = (text: string) => {
      writeFileSync(path.join(dotDir, 'opencode.json'), text);
      try {
        return opencodeUserConfigIssues({ home: fakeHome, configHome }).map((issue) =>
          issue.slice(dotDir.length + 1),
        );
      } finally {
        rmSync(path.join(dotDir, 'opencode.json'));
      }
    };
    expect(json('{"permission": {"bash": "{env:BASH_RULE}"}}')).toEqual([
      'opencode.json: 含 {file:…} / {env:…} 替换（无法检查）',
    ]);
    expect(json('{"description": "{file:./x}"}')).toEqual([
      'opencode.json: 含 {file:…} / {env:…} 替换（无法检查）',
    ]);
    expect(json('{"permission": "ALLOW"}')).toEqual(['opencode.json: permission']);
    expect(json('{"agent": {"build": {"permission": {"bash": "allow "}}}}')).toEqual([
      'opencode.json: agent.build.permission.bash',
    ]);
    expect(json('{"permission": "ask", "agent": {"x": {"permission": {"bash": "deny"}}}}')).toEqual(
      [],
    );

    // Walk bounds: symlink loops end, too deep fails closed.
    const loopDir = path.join(agentDir, 'a');
    mkdirSync(loopDir, { recursive: true });
    symlinkSync(agentDir, path.join(loopDir, 'back'));
    writeFileSync(path.join(loopDir, 'ok.md'), '---\npermission:\n  bash: ask\n---\n');
    expect(opencodeUserConfigIssues({ home: fakeHome, configHome })).toEqual([]);
    rmSync(loopDir, { recursive: true });
    const deep = path.join(agentDir, ...Array.from({ length: 10 }, (_, i) => `d${i}`));
    mkdirSync(deep, { recursive: true });
    expect(opencodeUserConfigIssues({ home: fakeHome, configHome })).toEqual([
      expect.stringMatching(/agent: 目录过深/),
    ]);
  });

  it('JSON layers are tokenized like jsonc-parser 3.3.1: CR ends a // comment, BOM, NBSP, __proto__', () => {
    const dotDir = path.join(fakeHome, '.opencode');
    mkdirSync(dotDir, { recursive: true });
    const json = (text: string, name = 'opencode.jsonc') => {
      writeFileSync(path.join(dotDir, name), text);
      try {
        return opencodeUserConfigIssues({
          home: fakeHome,
          configHome: path.join(fakeHome, 'cfg'),
        }).map((issue) => issue.slice(dotDir.length + 1));
      } finally {
        rmSync(path.join(dotDir, name));
      }
    };
    // A lone CR ends a line comment for jsonc-parser: the keys after it apply.
    expect(json('{\n  // note\r  "permission": {"bash": "allow"}\n}')).toEqual([
      'opencode.jsonc: permission.bash',
    ]);
    expect(
      json('{"agent": {"build": {// x\r"permission": {"*": "allow"}}}}', 'opencode.json'),
    ).toEqual(['opencode.json: agent.build.permission.*']);
    expect(json('{ /* a\r\n b */ "permission": "allow", }')).toEqual([
      'opencode.jsonc: permission',
    ]);
    // Strings keep comment markers; CRLF line comments as before.
    expect(
      json(
        '{\r\n  // ok\r\n  "permission": {"bash": "ask", "read": "allow"},\r\n  "x": "// \\"y"\r\n}',
      ),
    ).toEqual([]);
    // OpenCode's TextDecoder drops one leading BOM: such a file is checked, not refused.
    expect(json('\uFEFF{"permission": {"bash": "ask"}}')).toEqual([]);
    expect(json('\uFEFF{"permission": {"edit": "allow"}}')).toEqual([
      'opencode.jsonc: permission.edit',
    ]);
    expect(json('')).toEqual([]);
    // NBSP / a second BOM are not whitespace for jsonc-parser (OpenCode rejects the file too).
    expect(json('{\u00a0"permission": {"bash": "ask"}}')).toEqual(['opencode.jsonc: 无法解析']);
    expect(json('\uFEFF\uFEFF{}')).toEqual(['opencode.jsonc: 无法解析']);
    expect(json('{"permission": {"bash": "ask"} /* open')).toEqual(['opencode.jsonc: 无法解析']);
    expect(json('{"permission": "ask\r"}')).toEqual(['opencode.jsonc: 无法解析']);
    // jsonc-parser assigns __proto__ (the keys below become inherited): refused.
    expect(json('{"__proto__": {"permission": {"bash": "allow"}}}')).toEqual([
      'opencode.jsonc: 含 __proto__ 键（无法检查）',
    ]);
    expect(json('{"agent": {"build": {"__proto__": {"permission": "allow"}}}}')).toEqual([
      'opencode.jsonc: 含 __proto__ 键（无法检查）',
    ]);
  });

  it.skipIf(process.platform === 'win32')(
    'config redirects in the catalog / target env are dropped; issues show ~ paths',
    () => {
      const redirects = {
        OPENCODE_CONFIG: '/evil/opencode.json',
        OPENCODE_CONFIG_DIR: '/evil',
        OPENCODE_TEST_HOME: '/evil-home',
        OPENCODE_TEST_MANAGED_CONFIG_DIR: '/evil-managed',
        opencode_config_dir: '/evil-lower',
        Opencode_Permission: '{"*":"allow"}',
        Opencode_Pure: '0',
        OPENCODE_CONFIG_CONTENT: '{"permissions":[]}',
        OPENCODE_DISABLE_CLAUDE_CODE: '0',
        OPENCODE_DISABLE_AUTOUPDATE: '0',
        Opencode_Config_Project_Disable: '0',
        OPENCODE_DISABLE_PROJECT_CONFIG: '0',
        Opencode_Filewatcher_Disable: '0',
        OPENCODE_DISABLE_FILEWATCHER: '0',
        opencode_flags: 'all',
        OPENCODE_DB: '/evil/state.db',
        HOME: '/evil-home',
        USERPROFILE: '/evil-profile',
        HOMEDRIVE: 'X:',
        HOMEPATH: '/evil',
        XDG_CONFIG_HOME: '/evil-xdg',
        XDG_DATA_HOME: '/evil-data',
        XDG_CACHE_HOME: '/evil-cache',
        XDG_STATE_HOME: '/evil-state',
        KEEP_ME: '1',
      };
      const entry = catalog('opencode');
      const withNpxEnv = {
        ...entry,
        distribution: {
          ...entry.distribution,
          npx: { package: 'opencode-ai@1.0.0', ...entry.distribution.npx, env: redirects },
        },
      } as typeof entry;
      for (const loadUserConfig of [false, true]) {
        for (const [launchEntry, env] of [
          [entry, redirects],
          [withNpxEnv, {}],
        ] as const) {
          const launch = opencodeProvider.launch({
            entry: launchEntry,
            target: { command: '/x/opencode', args: ['acp'], env },
            platform: 'linux',
            stateDir: '/s',
            loadUserConfig,
          });
          const keys = Object.keys(launch.env).map((key) => key.toUpperCase());
          for (const key of [
            'OPENCODE_CONFIG',
            'OPENCODE_CONFIG_DIR',
            'OPENCODE_TEST_HOME',
            'OPENCODE_TEST_MANAGED_CONFIG_DIR',
            'OPENCODE_DB',
            'HOME',
            'USERPROFILE',
            'HOMEDRIVE',
            'HOMEPATH',
            'XDG_DATA_HOME',
            'XDG_CACHE_HOME',
            'XDG_STATE_HOME',
          ]) {
            expect(keys, key).not.toContain(key);
          }
          for (const key of [
            'OPENCODE_CONFIG_CONTENT',
            'OPENCODE_FLAGS',
            'OPENCODE_CONFIG_PROJECT_DISABLE',
            'OPENCODE_DISABLE_PROJECT_CONFIG',
            'OPENCODE_FILEWATCHER_DISABLE',
            'OPENCODE_DISABLE_FILEWATCHER',
            'OPENCODE_PERMISSION',
            'OPENCODE_PURE',
          ]) {
            expect(
              keys.filter((candidate) => candidate === key),
              key,
            ).toHaveLength(1);
          }
          expect(launch.env.OPENCODE_CONFIG_PROJECT_DISABLE).toBe('1');
          expect(launch.env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1');
          expect(launch.env.OPENCODE_FILEWATCHER_DISABLE).toBe('1');
          expect(launch.env.OPENCODE_DISABLE_FILEWATCHER).toBe('1');
          expect(launch.env.OPENCODE_FLAGS).not.toContain('all');
          const content = JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT!) as {
            permission: Record<string, string>;
          };
          expect(JSON.parse(launch.env.OPENCODE_PERMISSION!)).toEqual(content.permission);
          expect(JSON.parse(launch.env.OPENCODE_PERMISSION!).bash).toBe('ask');
          expect(launch.env.XDG_CONFIG_HOME).toBe(
            loadUserConfig ? undefined : path.join('/s', 'xdg-config'),
          );
          expect(launch.env.KEEP_ME).toBe('1');
        }
      }

      // The unsafe-config message names files under the home directory as ~/….
      const dotDir = path.join(fakeHome, '.opencode');
      mkdirSync(dotDir, { recursive: true });
      writeFileSync(
        path.join(dotDir, 'opencode.json'),
        '{"permissions":[{"action":"shell","resource":"*","effect":"allow"}]}',
      );
      let caught: unknown;
      try {
        opencodeProvider.checkConfig!({
          entry,
          platform: 'linux',
          stateDir: path.join(fakeHome, 'state'),
        });
      } catch (error) {
        caught = error;
      }
      const message = (caught as Error).message;
      expect(message).toContain(
        `~${path.sep}${path.join('.opencode', 'opencode.json')}: permissions.0.action`,
      );
      expect(message).not.toContain(fakeHome);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'the config check runs before the process starts and before every session',
    async () => {
      const entry = fakeAgentEntry('fake-opencode', { provider: 'opencode' });
      const configOptions: FakeAgentScript['configOptions'] = [
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
      ];
      const { engine, started, spec, launches } = setup(entry, {
        configOptions,
        turns: [agentTurn().text('一'), agentTurn().text('二')],
      });
      expect(await engine.startRun(spec()).done).toMatchObject({ status: 'completed' });
      // Edited while the process lives: the next session open refuses.
      const dotDir = path.join(fakeHome, '.opencode');
      mkdirSync(dotDir, { recursive: true });
      writeFileSync(
        path.join(dotDir, 'opencode.json'),
        '{"permissions":[{"action":"shell","resource":"*","effect":"allow"}]}',
      );
      const refused = await engine.startRun(spec()).done;
      expect(refused).toMatchObject({ status: 'failed', error: { code: 'AGENT_CONFIG_UNSAFE' } });
      expect(refused.error?.message).toContain('permissions.0.action');
      expect(started[0]!.observed.sessions).toHaveLength(1);
      expect(started[0]!.observed.prompts).toHaveLength(1);
      expect(launches).toHaveLength(1);

      // A fresh host: no process is started at all.
      const fresh = setup(entry, { configOptions, turns: [agentTurn().text('三')] });
      const outcome = await fresh.engine.startRun(fresh.spec()).done;
      expect(outcome).toMatchObject({ status: 'failed', error: { code: 'AGENT_CONFIG_UNSAFE' } });
      expect(fresh.launches).toHaveLength(0);
    },
  );

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

  it('no OS sandbox, opencode option ids, `{server}_{tool}` MCP names, ACP steering on', () => {
    expect(opencodeProvider.features).toMatchObject({ osSandbox: false, steering: true });
    expect(opencodeProvider.execSandboxed?.({ kind: 'execute', title: 'ls' })).toBe(false);
    expect(opencodeProvider.permissionOptions).toEqual({
      allowOnce: ['once'],
      rejectOnce: ['reject'],
    });
    expect(opencodeProvider.toolName('kepcup_ab12cd34', 'send_message')).toBe(
      'kepcup_ab12cd34_send_message',
    );
    const bridge = { serverName: 'kepcup_ab12cd34', toolNames: new Set(['send_message']) };
    expect(
      hostBridgeToolOf(
        { name: 'kepcup_ab12cd34_send_message', kind: 'other' },
        opencodeProvider,
        bridge,
      ),
    ).toBe('send_message');
    expect(
      hostBridgeToolOf(
        { name: 'kepcup_ffffffff_send_message', kind: 'other' },
        opencodeProvider,
        bridge,
      ),
    ).toBeNull();
    expect(
      hostBridgeToolOf({ title: 'kepcup_ab12cd34: send_message' }, opencodeProvider, bridge),
    ).toBeNull();
    // Workdir config is off: AGENTS.md is injected by the host instead.
    expect(opencodeProvider.agentSideConfigFiles).toEqual([]);
  });

  it('accepts ACP 2.4.2 standard terminal login and the legacy _meta form', () => {
    const invocation = {
      command: '/x/opencode',
      prefixArgs: [],
      args: ['acp'],
      env: { OPENCODE_DISABLE_AUTOUPDATE: '1' },
    };
    const [standard] = describeAuthMethods([
      {
        id: 'opencode-login',
        name: 'Login with opencode',
        type: 'terminal',
        args: ['--login'],
        _meta: { 'terminal-auth': { command: 'opencode', args: ['auth', 'login'] } },
      },
    ]);
    expect(standard).toMatchObject({
      type: 'terminal',
      terminal: { mode: 'append', args: ['--login'] },
    });
    expect(terminalLoginCommand(invocation, standard!)).toEqual({
      command: invocation.command,
      args: ['acp', '--login'],
      env: invocation.env,
    });
    const [legacy] = describeAuthMethods([
      {
        id: 'opencode-login',
        name: 'Login with opencode',
        _meta: { 'terminal-auth': { command: 'opencode', args: ['auth', 'login'] } },
      },
    ]);
    expect(legacy).toMatchObject({
      type: 'terminal',
      terminal: { mode: 'replace', args: ['auth', 'login'] },
    });
    expect(terminalLoginCommand(invocation, legacy!).args).toEqual(['auth', 'login']);
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
          type: 'terminal',
          args: ['--login'],
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
      permissions: expect.arrayContaining([
        rule('external_directory', 'ask'),
        rule('shell', 'ask'),
      ]),
      policies: [{ action: 'plugin.use', resource: '*', effect: 'deny' }],
      automations: false,
    });
    expect(launches[0]!.env.OPENCODE_CONFIG_PROJECT_DISABLE).toBe('1');
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
      // dsh-acp 0.2.0-rc.2: one fresh harness Agent and in-flight state per session.
      parallelSessions: true,
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

  it('keeps gemini-api-key + oauth (2026-11 capability policy); gateway / agent-platform stay filtered', () => {
    // 2026-11-26 凭据策略：能力开放 + 风险提示（UI 对 oauth-personal 二次确认），
    // gateway（rollout）与未知方式仍过滤，agent-platform 等配置入口就绪再放开。
    // 过滤保持广告序。
    expect(filterAntigravityAuthMethods(advertised).map((method) => method.id)).toEqual([
      'oauth-personal',
      'oauth-business',
      'gemini-api-key',
    ]);
    expect(antigravityProvider.authMethods!(advertised).map((method) => method.id)).not.toContain(
      'gateway',
    );
    expect(antigravityProvider.authMethods!(advertised).map((method) => method.id)).not.toContain(
      'agent-platform',
    );
  });

  it('launch isolates GEMINI_HOME by default; reuseLocalAuth falls back to the default home', () => {
    const entry = fakeAgentEntry('fake-agy', { provider: 'antigravity' });
    const stateRoot = mkdtempSync(path.join(tmpdir(), 'kepcup-agy-launch-'));
    const target = { command: 'agy', args: [], env: {} };
    // 默认：私有 GEMINI_HOME（fail closed——stateDir 缺失抛错）。
    const isolated = antigravityProvider.launch({
      entry,
      target,
      platform: process.platform,
      stateDir: stateRoot,
    });
    expect(isolated.env.GEMINI_HOME).toBe(path.join(stateRoot, 'gemini-home'));
    expect(existsSync(path.join(stateRoot, 'gemini-home'))).toBe(true);
    expect(() => antigravityProvider.launch({ entry, target, platform: process.platform })).toThrow(
      /私有状态目录/,
    );
    // 复用本机登录：不设 GEMINI_HOME（Agent 回落默认 ~/.gemini），不建私有目录。
    const reused = antigravityProvider.launch({
      entry,
      target,
      platform: process.platform,
      stateDir: stateRoot,
      reuseLocalAuth: true,
    });
    expect(reused.env.GEMINI_HOME).toBeUndefined();
    expect(reused.command).toBe('agy');
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
