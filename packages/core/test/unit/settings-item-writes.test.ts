import { describe, expect, it } from 'vitest';
import { getSettingItem, settingsSchema, type Bot, type Settings } from '@kepcup/shared';
import { botProfile } from '@kepcup/testkit';
import { buildItemAdapters, type AdapterDeps } from '../../src/settings/adapters.js';

/**
 * P1 写入适配器：条目级合并（不覆盖兄弟字段）、放宽判定、技能启停走原服务。
 */

function item(id: string) {
  const found = getSettingItem(id);
  if (found === null) throw new Error(id);
  return found;
}

function harness(
  patch: Partial<Settings> = {},
  runtime: Partial<Bot['profile']['runtime']> = {},
  environment?: AdapterDeps['environment'],
  sandbox?: AdapterDeps['sandbox'],
) {
  let settings = settingsSchema.parse({
    providerConcurrency: { default: 4, openai: 2 },
    embedding: { source: '', dim: 8 },
    browserProfiles: [{ id: 'shared-1', name: 'Work', createdAt: 1 }],
    mcpServers: [{ id: 'srv', name: 'Srv', transport: 'stdio', command: 'echo', enabled: true }],
    ...patch,
  });
  const profile = botProfile({
    name: 'bot_a',
    runtime: {
      model: 'custom:mock/mock-main',
      light_model: '',
      network_policy: 'none',
      network_allowlist: ['example.com'],
      mcp_server_ids: ['srv'],
      app_connection_ids: ['conn-1'],
      browser_profile: '',
      ...runtime,
    },
  });
  const bot: Bot = {
    id: 'bot_a',
    name: 'bot_a',
    bio: '',
    status: 'active',
    systemRole: null,
    setupState: 'done',
    profile,
  } as Bot;
  const skills = {
    rows: [{ name: 'note', status: 'disabled' }],
    enabled: [] as string[],
    disabled: [] as string[],
  };
  const configured: string[] = [];
  const deps: AdapterDeps = {
    settings: {
      get: () => settings,
      update: (next) => {
        settings = settingsSchema.parse({ ...settings, ...next });
        return settings;
      },
    },
    secrets: { hasValue: () => false, setValue: () => undefined },
    providers: { list: () => [], setKey: () => undefined },
    bots: {
      get: (id) => (id === bot.id ? bot : null),
      update: (id, next) => {
        if (id !== bot.id) throw new Error('missing bot');
        bot.profile = next;
        return bot;
      },
    },
    agentCatalog: () => [{ id: 'codex', name: 'Codex' }] as never,
    embedding: {
      configure: (input) => {
        configured.push(input.source);
        const current = settings.embedding;
        settings = settingsSchema.parse({
          ...settings,
          embedding: { ...current, source: input.source, dim: null },
        });
      },
    },
    skills: {
      list: () => skills.rows,
      enable: (_botId, name) => {
        skills.enabled.push(name);
        skills.rows = skills.rows.map((row) =>
          row.name === name ? { ...row, status: 'active' } : row,
        );
      },
      disable: (_botId, name) => {
        skills.disabled.push(name);
      },
    },
    ...(environment !== undefined ? { environment } : {}),
    ...(sandbox !== undefined ? { sandbox } : {}),
    publish: () => undefined,
  };
  const adapters = buildItemAdapters(deps);
  const target = { botId: 'bot_a', conversationId: null, projectId: null };
  return {
    adapters,
    target,
    bot,
    skills,
    configured,
    settings: () => settings,
  };
}

