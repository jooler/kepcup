import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  agentApiKeySecretName,
  agentSettingSchema,
  agentsListOutputSchema,
  agentStatusPayloadSchema,
  APP_RPC_METHODS,
  rpcEventSchemas,
  rpcMethodSchemas,
} from '@kepcup/shared';
import {
  agentOptionsFrom,
  synthesizeAgentStatus,
  type AgentStatusInput,
} from '../../src/domain/agents.js';
import {
  describeAuthMethods,
  stripEntryArgs,
  terminalLoginCommand,
} from '../../src/agent/external/terminal-auth.js';

/**
 * AgentsService 的纯逻辑（D72 P4）：状态机合成、登录方式归一与 terminal
 * 登录命令改写（todo 附录 A.4 第 2 条）、config options 读取、RPC 契约与
 * 「不读取 Agent 凭据文件」守卫。服务的端到端流转见
 * integration/agents-service.test.ts。
 */

const base: AgentStatusInput = {
  kind: 'npx',
  enabled: true,
  installing: false,
  error: null,
  source: 'managed',
  installedVersion: '1.0.0',
  catalogVersion: '1.0.0',
  systemCompatible: null,
  systemDetail: null,
  auth: 'ok',
  anonymous: false,
};

describe('synthesizeAgentStatus', () => {
  it.each<[string, Partial<AgentStatusInput>, string]>([
    ['ready', {}, 'ready'],
    ['not enabled', { enabled: false }, 'available'],
    ['installing wins', { enabled: false, installing: true }, 'installing'],
    ['no distribution for this platform', { kind: 'none', enabled: false }, 'incompatible'],
    ['last install failed', { enabled: false, error: 'boom' }, 'error'],
    ['enabled but files gone', { installedVersion: null }, 'error'],
    ['logged out', { auth: 'required' }, 'needs_auth'],
    ['logged out but anonymous models work', { auth: 'required', anonymous: true }, 'ready'],
    ['unknown auth is optimistic', { auth: 'unknown' }, 'ready'],
    ['catalog bumped', { installedVersion: '0.9.0' }, 'update_available'],
    ['needs_auth before update', { installedVersion: '0.9.0', auth: 'required' }, 'needs_auth'],
    [
      'system CLI out of range',
      { source: 'system', installedVersion: null, systemCompatible: false, systemDetail: 'v1' },
      'incompatible',
    ],
    [
      'system CLI ok',
      { source: 'system', installedVersion: null, systemCompatible: true },
      'ready',
    ],
  ])('%s', (_label, patch, expected) => {
    expect(synthesizeAgentStatus({ ...base, ...patch }).status).toBe(expected);
  });
});

