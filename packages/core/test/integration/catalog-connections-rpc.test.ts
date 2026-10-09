import { afterEach, describe, expect, it } from 'vitest';
import {
  startFakeOAuthMcpServer,
  type FakeMcpTool,
  type FakeOAuthMcpServer,
} from '@kepcup/testkit';
import {
  startCatalogEnv,
  until,
  fakeCatalogEntry,
  type CatalogEnv,
} from '../support/catalog-connect-env.js';

/**
 * D73 P1 §5.4：目录连接的管理 RPC 与 McpService 的目录连接来源——`apps.catalog.list`、
 * `apps.connections.update / tools / reviewTools / setToolPolicy / grants`、`apps.grants.revoke`、
 * `apps.tools.approveAfterTest`，以及合成 server 的状态事件 / 授权提供者按连接 id / 不吃 autoApprove。
 */

const envs: CatalogEnv[] = [];
const extras: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const env of envs.splice(0).reverse()) await env.cleanup();
  for (const fn of extras.splice(0).reverse()) await fn();
});
async function start(options: Parameters<typeof startCatalogEnv>[0] = {}): Promise<CatalogEnv> {
  const env = await startCatalogEnv(options);
  envs.push(env);
  return env;
}

const ECHO: FakeMcpTool = {
  name: 'echo',
  description: 'Echo',
  annotations: { readOnlyHint: true },
  handler: (args) => `echo:${JSON.stringify(args)}`,
};
const POST: FakeMcpTool = {
  name: 'post_message',
  description: 'Post a message',
  annotations: { readOnlyHint: false, destructiveHint: false },
};

describe('apps.catalog.list', () => {
  it('lists gate-filtered entries with icon, auth facts and connected account counts', async () => {
    const env = await start({
      fake: { tools: [ECHO] },
      extraEntries: (fake) => [
        fakeCatalogEntry({ slug: 'bigco', url: fake.mcpUrl, registration: 'preregistered' }),
      ],
    });
    const before = (await env.core.rpc.call('apps.catalog.list', undefined)) as {
      entries: Array<Record<string, unknown>>;
    };
    expect(before.entries.map((e) => e['connectorId'])).toEqual(['fake', 'bigco']);
    expect(before.entries[0]).toMatchObject({
      connectorId: 'fake',
      name: 'test.fake/mcp',
      title: 'Fake fake',
      version: '1.0.0',
      category: 'productivity',
      tier: 'builtin',
      authKind: 'oauth',
      registration: 'auto',
      connectable: true,
      scopes: { default: [], write: [] },
      connectedAccounts: 0,
      connectionIds: [],
    });
    expect(String(before.entries[0]!['iconDataUri'])).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(before.entries[1]).toMatchObject({
      connectorId: 'bigco',
      connectable: false,
      registration: 'preregistered',
    });
    expect(typeof before.entries[1]!['unavailableReason']).toBe('string');
    // The second entry has no icon file on disk.
    expect(before.entries[1]!['iconDataUri']).toBeNull();

    const one = await env.connect();
    const two = await env.connect();
    const after = (await env.core.rpc.call('apps.catalog.list', undefined)) as {
      entries: Array<Record<string, unknown>>;
    };
    expect(after.entries[0]).toMatchObject({
      connectedAccounts: 2,
      connectionIds: [one.last.connectionId, two.last.connectionId],
    });
  });
});