describe('P1 setting item writes', () => {
  it('concurrency write keeps per-provider limits', () => {
    const rig = harness();
    const adapter = rig.adapters(item('models.concurrency'));
    adapter.write!(item('models.concurrency'), { next: { provider: 'default', limit: 6 }, secrets: {} }, rig.target);
    expect(rig.settings().providerConcurrency).toEqual({ default: 6, openai: 2 });
  });

  it('embedding configure resets dim and does not touch other settings', () => {
    const rig = harness();
    const adapter = rig.adapters(item('models.embedding-local'));
    adapter.write!(item('models.embedding-local'), { next: { source: 'local' }, secrets: {} }, rig.target);
    expect(rig.configured).toEqual(['local']);
    expect(rig.settings().embedding).toMatchObject({ source: 'local', dim: null });
    expect(rig.settings().providerConcurrency.default).toBe(4);
  });

  it('network tighten keeps the bot model; opening the network counts as widening', () => {
    const rig = harness();
    const adapter = rig.adapters(item('bot.network'));
    expect(
      adapter.valuesWiden!(item('bot.network'), { policy: 'none', allowlist: [] }, { policy: 'open' }),
    ).toBe(true);
    expect(
      adapter.valuesWiden!(
        item('bot.network'),
        { policy: 'allowlist', allowlist: ['example.com'] },
        { policy: 'allowlist', allowlist: ['example.com', 'other.test'] },
      ),
    ).toBe(true);
    expect(
      adapter.valuesWiden!(item('bot.network'), { policy: 'open' }, { policy: 'none' }),
    ).toBe(false);
    adapter.write!(
      item('bot.network'),
      { next: { policy: 'allowlist', allowlist: ['example.com'] }, secrets: {} },
      rig.target,
    );
    expect(rig.bot.profile.runtime.network_policy).toBe('allowlist');
    expect(rig.bot.profile.runtime.model).toBe('custom:mock/mock-main');
    expect(rig.bot.profile.runtime.mcp_server_ids).toEqual(['srv']);
  });

  it('mcp and browser writes only touch their own runtime fields', () => {
    const rig = harness();
    rig.adapters(item('bot.mcp-servers')).write!(
      item('bot.mcp-servers'),
      { next: { servers: [] }, secrets: {} },
      rig.target,
    );
    expect(rig.bot.profile.runtime.mcp_server_ids).toEqual([]);
    expect(rig.bot.profile.runtime.app_connection_ids).toEqual(['conn-1']);
    rig.adapters(item('bot.browser-profile')).write!(
      item('bot.browser-profile'),
      { next: { profile: 'shared-1' }, secrets: {} },
      rig.target,
    );
    expect(rig.bot.profile.runtime.browser_profile).toBe('shared-1');
    expect(rig.bot.profile.runtime.model).toBe('custom:mock/mock-main');
  });

  it('switching a bot onto an external agent is widening; dropping to read-only is not', () => {
    const rig = harness();
    const adapter = rig.adapters(item('bot.agent'));
    expect(adapter.valuesWiden!(item('bot.agent'), { agent: '', permission: 'workspace' }, { agent: 'codex' })).toBe(
      true,
    );
    expect(
      adapter.valuesWiden!(
        item('bot.agent'),
        { agent: 'codex', permission: 'workspace' },
        { permission: 'read_only' },
      ),
    ).toBe(false);
    adapter.write!(
      item('bot.agent'),
      { next: { agent: 'codex', model: 'gpt', permission: 'ask' }, secrets: {} },
      rig.target,
    );
    expect(rig.bot.profile.runtime.agent).toMatchObject({
      id: 'codex',
      model: 'gpt',
      permission: 'ask',
    });
    expect(rig.bot.profile.runtime.network_policy).toBe('none');
  });

  it('skill enable and disable call the skills service for one name', () => {
    const rig = harness();
    const adapter = rig.adapters(item('bot.skills'));
    const before = adapter.read(item('bot.skills'), rig.target, { skill: 'note' });
    expect(before.values).toEqual({ skill: 'note', enabled: false });
    adapter.write!(item('bot.skills'), { next: { skill: 'note', enabled: true }, secrets: {} }, rig.target);
    expect(rig.skills.enabled).toEqual(['note']);
    adapter.write!(item('bot.skills'), { next: { skill: 'note', enabled: false }, secrets: {} }, rig.target);
    expect(rig.skills.disabled).toEqual(['note']);
  });
});