describe('login methods and terminal command rewrite', () => {
  const npxInvocation = {
    command: '/kepcup/toolchains/node/bin/node',
    prefixArgs: ['/kepcup/toolchains/agents/claude@0.86.0/node_modules/x/dist/index.js'],
    args: [],
    env: {},
  };

  it('Claude: ACP terminal methods append their args after the adapter invocation', () => {
    const [method] = describeAuthMethods([
      {
        id: 'claude-ai-login',
        name: 'Claude 订阅',
        type: 'terminal',
        args: ['--cli', 'auth', 'login', '--claudeai'],
        _meta: {
          'terminal-auth': {
            command: '/usr/bin/node',
            args: ['/somewhere/claude-agent-acp/dist/index.js', '--cli', 'auth', 'login'],
          },
        },
      },
    ]);
    expect(method).toMatchObject({ id: 'claude-ai-login', type: 'terminal' });
    expect(terminalLoginCommand(npxInvocation, method!)).toEqual({
      command: '/kepcup/toolchains/node/bin/node',
      args: [npxInvocation.prefixArgs[0], '--cli', 'auth', 'login', '--claudeai'],
      env: {},
    });
  });

  it('OpenCode: a bare `_meta.terminal-auth` command is rewritten to the installed binary', () => {
    const [method] = describeAuthMethods([
      {
        id: 'opencode-login',
        name: 'OpenCode',
        _meta: {
          'terminal-auth': { command: 'opencode', args: ['auth', 'login'], label: 'login' },
        },
      },
    ]);
    expect(method?.type).toBe('terminal');
    const binary = {
      command: '/kepcup/toolchains/agents/opencode@1.18.35/dist/opencode',
      prefixArgs: [],
      args: ['acp'],
      env: { OPENCODE_DISABLE_AUTOUPDATE: '1' },
    };
    expect(terminalLoginCommand(binary, method!)).toEqual({
      command: binary.command,
      args: ['auth', 'login'],
      env: { OPENCODE_DISABLE_AUTOUPDATE: '1' },
    });
  });

  it('a `_meta` command pointing at the agent’s own script keeps only the declared args', () => {
    expect(stripEntryArgs(['/usr/lib/agent/index.mjs', '--cli', 'login'])).toEqual([
      '--cli',
      'login',
    ]);
    expect(stripEntryArgs(['C:\\agent\\cli.js', 'login'])).toEqual(['login']);
    expect(stripEntryArgs(['auth', 'login'])).toEqual(['auth', 'login']);
    const [method] = describeAuthMethods([
      {
        id: 'x',
        name: 'x',
        _meta: { 'terminal-auth': { command: '/proc/self/exe', args: ['/a/b/index.js', 'auth'] } },
      },
    ]);
    expect(terminalLoginCommand(npxInvocation, method!).args).toEqual([
      npxInvocation.prefixArgs[0],
      'auth',
    ]);
  });

  it('drops agent-supplied env keys that could hijack the login command', () => {
    const [method] = describeAuthMethods([
      {
        id: 't',
        name: 't',
        type: 'terminal',
        args: ['login'],
        env: {
          PATH: '/tmp/evil',
          NODE_OPTIONS: '--require /tmp/x.js',
          LD_PRELOAD: '/tmp/x.so',
          DYLD_INSERT_LIBRARIES: '/tmp/x.dylib',
          VENDOR_LOGIN_MODE: 'browser',
        },
      },
    ]);
    expect(method?.terminal?.env).toEqual({ VENDOR_LOGIN_MODE: 'browser' });
  });

  it('Codex: methods without a terminal form are `agent` methods (ACP authenticate)', () => {
    const methods = describeAuthMethods([
      { id: 'chat-gpt', name: 'ChatGPT', description: '用 ChatGPT 登录' },
      { id: 'api-key', name: 'API key' },
    ]);
    expect(methods.map((method) => method.type)).toEqual(['agent', 'agent']);
    expect(() => terminalLoginCommand(npxInvocation, methods[0]!)).toThrow();
  });
});

describe('agentOptionsFrom', () => {
  it('reads model / thought_level selects (flat and grouped)', () => {
    const options = agentOptionsFrom(
      [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'a',
          options: [
            { group: 'g', name: 'G', options: [{ value: 'a', name: 'Model A' }] },
            {
              group: 'h',
              name: 'H',
              options: [{ value: 'b', name: 'Model B', description: 'fast' }],
            },
          ],
        },
        {
          id: 'effort',
          name: 'Effort',
          category: 'thought_level',
          type: 'select',
          currentValue: 'low',
          options: [
            { value: 'low', name: 'Low' },
            { value: 'high', name: 'High' },
          ],
        },
        { id: 'flag', name: 'Flag', type: 'boolean', currentValue: true },
      ],
      123,
    );
    expect(options).toEqual({
      models: [
        { value: 'a', name: 'Model A', description: '' },
        { value: 'b', name: 'Model B', description: 'fast' },
      ],
      efforts: [
        { value: 'low', name: 'Low', description: '' },
        { value: 'high', name: 'High', description: '' },
      ],
      fetchedAt: 123,
      error: null,
    });
    expect(agentOptionsFrom(null, 1).models).toEqual([]);
  });
});