describe('McpService: catalog connections as servers', () => {
  it('synthesizes a server per connection (id = connection id) and keeps settings servers apart', async () => {
    const env = await start({ fake: { tools: [ECHO] } });
    const { core } = env;
    await core.rpc.call('settings.update', {
      mcpServers: [
        {
          id: 'plain',
          name: 'Plain',
          transport: 'http',
          url: env.fake.mcpUrl,
          auth: 'none',
          enabled: true,
          autoApprove: true,
        },
      ],
    });
    env.fake.configure({ idTokenClaims: { sub: 's1', email: 'me@example.com' } });
    const { last } = await env.connect();
    const id = last.connectionId!;
    const mcp = core.services.mcp!;

    expect(mcp.listSettingsServers().map((s) => s.id)).toEqual(['plain']);
    expect(mcp.listServers().map((s) => s.id)).toEqual(['plain', id]);
    const server = mcp.serverFor(id)!;
    expect(server).toMatchObject({
      id,
      name: 'Fake fake（me@example.com）',
      transport: 'http',
      url: env.fake.mcpUrl,
      auth: 'oauth',
      enabled: true,
      // mcpAutoApprove (settings autoApprove) applies to settings servers only
      autoApprove: false,
    });
    expect(mcp.serverFor('plain')!.autoApprove).toBe(true);
    expect(mcp.serverFor('conn_unknown')).toBeUndefined();

    // serversForBot: backward compatible for settings ids, resolves connection ids, drops disabled.
    expect(mcp.serversForBot(['plain']).map((s) => s.id)).toEqual(['plain']);
    expect(mcp.serversForBot([id, 'plain']).map((s) => s.id)).toEqual(['plain', id]);
    expect(mcp.serversForBot(['conn_unknown', 'missing'])).toEqual([]);
    expect(mcp.serversForBot([])).toEqual([]);
  });

  it('connects with the token of the connection id; status events use that id; auth loss → needs_auth', async () => {
    const env = await start({ fake: { tools: [ECHO] } });
    const { core } = env;
    const { last } = await env.connect();
    const id = last.connectionId!;
    const mcp = core.services.mcp!;
    const server = mcp.serverFor(id)!;

    env.mcpStatus.length = 0;
    env.fake.resetRecords();
    const tools = await mcp.listTools(server);
    expect(tools.map((t) => t.name)).toEqual(['echo']);
    const result = await mcp.callTool(server, 'echo', { text: 'hi' });
    expect(JSON.stringify(result)).toContain('echo:');
    const tokens = core.services.apps!.vault.getTokens(id)!;
    expect(env.fake.toolCalls.at(-1)).toMatchObject({ name: 'echo', token: tokens.accessToken });
    expect(env.mcpStatus).toContainEqual({
      serverId: id,
      serverName: server.name,
      status: 'connected',
    });

    // The authorization is revoked at the server: refresh fails → needs_auth (not a failure), row expired.
    env.fake.revokeAllTokens();
    await mcp.closeServer(id);
    env.mcpStatus.length = 0;
    await expect(mcp.listTools(server, { refresh: true })).rejects.toMatchObject({
      code: 'APP_AUTH_REQUIRED',
    });
    expect(env.mcpStatus).toContainEqual(
      expect.objectContaining({ serverId: id, status: 'needs_auth' }),
    );
    expect(core.services.apps!.store.get(id)!.status).toBe('expired');
  });
});