describe('group and project setting reads', () => {
  function rig() {
    let title = '旧群名';
    const renamed: string[] = [];
    const members = ['bot_a', 'bot_b'];
    const settingsUpdates: string[] = [];
    const bot = {
      id: 'bot_a',
      name: '甲',
      profile: botProfile({ name: '甲' }),
    } as Bot;
    const deps: AdapterDeps = {
      settings: {
        get: () => settingsSchema.parse({}),
        update: (next) => {
          settingsUpdates.push(Object.keys(next).join(','));
          return settingsSchema.parse(next);
        },
      },
      secrets: { hasValue: () => false, setValue: () => undefined },
      providers: { list: () => [], setKey: () => undefined },
      bots: {
        get: (id) => (id === bot.id ? bot : null),
        update: () => bot,
        listActive: () => [bot],
      },
      conversations: {
        get: () => ({ title, type: 'group' }),
        memberBotIds: () => members,
      },
      groups: {
        rename: (_id, next) => {
          renamed.push(next);
          title = next;
        },
      },
      projects: {
        get: () => ({
          protectRules: { denyRead: ['.env*'], denyWrite: ['secrets/**'] },
          allowedPorts: [[3000, 3010]],
        }),
      },
      publish: () => undefined,
    };
    const adapters = buildItemAdapters(deps);
    const target = { botId: null, conversationId: 'conv_group', projectId: 'proj_1' };
    return { adapters, target, renamed, members, settingsUpdates, title: () => title };
  }

  it('renaming a group only changes the title', () => {
    const rigged = rig();
    const adapter = rigged.adapters(item('group.title'));
    expect(adapter.read(item('group.title'), rigged.target).values).toEqual({ title: '旧群名' });
    adapter.write!(
      item('group.title'),
      { next: { title: '  新群名  ' }, secrets: {} },
      rigged.target,
    );
    expect(rigged.renamed).toEqual(['新群名']);
    expect(rigged.title()).toBe('新群名');
    expect(rigged.members).toEqual(['bot_a', 'bot_b']);
    expect(rigged.settingsUpdates).toEqual([]);
    expect(() =>
      adapter.write!(item('group.title'), { next: { title: '   ' }, secrets: {} }, rigged.target),
    ).toThrow(/群名不能为空/);
  });

  it('member and project reads do not expose a host write', () => {
    const rigged = rig();
    const members = rigged.adapters(item('group.members'));
    expect(members.write).toBeUndefined();
    expect(members.read(item('group.members'), rigged.target).values).toEqual({
      bots: ['bot_a', 'bot_b'],
    });
    const rules = rigged.adapters(item('project.protect-rules'));
    const ports = rigged.adapters(item('project.ports'));
    expect(rules.write).toBeUndefined();
    expect(ports.write).toBeUndefined();
    expect(rules.read(item('project.protect-rules'), rigged.target).values).toEqual({
      denyRead: ['.env*'],
      denyWrite: ['secrets/**'],
    });
    expect(ports.read(item('project.ports'), rigged.target).values).toEqual({
      ports: ['3000-3010'],
    });
  });
});