describe('agents RPC contract', () => {
  it('registers every agents.* method and the agent.status event', () => {
    const names = [
      'agents.catalog',
      'agents.list',
      'agents.enable',
      'agents.disable',
      'agents.uninstall',
      'agents.login',
      'agents.logout',
      'agents.test',
      'agents.options',
      'agents.configure',
    ];
    for (const name of names) {
      expect(APP_RPC_METHODS).toContain(name);
      expect(rpcMethodSchemas[name as keyof typeof rpcMethodSchemas]).toBeDefined();
    }
    expect(rpcEventSchemas['agent.status']).toBe(agentStatusPayloadSchema);
    expect(agentsListOutputSchema.parse({ experimental: false, agents: [] })).toEqual({
      experimental: false,
      agents: [],
    });
    // Login input: key and terminal input are bounded; ids are catalog ids.
    const login = rpcMethodSchemas['agents.login'].input;
    expect(login.safeParse({ id: 'Bad Id' }).success).toBe(false);
    expect(login.safeParse({ id: 'codex', methodId: 'chat-gpt' }).success).toBe(true);
    expect(login.safeParse({ id: 'dsh', apiKey: '' }).success).toBe(false);
  });

  it('stores API keys under agent:{id}:api-key (secrets-safe names)', () => {
    expect(agentApiKeySecretName('dsh')).toBe('agent:dsh:api-key');
    // Unambiguous escaping: `a.b` and `a_b` never share a key.
    expect(agentApiKeySecretName('vendor.agent')).toBe('agent:vendor_dagent:api-key');
    expect(agentApiKeySecretName('vendor_dagent')).toBe('agent:vendor__dagent:api-key');
    expect(agentApiKeySecretName('a.b')).not.toBe(agentApiKeySecretName('a_b'));
  });

  it('settings.update only takes user toggles for agents (no installedVersion / source)', () => {
    const update = rpcMethodSchemas['settings.update'].input;
    expect(update.safeParse({ agents: { fake: { loadUserConfig: true } } }).success).toBe(true);
    expect(
      update.safeParse({ agents: { fake: { enabled: true, installedVersion: '../../../tmp/p' } } })
        .success,
    ).toBe(false);
    expect(update.safeParse({ agents: { fake: { source: 'system' } } }).success).toBe(false);
    // Stored values: a path-like installedVersion is dropped.
    expect(
      agentSettingSchema.parse({ enabled: true, installedVersion: '../../x' }).installedVersion,
    ).toBeUndefined();
    expect(agentSettingSchema.parse({ installedVersion: '0.86.0' }).installedVersion).toBe(
      '0.86.0',
    );
  });
});

/**
 * 「KepCup 不接触、不存储、不中转任何订阅凭据」（设计 28 §9.1）：Agent 相关
 * 源码里不得出现读取 Agent 凭据文件的代码。P4 的安装 / 登录 / 状态模块连
 * 这些路径名都不得出现；其余外部 Agent 模块（Provider 可能在沙箱拒读规则
 * 里提到它们）不得在同一行对它们做读取调用。
 */
describe('credential path guard', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const coreSrc = path.resolve(here, '..', '..', 'src');
  const desktopLib = path.resolve(
    here,
    '..',
    '..',
    '..',
    '..',
    'apps',
    'desktop',
    'src',
    'renderer',
    'src',
    'lib',
  );
  const CREDENTIAL_PATH =
    /\.credentials\.json|\bcredentials\.json|\bauth\.json\b|oauth_creds|\.codex[/\\]|\.claude[/\\]\.credentials|\.zcode[/\\]v2|\.config[/\\]opencode[/\\]auth|cursor[/\\]auth|\.gemini[/\\]oauth/i;
  const READ_CALL = /\b(readFile|readFileSync|createReadStream|openSync|readJson|fs\.open)\b/;

  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      return statSync(full).isDirectory() ? walk(full) : /\.(ts|svelte)$/.test(name) ? [full] : [];
    });
  }

  it('P4 modules never mention agent credential files', () => {
    const strict = [
      path.join(coreSrc, 'domain', 'agents.ts'),
      path.join(coreSrc, 'agent', 'external', 'installer.ts'),
      path.join(coreSrc, 'agent', 'external', 'terminal-auth.ts'),
      path.join(coreSrc, 'agent', 'external', 'acp', 'control-session.ts'),
      path.join(coreSrc, 'rpc', 'agents-bindings.ts'),
      path.join(desktopLib, 'features', 'settings', 'AgentsSection.svelte'),
      path.join(desktopLib, 'stores', 'agents.svelte.ts'),
    ];
    for (const file of strict) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(CREDENTIAL_PATH);
    }
  });

  it('no external-agent module reads a credential file', () => {
    const files = [
      ...walk(path.join(coreSrc, 'agent', 'external')),
      path.join(coreSrc, 'domain', 'agents.ts'),
    ];
    const offenders: string[] = [];
    for (const file of files) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          if (CREDENTIAL_PATH.test(line) && READ_CALL.test(line))
            offenders.push(`${file}:${index + 1}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});