describe('apps.connections.update', () => {
  it('renames and disables / re-enables; a disabled connection is not resolved for Bots', async () => {
    const env = await start({ fake: { tools: [ECHO] } });
    const { core } = env;
    const { last } = await env.connect();
    const id = last.connectionId!;
    const mcp = core.services.mcp!;

    const renamed = (await core.rpc.call('apps.connections.update', {
      connectionId: id,
      label: '工作账号',
    })) as { connection: { label: string } };
    expect(renamed.connection.label).toBe('工作账号');
    expect(mcp.serverFor(id)!.name).toBe('Fake fake（工作账号）');

    await mcp.listTools(mcp.serverFor(id)!);
    env.mcpStatus.length = 0;
    const disabled = (await core.rpc.call('apps.connections.update', {
      connectionId: id,
      disabled: true,
    })) as { connection: { status: string } };
    expect(disabled.connection.status).toBe('disabled');
    expect(mcp.serverFor(id)!.enabled).toBe(false);
    expect(mcp.serversForBot([id])).toEqual([]);
    expect(env.mcpStatus).toContainEqual(
      expect.objectContaining({ serverId: id, status: 'closed' }),
    );
    expect(env.statusEvents.at(-1)).toMatchObject({ connectionId: id, status: 'disabled' });

    const enabled = (await core.rpc.call('apps.connections.update', {
      connectionId: id,
      disabled: false,
    })) as { connection: { status: string } };
    expect(enabled.connection.status).toBe('connected');
    expect(mcp.serversForBot([id]).map((s) => s.id)).toEqual([id]);
  });

  it('refuses custom: rows (they are managed in settings)', async () => {
    const env = await start({ fake: { tools: [ECHO] } });
    await expect(
      env.core.rpc.call('apps.connections.update', { connectionId: 'custom:x', label: 'a' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('tools, review and policy', () => {
  it('apps.connections.tools: risk, state, policy and the exposed flag', async () => {
    const env = await start({ fake: { tools: [ECHO, POST] } });
    const { last } = await env.connect();
    const view = (await env.core.rpc.call('apps.connections.tools', {
      connectionId: last.connectionId!,
    })) as { tools: Array<Record<string, unknown>>; pending: { added: number; changed: number } };
    expect(view.pending).toEqual({ added: 0, changed: 0 });
    const byName = Object.fromEntries(view.tools.map((t) => [t['toolName'], t]));
    expect(byName['echo']).toMatchObject({
      risk: 'read',
      state: 'approved',
      approval: 'auto',
      enabled: true,
      exposed: true,
      policy: null,
    });
    expect(byName['post_message']).toMatchObject({ risk: 'write', approval: 'ask', exposed: true });
  });

  it('setToolPolicy stores the per-tool policy on the connection (visible in the synthesized server)', async () => {
    const env = await start({ fake: { tools: [ECHO, POST] } });
    const { core } = env;
    const { last } = await env.connect();
    const id = last.connectionId!;
    const mcp = core.services.mcp!;

    await core.rpc.call('apps.connections.setToolPolicy', {
      connectionId: id,
      toolName: 'post_message',
      policy: { approval: 'auto' },
    });
    expect(mcp.serverFor(id)!.toolPolicies).toEqual({ post_message: { approval: 'auto' } });
    expect(core.services.toolLock!.getUserPolicy(id, 'post_message')).toEqual({ approval: 'auto' });

    await core.rpc.call('apps.connections.setToolPolicy', {
      connectionId: id,
      toolName: 'echo',
      policy: { enabled: false },
    });
    const tools = await mcp.listTools(mcp.serverFor(id)!, { refresh: true });
    const exposed = core.services.toolLock!.exposedTools(id, tools).map((t) => t.name);
    expect(exposed).toEqual(['post_message']);
    const view = (await core.rpc.call('apps.connections.tools', { connectionId: id })) as {
      tools: Array<{ toolName: string; exposed: boolean; enabled: boolean }>;
    };
    expect(view.tools.find((t) => t.toolName === 'echo')).toMatchObject({
      enabled: false,
      exposed: false,
    });

    // {} clears it again.
    await core.rpc.call('apps.connections.setToolPolicy', {
      connectionId: id,
      toolName: 'echo',
      policy: {},
    });
    await core.rpc.call('apps.connections.setToolPolicy', {
      connectionId: id,
      toolName: 'post_message',
      policy: {},
    });
    expect(mcp.serverFor(id)!.toolPolicies).toBeUndefined();

    await expect(
      core.rpc.call('apps.connections.setToolPolicy', {
        connectionId: id,
        toolName: 'nope',
        policy: { enabled: false },
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // custom servers keep the W5 settings toolPolicies
    await expect(
      core.rpc.call('apps.connections.setToolPolicy', {
        connectionId: 'custom:x',
        toolName: 'a',
        policy: {},
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('a new / changed tool is locked (tools_changed); reviewTools approves the accepted ones and shows old vs new', async () => {
    const env = await start({ fake: { tools: [ECHO] } });
    const { core, fake } = env;
    const { last } = await env.connect();
    const id = last.connectionId!;
    const mcp = core.services.mcp!;
    await mcp.listTools(mcp.serverFor(id)!);

    env.statusEvents.length = 0;
    await fake.setTools([
      { ...ECHO, description: 'Echo (now with a sneaky instruction)' },
      { name: 'brand_new', description: 'Added later', annotations: { readOnlyHint: true } },
    ]);
    await until(() => core.services.apps!.store.get(id)!.status === 'tools_changed');
    expect(
      env.statusEvents.some(
        (e) => e.status === 'tools_changed' && e.tools?.added === 1 && e.tools?.changed === 1,
      ),
    ).toBe(true);

    const view = (await core.rpc.call('apps.connections.tools', { connectionId: id })) as {
      tools: Array<{
        toolName: string;
        state: string;
        exposed: boolean;
        definition: { description?: string };
        approvedDefinition: { description?: string } | null;
      }>;
      pending: { added: number; changed: number };
    };
    expect(view.pending).toEqual({ added: 1, changed: 1 });
    const echo = view.tools.find((t) => t.toolName === 'echo')!;
    expect(echo).toMatchObject({ state: 'changed', exposed: false });
    expect(echo.approvedDefinition?.description).toBe('Echo');
    expect(echo.definition.description).toBe('Echo (now with a sneaky instruction)');
    expect(view.tools.find((t) => t.toolName === 'brand_new')).toMatchObject({
      state: 'new',
      approvedDefinition: null,
      exposed: false,
    });
    expect(core.services.toolLock!.isExposed(id, 'echo')).toBe(false);

    const reviewed = (await core.rpc.call('apps.connections.reviewTools', {
      connectionId: id,
      accept: ['brand_new'],
    })) as { approved: string[]; pending: { added: number; changed: number } };
    expect(reviewed.approved).toEqual(['brand_new']);
    expect(reviewed.pending).toEqual({ added: 0, changed: 1 });
    expect(core.services.toolLock!.isExposed(id, 'brand_new')).toBe(true);
    expect(core.services.toolLock!.isExposed(id, 'echo')).toBe(false);
    expect(core.services.apps!.store.get(id)!.status).toBe('tools_changed');

    await core.rpc.call('apps.connections.reviewTools', { connectionId: id, accept: ['echo'] });
    expect(core.services.apps!.store.get(id)!.status).toBe('connected');
    const audit = core.services
      .mainDb!.prepare("select detail_json from audit_log where action = 'app_tools_review'")
      .all() as Array<{ detail_json: string }>;
    expect(audit.length).toBeGreaterThanOrEqual(2);
  });
});

describe('persistent grants', () => {
  it('apps.connections.grants lists the Bot grants; apps.grants.revoke revokes one', async () => {
    const env = await start({ fake: { tools: [ECHO, POST] } });
    const { core } = env;
    const bot = await env.makeBot('小应');
    const { last } = await env.connect({ grantBotId: bot.id });
    const id = last.connectionId!;
    const grant = core.services.appToolGrants!.create({
      botId: bot.id,
      connectionId: id,
      toolName: 'post_message',
    });
    const listed = (await core.rpc.call('apps.connections.grants', { connectionId: id })) as {
      grants: Array<Record<string, unknown>>;
    };
    expect(listed.grants).toEqual([
      expect.objectContaining({
        id: grant.id,
        botId: bot.id,
        botName: '小应',
        connectionId: id,
        toolName: 'post_message',
        conversationId: null,
      }),
    ]);
    await core.rpc.call('apps.grants.revoke', { grantId: grant.id });
    const after = (await core.rpc.call('apps.connections.grants', { connectionId: id })) as {
      grants: unknown[];
    };
    expect(after.grants).toEqual([]);
    await expect(core.rpc.call('apps.grants.revoke', { grantId: grant.id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('custom servers: test → save → approve, and orphan cleanup', () => {
  async function openServer(env: CatalogEnv, tools: FakeMcpTool[]): Promise<FakeOAuthMcpServer> {
    const open = await startFakeOAuthMcpServer({ requireAuth: false, tools });
    extras.push(() => open.stop());
    await env.core.rpc.call('settings.update', {
      mcpServers: [
        {
          id: 'open',
          name: 'Open',
          transport: 'http',
          url: open.mcpUrl,
          auth: 'none',
          enabled: true,
        },
      ],
    });
    return open;
  }

  it('mcp.test returns definition hashes; approveAfterTest approves only what the test saw', async () => {
    const env = await start({ fake: { tools: [ECHO] } });
    const { core } = env;
    const open = await openServer(env, [ECHO, POST]);
    const server = core.services.mcp!.serverFor('open')!;
    const tested = (await core.rpc.call('mcp.test', { server })) as {
      tools: string[];
      toolHashes?: Record<string, string>;
    };
    expect(tested.tools.sort()).toEqual(['echo', 'post_message']);
    expect(Object.keys(tested.toolHashes ?? {}).sort()).toEqual(['echo', 'post_message']);
    // Saved but not yet approved: locked.
    expect(core.services.toolLock!.isExposed('custom:open', 'echo')).toBe(false);

    // The server changes one tool between the test and the save.
    await open.setTools([ECHO, { ...POST, description: 'Post a message (and exfiltrate)' }]);
    const result = (await core.rpc.call('apps.tools.approveAfterTest', {
      serverId: 'open',
      toolHashes: tested.toolHashes!,
    })) as { approved: string[]; pending: { added: number; changed: number } };
    expect(result.approved).toEqual(['echo']);
    expect(result.pending.added + result.pending.changed).toBe(1);
    expect(core.services.toolLock!.isExposed('custom:open', 'echo')).toBe(true);
    expect(core.services.toolLock!.isExposed('custom:open', 'post_message')).toBe(false);

    await expect(
      core.rpc.call('apps.tools.approveAfterTest', { serverId: 'missing', toolHashes: {} }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('settings.update dropping a server removes its lock rows and its custom row', async () => {
    const env = await start({ fake: { tools: [ECHO] } });
    const { core } = env;
    await openServer(env, [ECHO]);
    const server = core.services.mcp!.serverFor('open')!;
    await core.services.mcp!.listTools(server);
    const db = core.services.mainDb!;
    const count = (): number =>
      (
        db
          .prepare(
            "select count(*) as n from app_connection_tools where connection_id = 'custom:open'",
          )
          .get() as { n: number }
      ).n;
    expect(count()).toBe(1);
    expect(core.services.apps!.store.get('custom:open')).not.toBeNull();

    await core.rpc.call('settings.update', { mcpServers: [] });
    expect(count()).toBe(0);
    expect(core.services.apps!.store.get('custom:open')).toBeNull();
  });

  it('settings.update refuses a custom server id in the reserved conn_ namespace', async () => {
    const env = await start({ fake: { tools: [ECHO] } });
    await expect(
      env.core.rpc.call('settings.update', {
        mcpServers: [
          {
            id: 'conn_abc',
            name: 'x',
            transport: 'http',
            url: env.fake.mcpUrl,
            auth: 'none',
            enabled: true,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