describe('connection tool policy reads', () => {
  const target = { botId: null, conversationId: null, projectId: null };

  function rig(peek: AdapterDeps['appConnections']) {
    const deps: AdapterDeps = {
      settings: {
        get: () => settingsSchema.parse({}),
        update: (next) => settingsSchema.parse(next),
      },
      secrets: { hasValue: () => false, setValue: () => undefined },
      providers: { list: () => [], setKey: () => undefined },
      bots: { get: () => null, update: () => { throw new Error('no bot'); } },
      ...(peek !== undefined ? { appConnections: peek } : {}),
      publish: () => undefined,
    };
    return buildItemAdapters(deps)(item('connections.tool-policy'));
  }

  const notion = {
    list: () => [{ id: 'conn-1', label: 'Notion 工作区' }],
    peekTool: (connectionId: string, toolName: string) =>
      connectionId === 'conn-1' && toolName === 'search'
        ? { policy: { approval: 'auto' as const }, enabled: true, approval: 'auto' as const }
        : connectionId === 'conn-1' && toolName === 'archive'
          ? { policy: { enabled: false }, enabled: false, approval: 'ask' as const }
          : null,
  };

  it('puts the focused connection and tool in the snapshot and does not write', () => {
    const adapter = rig(notion);
    expect(adapter.write).toBeUndefined();
    expect(
      adapter.read(item('connections.tool-policy'), target, {
        connection: 'conn-1',
        tool: 'search',
        policy: 'deny',
      }).values,
    ).toEqual({ connection: 'conn-1', tool: 'search', policy: 'allow' });
    expect(
      adapter.read(item('connections.tool-policy'), target, {
        connection: 'conn-1',
        tool: 'archive',
      }).values,
    ).toEqual({ connection: 'conn-1', tool: 'archive', policy: 'deny' });
    const missing = adapter.read(item('connections.tool-policy'), target, {
      connection: 'conn-1',
      tool: 'gone',
    });
    expect(missing.status).toBe('unconfigured');
    expect(missing.values).toEqual({ connection: 'conn-1', tool: 'gone' });
    expect(adapter.options!(item('connections.tool-policy').fields[0]!, item('connections.tool-policy'), target)).toEqual([
      { value: 'conn-1', label: 'Notion 工作区' },
    ]);
  });

  it('keeps the ids when the connection service is not wired', () => {
    const adapter = rig(undefined);
    const snapshot = adapter.read(item('connections.tool-policy'), target, {
      connection: 'conn-1',
      tool: 'search',
    });
    expect(snapshot.status).toBe('unknown');
    expect(snapshot.values).toEqual({ connection: 'conn-1', tool: 'search' });
  });

  it('treats allow and re-enable as widening; tightening and unknown stay distinct', () => {
    const adapter = rig(notion);
    const widen = adapter.valuesWiden!;
    const entry = item('connections.tool-policy');
    expect(widen(entry, { policy: 'ask' }, { policy: 'allow' })).toBe(true);
    expect(widen(entry, { policy: 'deny' }, { policy: 'ask' })).toBe(true);
    expect(widen(entry, { policy: 'deny' }, { policy: 'allow' })).toBe(true);
    expect(widen(entry, { policy: 'allow' }, { policy: 'deny' })).toBe(false);
    expect(widen(entry, { policy: 'allow' }, { policy: 'ask' })).toBe(false);
    expect(widen(entry, { policy: 'ask' }, { policy: 'deny' })).toBe(false);
    expect(widen(entry, { policy: 'allow' }, { policy: 'allow' })).toBe(false);
    expect(widen(entry, null, { policy: 'deny' })).toBe(true);
    expect(widen(entry, { policy: 'ask' }, { connection: 'conn-1' })).toBe(true);
    expect(widen(entry, { connection: 'conn-1', tool: 'search' }, { policy: 'deny' })).toBe(true);
  });
});

describe('installed MCP server reads', () => {
  const target = { botId: null, conversationId: null, projectId: null };

  function rig() {
    const { adapters, settings } = harness({
      mcpServers: [
        {
          id: 'notes',
          name: 'Notes',
          transport: 'stdio',
          command: 'echo',
          enabled: true,
          toolPolicies: { search: { approval: 'ask' } },
        },
        {
          id: 'off',
          name: 'Off',
          transport: 'stdio',
          command: 'echo',
          enabled: false,
        },
      ],
    });
    return { adapter: adapters(item('mcp.servers')), settings };
  }

  it('reads the focused server into the snapshot and does not write', () => {
    const { adapter, settings } = rig();
    expect(adapter.write).toBeUndefined();
    const overview = adapter.read(item('mcp.servers'), target);
    expect(overview.values).toBeNull();
    expect(overview.summary).toBe('已安装 2 个，启用 1 个');
    expect(
      adapter.read(item('mcp.servers'), target, { server: 'notes', enabled: false }).values,
    ).toEqual({ server: 'notes', enabled: true });
    const disabled = adapter.read(item('mcp.servers'), target, { server: 'off', enabled: true });
    expect(disabled.status).toBe('unconfigured');
    expect(disabled.values).toEqual({ server: 'off', enabled: false });
    const missing = adapter.read(item('mcp.servers'), target, { server: 'gone' });
    expect(missing.status).toBe('unconfigured');
    expect(missing.values).toEqual({ server: 'gone' });
    expect(adapter.options!(item('mcp.servers').fields[0]!, item('mcp.servers'), target)).toEqual([
      { value: 'notes', label: 'Notes' },
      { value: 'off', label: 'Off' },
    ]);
    expect(settings().mcpServers.find((server) => server.id === 'notes')?.toolPolicies).toEqual({
      search: { approval: 'ask' },
    });
  });

  it('treats enable as widening and disable as not; unknown direction widens', () => {
    const { adapter } = rig();
    const widen = adapter.valuesWiden!;
    const entry = item('mcp.servers');
    expect(widen(entry, { server: 'off', enabled: false }, { enabled: true })).toBe(true);
    expect(widen(entry, { server: 'notes', enabled: true }, { enabled: false })).toBe(false);
    expect(widen(entry, { enabled: true }, { enabled: true })).toBe(false);
    expect(widen(entry, { enabled: false }, { enabled: false })).toBe(false);
    expect(widen(entry, null, { enabled: false })).toBe(true);
    expect(widen(entry, { enabled: true }, { server: 'notes' })).toBe(true);
    expect(widen(entry, { server: 'notes' }, { enabled: false })).toBe(true);
    expect(widen(entry, { enabled: true }, { enabled: 'no' })).toBe(true);
  });
});

