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
  allowlist?: AdapterDeps['allowlist'],
  appConnections?: AdapterDeps['appConnections'],
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
    },
    botProfiles: {
      apply: (id, next) => {
        if (id !== bot.id) throw new Error('missing bot');
        bot.profile = next;
        return { bot, changedItemIds: [], settle: async () => undefined };
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
    ...(allowlist !== undefined ? { allowlist } : {}),
    ...(appConnections !== undefined ? { appConnections } : {}),
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
    adapter.write!(
      item('models.concurrency'),
      { next: { provider: 'default', limit: 6 }, secrets: {} },
      rig.target,
    );
    expect(rig.settings().providerConcurrency).toEqual({ default: 6, openai: 2 });
  });

  it('embedding configure resets dim and does not touch other settings', () => {
    const rig = harness();
    const adapter = rig.adapters(item('models.embedding-local'));
    adapter.write!(
      item('models.embedding-local'),
      { next: { source: 'local' }, secrets: {} },
      rig.target,
    );
    expect(rig.configured).toEqual(['local']);
    expect(rig.settings().embedding).toMatchObject({ source: 'local', dim: null });
    expect(rig.settings().providerConcurrency.default).toBe(4);
  });

  it('network tighten keeps the bot model; opening the network counts as widening', () => {
    const rig = harness();
    const adapter = rig.adapters(item('bot.network'));
    expect(
      adapter.valuesWiden!(
        item('bot.network'),
        { policy: 'none', allowlist: [] },
        { policy: 'open' },
      ),
    ).toBe(true);
    expect(
      adapter.valuesWiden!(
        item('bot.network'),
        { policy: 'allowlist', allowlist: ['example.com'] },
        { policy: 'allowlist', allowlist: ['example.com', 'other.test'] },
      ),
    ).toBe(true);
    expect(adapter.valuesWiden!(item('bot.network'), { policy: 'open' }, { policy: 'none' })).toBe(
      false,
    );
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

  it('bot.apps accepts a connector slug and keeps grants the bot already has', () => {
    const rows = [
      { id: 'conn-1', connectorId: 'notion', label: 'Notion' },
      { id: 'conn_cf', connectorId: 'cloudflare', label: 'Cloudflare' },
    ];
    const rig = harness({}, {}, undefined, undefined, undefined, {
      list: () => rows,
      peekTool: () => null,
    });
    const adapter = rig.adapters(item('bot.apps'));
    expect(adapter.options!(item('bot.apps').fields[0]!, item('bot.apps'), rig.target)).toEqual([
      { value: 'conn-1', label: 'Notion' },
      { value: 'conn_cf', label: 'Cloudflare' },
    ]);
    adapter.write!(
      item('bot.apps'),
      { next: { connections: ['cloudflare'] }, secrets: {} },
      rig.target,
    );
    expect(rig.bot.profile.runtime.app_connection_ids).toEqual(['conn-1', 'conn_cf']);
    adapter.write!(
      item('bot.apps'),
      { next: { connections: ['conn_cf'] }, secrets: {} },
      rig.target,
    );
    expect(rig.bot.profile.runtime.app_connection_ids).toEqual(['conn_cf']);
    expect(() =>
      adapter.write!(
        item('bot.apps'),
        { next: { connections: ['missing'] }, secrets: {} },
        rig.target,
      ),
    ).toThrow(/连接 missing 不存在或已删除/);
  });

  it('switching a bot onto an external agent is widening; dropping to read-only is not', () => {
    const rig = harness();
    const adapter = rig.adapters(item('bot.agent'));
    expect(
      adapter.valuesWiden!(
        item('bot.agent'),
        { agent: '', permission: 'workspace' },
        { agent: 'codex' },
      ),
    ).toBe(true);
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
    expect(before.values).toEqual({ skill: 'note', enabled: false, scope: 'private' });
    adapter.write!(
      item('bot.skills'),
      { next: { skill: 'note', enabled: true }, secrets: {} },
      rig.target,
    );
    expect(rig.skills.enabled).toEqual(['note']);
    adapter.write!(
      item('bot.skills'),
      { next: { skill: 'note', enabled: false }, secrets: {} },
      rig.target,
    );
    expect(rig.skills.disabled).toEqual(['note']);
  });

  it('a public skill is not toggled through the per-bot item (it would flip it for every bot)', () => {
    const rig = harness();
    rig.skills.rows = [
      { name: 'note', status: 'disabled' },
      { name: 'shared-pdf', status: 'active', scope: 'public' } as never,
    ];
    const entry = item('bot.skills');
    const adapter = rig.adapters(entry);
    const snapshot = adapter.read(entry, rig.target, { skill: 'shared-pdf' });
    expect(snapshot.values).toEqual({ skill: 'shared-pdf', enabled: true, scope: 'public' });
    expect(snapshot.summary).toContain('公共技能');
    const overview = adapter.read(entry, rig.target);
    expect(overview.summary).toContain('另有 1 个公共技能');
    const normalized = adapter.normalize!(
      entry,
      { skill: 'shared-pdf', enabled: false },
      rig.target,
    );
    expect(normalized).toMatchObject({ ok: false });
    expect(normalized.ok ? '' : normalized.message).toContain('技能页');
    expect(() =>
      adapter.write!(
        entry,
        { next: { skill: 'shared-pdf', enabled: false }, secrets: {} },
        rig.target,
      ),
    ).toThrow(/公共技能/);
    expect(rig.skills.disabled).toEqual([]);
    expect(
      adapter.options!(entry.fields[0]!, entry, rig.target).find(
        (option) => option.value === 'shared-pdf',
      )?.label,
    ).toContain('只能在技能页管理');
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
        listActive: () => [bot],
      },
      botProfiles: {
        apply: () => ({ bot, changedItemIds: [], settle: async () => undefined }),
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

  it('a bot proposal can only add members: the proposal keeps every existing member', () => {
    const rigged = rig();
    const entry = item('group.members');
    const members = rigged.adapters(entry);
    const snapshot = members.read(entry, rigged.target);
    expect(members.proposal!(entry, { bots: ['bot_new'] }, snapshot)).toEqual({
      bots: ['bot_a', 'bot_b', 'bot_new'],
    });
    // 想借预填「移出」bot_b 也做不到：建议值永远是现有成员的超集。
    expect(members.proposal!(entry, { bots: ['bot_a'] }, snapshot)).toEqual({
      bots: ['bot_a', 'bot_b'],
    });
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

describe('project protect-rule redaction', () => {
  function rules(denyRead: string[], denyWrite: string[]) {
    const deps: AdapterDeps = {
      settings: {
        get: () => settingsSchema.parse({}),
        update: (next) => settingsSchema.parse(next),
      },
      secrets: { hasValue: () => false, setValue: () => undefined },
      providers: { list: () => [], setKey: () => undefined },
      bots: { get: () => null },
      botProfiles: {
        apply: () => {
          throw new Error('no bot');
        },
      },
      projects: {
        get: () => ({
          path: '/home/alice/work/site',
          protectRules: { denyRead, denyWrite },
          allowedPorts: null,
        }),
      },
      homeDir: '/home/alice',
      publish: () => undefined,
    };
    const entry = item('project.protect-rules');
    return buildItemAdapters(deps)(entry).read(entry, {
      botId: null,
      conversationId: null,
      projectId: 'proj_1',
    });
  }

  it('replaces project, home and other absolute prefixes; keeps relative globs; caps length and count', () => {
    const snapshot = rules(
      [
        '/home/alice/work/site/config/prod.env',
        '/home/alice/.ssh/id_ed25519',
        '/etc/shadow',
        'C:\\Users\\alice\\secrets\\token.txt',
        '*.pem',
        `.git/${'x'.repeat(200)}`,
      ],
      Array.from({ length: 30 }, (_, index) => `secrets/${index}/**`),
    );
    expect(snapshot.values?.denyRead).toEqual([
      '<project>/config/prod.env',
      '~/.ssh/id_ed25519',
      '…/shadow',
      '…/token.txt',
      '*.pem',
      expect.stringMatching(/^\.git\/x+/),
    ]);
    expect(String((snapshot.values?.denyRead as string[])[5]).length).toBeLessThanOrEqual(61);
    expect((snapshot.values?.denyWrite as string[]).length).toBe(20);
    expect(snapshot.summary).toBe('禁止读取 6 条，禁止写入 30 条');
    const encoded = JSON.stringify(snapshot);
    expect(encoded).not.toContain('/home/alice');
    expect(encoded).not.toContain('Users');
    expect(encoded).not.toContain('/etc/');
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
      bots: { get: () => null },
      botProfiles: {
        apply: () => {
          throw new Error('no bot');
        },
      },
      ...(peek !== undefined ? { appConnections: peek } : {}),
      publish: () => undefined,
    };
    return buildItemAdapters(deps)(item('connections.tool-policy'));
  }

  const notion = {
    list: () => [{ id: 'conn-1', connectorId: 'notion', label: 'Notion 工作区' }],
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
    const cloudflare = rig({
      list: () => [
        { id: 'conn-1', connectorId: 'notion', label: 'Notion 工作区' },
        { id: 'conn_cf', connectorId: 'cloudflare', label: 'Cloudflare' },
      ],
      peekTool: (connectionId, toolName) =>
        connectionId === 'conn_cf' && toolName === 'search'
          ? { policy: null, enabled: true, approval: 'ask' as const }
          : null,
    });
    expect(
      cloudflare.read(item('connections.tool-policy'), target, {
        connection: 'cloudflare',
        tool: 'app_cloudflare_search',
      }).values,
    ).toEqual({ connection: 'conn_cf', tool: 'search', policy: 'ask' });
    expect(
      adapter.options!(
        item('connections.tool-policy').fields[0]!,
        item('connections.tool-policy'),
        target,
      ),
    ).toEqual([{ value: 'conn-1', label: 'Notion 工作区' }]);
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

  it('reads the focused server into the snapshot', () => {
    const { adapter, settings } = rig();
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

  it("writes only this server's enabled flag on the latest list and revokes after the lock", async () => {
    const revoked: Array<{ previous: string[]; next: string[] }> = [];
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
        { id: 'off', name: 'Off', transport: 'stdio', command: 'echo', enabled: false },
      ],
    });
    const entry = item('mcp.servers');
    const bare = adapters(entry);
    // Without the revocation dependency the host cannot write (it would skip the interruption).
    expect(() =>
      bare.write!(entry, { next: { server: 'notes', enabled: false }, secrets: {} }, target),
    ).toThrow(/MCP 模块未就绪/);
    let stored = settings();
    const writes: unknown[] = [];
    const live = buildItemAdapters({
      settings: {
        get: () => stored,
        update: (patch) => {
          writes.push(patch);
          stored = settingsSchema.parse({ ...stored, ...patch });
          return stored;
        },
      },
      secrets: { hasValue: () => false, setValue: () => undefined },
      providers: { list: () => [], setKey: () => undefined },
      bots: { get: () => null },
      botProfiles: {
        apply: () => {
          throw new Error('no bot');
        },
      },
      mcpServers: {
        revokeChanges: (previous, next) =>
          void revoked.push({
            previous: previous.filter((server) => server.enabled).map((server) => server.id),
            next: next.filter((server) => server.enabled).map((server) => server.id),
          }),
      },
      publish: () => undefined,
    })(entry);
    expect(live.normalize!(entry, { server: 'gone' }, target)).toMatchObject({ ok: false });
    // A server added concurrently (after the card was issued) survives the write.
    stored = settingsSchema.parse({
      ...stored,
      mcpServers: [
        ...stored.mcpServers,
        { id: 'fresh', name: 'Fresh', transport: 'stdio', command: 'echo', enabled: true },
      ],
    });
    const effects = live.write!(
      entry,
      { next: { server: 'notes', enabled: false }, secrets: {} },
      target,
    );
    expect(stored.mcpServers.map((server) => [server.id, server.enabled])).toEqual([
      ['notes', false],
      ['off', false],
      ['fresh', true],
    ]);
    expect(stored.mcpServers[0]!.toolPolicies).toEqual({ search: { approval: 'ask' } });
    expect(revoked).toEqual([]);
    await effects!.afterUnlock!();
    expect(revoked).toEqual([{ previous: ['notes', 'fresh'], next: ['fresh'] }]);
    expect(writes).toHaveLength(1);
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
    const { adapters } = harness(
      {},
      {},
      {
        listInstalls: () => rows,
        systemStatuses: () => system,
      },
    );
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
    const healthy = harness(
      {},
      {},
      {
        listInstalls: () => [{ id: 'env_row_ok', status: 'installed' }],
        systemStatuses: () => [{ available: true }],
      },
    );
    expect(
      healthy.adapters(item('environment.toolchains')).read(item('environment.toolchains'), target),
    ).toMatchObject({
      status: 'configured',
      values: null,
      summary: '已安装 2 项，失败或缺失 0 项',
    });
    const empty = harness({}, {}, { listInstalls: () => [], systemStatuses: () => [] });
    expect(
      empty.adapters(item('environment.toolchains')).read(item('environment.toolchains'), target),
    ).toMatchObject({
      status: 'configured',
      values: null,
      summary: '已安装 0 项，失败或缺失 0 项',
    });
    const broken = harness(
      {},
      {},
      {
        listInstalls: () => [{ id: 'env_row_bad', status: 'failed' }],
        systemStatuses: () => [{ available: false }],
      },
    );
    expect(
      broken.adapters(item('environment.toolchains')).read(item('environment.toolchains'), target),
    ).toMatchObject({
      status: 'unconfigured',
      values: null,
      summary: '已安装 0 项，失败或缺失 2 项',
    });
  });

  it('stays unconfigured when the environment service is not wired', () => {
    const { adapters } = harness();
    expect(
      adapters(item('environment.toolchains')).read(item('environment.toolchains'), target),
    ).toEqual({
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

describe('environment allowlist read adapter', () => {
  const target = { botId: null, conversationId: null, projectId: null };
  const leaked = [
    { id: 'alw_leak', pattern: 'rm -rf /secret', enabled: true },
    { id: 'alw_off', pattern: 'curl http://evil.example', enabled: false },
    { id: 'alw_cat', pattern: 'cat', enabled: true, builtin: true },
  ];

  function read(allowlist?: AdapterDeps['allowlist']) {
    const { adapters } = harness({}, {}, undefined, undefined, allowlist);
    const adapter = adapters(item('environment.allowlist'));
    return { adapter, snapshot: adapter.read(item('environment.allowlist'), target) };
  }

  it('counts custom and built-in entries, keeps values null, and omits ids and patterns', () => {
    const { adapter, snapshot } = read({ list: () => leaked });
    expect(adapter.write).toBeUndefined();
    expect(adapter.valuesWiden).toBeUndefined();
    expect(snapshot).toEqual({
      status: 'unknown',
      values: null,
      secrets: {},
      summary: '自定义启用 1 条、停用 1 条；内置启用 1 条、停用 0 条',
    });
    const encoded = JSON.stringify(snapshot);
    expect(encoded).not.toContain('alw_');
    expect(encoded).not.toContain('rm -rf');
    expect(encoded).not.toContain('curl');
    expect(encoded).not.toContain('evil');
  });

  it('never reports configured: enabled built-ins (the default) say nothing about the command the bot needs', () => {
    expect(read({ list: () => [{ enabled: true, builtin: true }] }).snapshot.status).toBe(
      'unknown',
    );
    expect(read({ list: () => [] }).snapshot).toEqual({
      status: 'unknown',
      values: null,
      secrets: {},
      summary: '自定义启用 0 条、停用 0 条；内置启用 0 条、停用 0 条',
    });
  });

  it('is unknown when the allowlist service is not wired', () => {
    expect(read().snapshot).toEqual({
      status: 'unknown',
      values: null,
      secrets: {},
      summary: '还看不到命令白名单',
    });
  });
});

describe('validation and widening fixes (D89 review)', () => {
  it('network: any new domain widens regardless of the policy; hidden domains are never stored', () => {
    const rig = harness();
    const entry = item('bot.network');
    const adapter = rig.adapters(entry);
    expect(
      adapter.valuesWiden!(entry, { policy: 'none', allowlist: [] }, { allowlist: ['evil.com'] }),
    ).toBe(true);
    expect(
      adapter.valuesWiden!(
        entry,
        { policy: 'none', allowlist: ['example.com'] },
        { policy: 'none', allowlist: ['evil.com'] },
      ),
    ).toBe(true);
    expect(
      adapter.valuesWiden!(
        entry,
        { policy: 'allowlist', allowlist: ['a.com', 'b.com'] },
        { allowlist: ['a.com'] },
      ),
    ).toBe(false);
    adapter.write!(
      entry,
      { next: { policy: 'none', allowlist: ['evil.com'] }, secrets: {} },
      rig.target,
    );
    expect(rig.bot.profile.runtime.network_policy).toBe('none');
    expect(rig.bot.profile.runtime.network_allowlist).toEqual(['example.com']);
    adapter.write!(
      entry,
      { next: { policy: 'allowlist', allowlist: ['ok.test'] }, secrets: {} },
      rig.target,
    );
    expect(rig.bot.profile.runtime.network_allowlist).toEqual(['ok.test']);
  });

  it('bot runtime writes hand their side effects to the host instead of running them in the lock', () => {
    const settled: string[] = [];
    const rig = harness();
    const entry = item('bot.mcp-servers');
    const adapters = buildItemAdapters({
      settings: { get: rig.settings, update: () => rig.settings() },
      secrets: { hasValue: () => false, setValue: () => undefined },
      providers: { list: () => [], setKey: () => undefined },
      bots: { get: () => rig.bot },
      botProfiles: {
        apply: (_id, profile) => {
          rig.bot.profile = profile;
          return {
            bot: rig.bot,
            changedItemIds: ['bot.mcp-servers'],
            settle: async () => void settled.push('settled'),
          };
        },
      },
      publish: () => undefined,
    });
    const effects = adapters(entry).write!(
      entry,
      { next: { servers: [] }, secrets: {} },
      rig.target,
    );
    expect(rig.bot.profile.runtime.mcp_server_ids).toEqual([]);
    expect(settled).toEqual([]);
    expect(effects).toMatchObject({ changedItemIds: ['bot.mcp-servers'] });
    void effects!.afterUnlock!();
    expect(settled).toEqual(['settled']);
  });

  it('concurrency: only known providers and 1..16', () => {
    const rig = harness();
    const entry = item('models.concurrency');
    const adapter = buildItemAdapters({
      settings: { get: rig.settings, update: () => rig.settings() },
      secrets: { hasValue: () => false, setValue: () => undefined },
      providers: {
        list: () =>
          [{ id: 'openai', name: 'OpenAI', kind: 'builtin', models: [], hasKey: true }] as never,
        setKey: () => undefined,
      },
      bots: { get: () => null },
      botProfiles: {
        apply: () => {
          throw new Error('no bot');
        },
      },
      agentCatalog: () => [{ id: 'codex', name: 'Codex' }] as never,
      publish: () => undefined,
    })(entry);
    expect(adapter.normalize!(entry, { provider: 'openai', limit: 3 }, rig.target)).toMatchObject({
      ok: true,
    });
    expect(
      adapter.normalize!(entry, { provider: 'agent:codex', limit: 3 }, rig.target),
    ).toMatchObject({
      ok: true,
    });
    expect(
      adapter.normalize!(entry, { provider: '__proto__', limit: 3 }, rig.target),
    ).toMatchObject({
      ok: false,
    });
    expect(adapter.normalize!(entry, { provider: 'openai', limit: 99 }, rig.target)).toMatchObject({
      ok: false,
    });
    expect(() =>
      adapter.write!(entry, { next: { provider: 'nobody', limit: 2 }, secrets: {} }, rig.target),
    ).toThrow(/没有已接入的厂商/);
  });

  it('general.workbench write toggles freely (not gated by schedule count)', () => {
    const rig = harness({ workbenchEnabled: false });
    const entry = item('general.workbench');
    const adapter = rig.adapters(entry);
    expect(adapter.read(entry, rig.target, {}).values).toEqual({ enabled: false });
    adapter.write!(entry, { next: { enabled: true }, secrets: {} }, rig.target);
    expect(rig.settings().workbenchEnabled).toBe(true);
    adapter.write!(entry, { next: { enabled: false }, secrets: {} }, rig.target);
    expect(rig.settings().workbenchEnabled).toBe(false);
  });
});