describe('browser shared profiles', () => {
  const target = { botId: null, conversationId: null, projectId: null };

  it('reads a name-only snapshot and does not write', () => {
    const { adapters, settings } = harness();
    const adapter = adapters(item('browser.shared-profiles'));
    expect(adapter.write).toBeUndefined();
    expect(adapter.valuesWiden).toBeUndefined();

    const overview = adapter.read(item('browser.shared-profiles'), target);
    expect(overview.status).toBe('configured');
    expect(overview.values).toBeNull();
    expect(overview.summary).toBe('有 1 份共享资料');
    expect(JSON.stringify(overview)).not.toContain('shared-1');

    const existing = adapter.read(item('browser.shared-profiles'), target, { name: 'Work' });
    expect(existing.status).toBe('configured');
    expect(existing.values).toEqual({ name: 'Work' });
    expect(JSON.stringify(existing)).not.toContain('shared-1');

    const padded = adapter.read(item('browser.shared-profiles'), target, { name: '  Work  ' });
    expect(padded.status).toBe('configured');
    expect(padded.values).toEqual({ name: 'Work' });

    const missing = adapter.read(item('browser.shared-profiles'), target, { name: 'Home' });
    expect(missing.status).toBe('unconfigured');
    expect(missing.values).toEqual({ name: '' });
    expect(JSON.stringify(missing)).not.toContain('shared-1');

    const blank = adapter.read(item('browser.shared-profiles'), target, { name: '   ' });
    expect(blank.values).toBeNull();
    expect(blank.summary).toBe('有 1 份共享资料');

    expect(settings().browserProfiles).toEqual([{ id: 'shared-1', name: 'Work', createdAt: 1 }]);
  });

  it('summarizes when there are no shared profiles', () => {
    const { adapters } = harness({ browserProfiles: [] });
    const overview = adapters(item('browser.shared-profiles')).read(
      item('browser.shared-profiles'),
      target,
    );
    expect(overview.status).toBe('unconfigured');
    expect(overview.values).toBeNull();
    expect(overview.summary).toBe('还没有共享浏览器资料');
  });

  it('counts every shared profile and still omits ids', () => {
    const { adapters } = harness({
      browserProfiles: [
        { id: 'bpf_a', name: '工作', createdAt: 1 },
        { id: 'bpf_b', name: '私人', createdAt: 2 },
      ],
    });
    const overview = adapters(item('browser.shared-profiles')).read(
      item('browser.shared-profiles'),
      target,
    );
    expect(overview.summary).toBe('有 2 份共享资料');
    expect(overview.values).toBeNull();
    expect(JSON.stringify(overview)).not.toContain('bpf_');
  });
});

describe('environment toolchains read adapter', () => {
  const target = { botId: null, conversationId: null, projectId: null };
  const rows = [
    { id: 'env_row_installed', status: 'installed' },
    { id: 'env_row_failed', status: 'failed' },
    { id: 'env_row_installing', status: 'installing' },
    { id: 'env_row_removed', status: 'removed' },
  ];
  const system = [
    { item: 'git', available: true },
    { item: 'missing-git', available: false },
  ];

  it('counts installed and failed-or-missing, keeps values null, and omits install ids', () => {
    const { adapters } = harness({}, {}, {
      listInstalls: () => rows,
      systemStatuses: () => system,
    });
    const adapter = adapters(item('environment.toolchains'));
    const snapshot = adapter.read(item('environment.toolchains'), target);
    expect(adapter.write).toBeUndefined();
    expect(snapshot.values).toBeNull();
    expect(snapshot.status).toBe('partial');
    expect(snapshot.summary).toBe('已安装 2 项，失败或缺失 2 项');
    const encoded = JSON.stringify(snapshot);
    expect(encoded).not.toContain('env_row_');
    expect(encoded).not.toContain('missing-git');
  });

  it('is configured only when nothing failed or is missing', () => {
    const healthy = harness({}, {}, {
      listInstalls: () => [{ id: 'env_row_ok', status: 'installed' }],
      systemStatuses: () => [{ available: true }],
    });
    expect(healthy.adapters(item('environment.toolchains')).read(item('environment.toolchains'), target)).toMatchObject({
      status: 'configured',
      values: null,
      summary: '已安装 2 项，失败或缺失 0 项',
    });
    const empty = harness({}, {}, { listInstalls: () => [], systemStatuses: () => [] });
    expect(empty.adapters(item('environment.toolchains')).read(item('environment.toolchains'), target)).toMatchObject({
      status: 'configured',
      values: null,
      summary: '已安装 0 项，失败或缺失 0 项',
    });
    const broken = harness({}, {}, {
      listInstalls: () => [{ id: 'env_row_bad', status: 'failed' }],
      systemStatuses: () => [{ available: false }],
    });
    expect(broken.adapters(item('environment.toolchains')).read(item('environment.toolchains'), target)).toMatchObject({
      status: 'unconfigured',
      values: null,
      summary: '已安装 0 项，失败或缺失 2 项',
    });
  });

  it('stays unconfigured when the environment service is not wired', () => {
    const { adapters } = harness();
    expect(adapters(item('environment.toolchains')).read(item('environment.toolchains'), target)).toEqual({
      status: 'unconfigured',
      values: null,
      secrets: {},
      summary: '还看不到工具链状态',
    });
  });
});

describe('environment sandbox read adapter', () => {
  const target = { botId: null, conversationId: null, projectId: null };
  const leaked = {
    available: false,
    fixHint: 'sudo apt install bubblewrap socat',
    reason: '/Users/someone/.local/share/kepcup',
  };

  function read(sandbox?: AdapterDeps['sandbox']) {
    const { adapters } = harness({}, {}, undefined, sandbox);
    const adapter = adapters(item('environment.sandbox'));
    return { adapter, snapshot: adapter.read(item('environment.sandbox'), target) };
  }

  it('has not been probed yet', () => {
    const { adapter, snapshot } = read({ lastAvailability: () => null });
    expect(adapter.write).toBeUndefined();
    expect(snapshot).toEqual({
      status: 'unknown',
      values: null,
      secrets: {},
      summary: '还没检测过沙箱',
    });
  });

  it('is unknown when the sandbox dependency is not wired', () => {
    const { snapshot } = read();
    expect(snapshot).toEqual({
      status: 'unknown',
      values: null,
      secrets: {},
      summary: '还没检测过沙箱',
    });
  });

  it('is configured only when the last probe says available, and omits hints and paths', () => {
    expect(read({ lastAvailability: () => ({ available: true }) }).snapshot).toEqual({
      status: 'configured',
      values: null,
      secrets: {},
      summary: '沙箱可用',
    });
    const unavailable = read({ lastAvailability: () => leaked }).snapshot;
    expect(unavailable).toEqual({
      status: 'unconfigured',
      values: null,
      secrets: {},
      summary: '沙箱不可用',
    });
    const encoded = JSON.stringify(unavailable);
    expect(encoded).not.toContain('sudo');
    expect(encoded).not.toContain('bubblewrap');
    expect(encoded).not.toContain('fixHint');
    expect(encoded).not.toContain('/Users/');
  });
});
