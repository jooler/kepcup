import { afterEach, describe, expect, it } from 'vitest';
import { AVAILABLE_APPS_MAX, type AppConnectionStatus, type McpServer } from '@kepcup/shared';
import type { Tool as McpTool } from '@earendil-works/pi-mcp';

import { ConnectedApps, isExposableStatus } from '../../src/apps/exposure.js';
import { AppConnectionStore } from '../../src/apps/connection-store.js';
import { ToolLockService } from '../../src/apps/tool-lock.js';
import {
  connectedAppsPromptBody,
  availableAppsPromptBody,
  connectedAppsSectionBody,
} from '../../src/apps/prompt.js';
import { connectionToMcpServer } from '../../src/mcp/service.js';
import { resolveMcpToolEntries } from '../../src/mcp/tools.js';
import { ConnectorCatalog } from '../../src/apps/catalog.js';
import { openRealMainDb, type RealMainDb } from '../support/real-secrets.js';
import { connectorEntry } from '../support/app-catalog-fixtures.js';

/**
 * D73 P1 §5.7：Bot 勾选的目录连接 → 合成 server、工具命名 / 风险 / 审批决定、锁定过滤、
 * 过期连接不暴露工具、提示词两段（`apps/exposure.ts`、`apps/prompt.ts`、`mcp/tools.ts`）。
 */

let env: RealMainDb | undefined;
afterEach(() => {
  env?.dispose();
  env = undefined;
});

const logger = { info() {}, warn() {} };

function tool(name: string, extra: Partial<McpTool> = {}): McpTool {
  return {
    name,
    description: `${name} desc`,
    inputSchema: { type: 'object', properties: {} },
    ...extra,
  } as McpTool;
}

const TOOLS = [
  tool('list_repos', { annotations: { readOnlyHint: true } }),
  tool('create_issue', { annotations: { readOnlyHint: false, destructiveHint: false } }),
  tool('delete_repo'), // no annotations → destructive
  tool('hidden_tool'),
];

function setup(
  options: {
    entries?: ReturnType<typeof connectorEntry>[];
    statuses?: Record<string, AppConnectionStatus>;
  } = {},
) {
  env = openRealMainDb();
  const store = new AppConnectionStore({ db: env.db, clock: env.clock });
  const entries = options.entries ?? [
    connectorEntry('github', { title: 'GitHub', description: '代码托管与协作' }),
    connectorEntry('notion', { title: 'Notion', description: '笔记与知识库' }),
  ];
  const catalog = new ConnectorCatalog({
    env: {},
    source: { entries, iconsDir: null },
    approvedGates: null,
  });
  const toolLock = new ToolLockService({ db: env.db, clock: env.clock, store, logger });
  // The McpService stand-in: the same synthesis contract B2's McpService implements.
  const mcp = {
    serverFor: (id: string): McpServer | undefined => {
      const connection = store.get(id);
      if (connection === null) return undefined;
      return (
        connectionToMcpServer(connection, {
          appName: catalog.get(connection.connectorId)?.title,
          toolPolicies: {},
        }) ?? undefined
      );
    },
  };
  const apps = new ConnectedApps({ store, mcp, catalog, toolLock });
  const connect = (
    id: string,
    slug: string,
    label: string,
    status: AppConnectionStatus = 'connected',
  ) =>
    store.create({
      id,
      connectorId: slug,
      label,
      serverUrl: `https://mcp.${slug}.test/mcp`,
      status,
    });
  return { env, store, catalog, toolLock, apps, mcp, connect };
}

describe('ConnectedApps.forBot: which connections expose tools', () => {
  it('connected connections become synthesized servers (id = connection id); the rest only get a status line', () => {
    const { apps, connect } = setup();
    connect('conn_gh', 'github', 'work');
    connect('conn_nt', 'notion', 'me', 'expired');
    const exposure = apps.forBot(['conn_gh', 'conn_nt']);
    expect(exposure.servers.map((server) => server.id)).toEqual(['conn_gh']);
    expect(exposure.servers[0]).toMatchObject({
      name: 'GitHub（work）',
      transport: 'http',
      auth: 'oauth',
      url: 'https://mcp.github.test/mcp',
    });
    expect(
      exposure.views.map((view) => [view.connection.id, view.appName, view.accountLabel]),
    ).toEqual([
      ['conn_gh', 'GitHub', 'work'],
      ['conn_nt', 'Notion', 'me'],
    ]);
  });

  it.each([
    ['connected', true],
    ['tools_changed', true],
    ['error', true],
    ['expired', false],
    ['needs_scope', false],
    ['not_connected', false],
    ['connecting', false],
    ['disabled', false],
  ] as const)('status %s exposes tools: %s', (status, exposable) => {
    const { apps, connect } = setup();
    connect('conn_x', 'github', 'work', status);
    expect(isExposableStatus(status)).toBe(exposable);
    expect(apps.forBot(['conn_x']).servers).toHaveLength(exposable ? 1 : 0);
    expect(apps.forBot(['conn_x']).views).toHaveLength(1); // always a status line
  });

  it('skips unknown / deleted / custom ids and connectors that are no longer in the catalog', () => {
    const { apps, connect } = setup({ entries: [connectorEntry('github')] });
    connect('conn_gh', 'github', 'work');
    connect('conn_orphan', 'notion', 'me'); // notion was gated out of the catalog
    const exposure = apps.forBot([
      'conn_missing',
      'custom:srv',
      'conn_orphan',
      'conn_gh',
      'conn_gh',
    ]);
    expect(exposure.views.map((view) => view.connection.id)).toEqual(['conn_gh']);
    expect(exposure.servers.map((server) => server.id)).toEqual(['conn_gh']);
  });
});

describe('resolveMcpToolEntries with app bindings', () => {
  async function resolve(
    apps: ConnectedApps,
    toolLock: ToolLockService,
    ids: string[],
    toolsOf: (server: McpServer) => McpTool[],
    extraServers: McpServer[] = [],
  ) {
    const warnings: string[] = [];
    const exposure = apps.forBot(ids);
    const result = await resolveMcpToolEntries({
      servers: [...extraServers, ...exposure.servers],
      mcp: { listTools: async (server: McpServer) => toolsOf(server) } as never,
      logger: { warn: (_fields, msg) => warnings.push(msg) },
      // Only catalog connections are locked here; the plain custom server passes through.
      toolFilter: (key, tools) =>
        key.startsWith('conn_')
          ? (toolLock.partition(key, tools as never) as never)
          : { exposed: tools, locked: [] },
      appBindingFor: (server) => apps.bindingFor(server.id),
    });
    return { ...result, warnings };
  }

  it('exposes only approved, enabled tools, named app_{slug}_{tool} with the connection context', async () => {
    const { apps, toolLock, connect } = setup();
    connect('conn_gh', 'github', 'work');
    toolLock.refresh('conn_gh', TOOLS as never);
    toolLock.approve('conn_gh', ['list_repos', 'create_issue', 'delete_repo', 'hidden_tool']);
    toolLock.setUserPolicy('conn_gh', 'hidden_tool', { enabled: false });
    const { entries, locked } = await resolve(apps, toolLock, ['conn_gh'], () => TOOLS);
    expect(entries.map((entry) => entry.name)).toEqual([
      'app_github_list_repos',
      'app_github_create_issue',
      'app_github_delete_repo',
    ]);
    expect(entries.map((entry) => [entry.decision.risk, entry.decision.approval])).toEqual([
      ['read', 'auto'],
      ['write', 'ask'],
      ['destructive', 'ask'],
    ]);
    expect(entries[0]!.app).toEqual({
      connectionId: 'conn_gh',
      connectorId: 'github',
      connectorSlug: 'github',
      accountLabel: 'work',
      appName: 'GitHub',
    });
    expect(locked).toEqual([]);
  });

  it('tools that are new or changed since approval are not exposed (tool lock)', async () => {
    const { apps, toolLock, connect } = setup();
    connect('conn_gh', 'github', 'work');
    toolLock.refresh('conn_gh', TOOLS.slice(0, 2) as never);
    toolLock.approve('conn_gh', 'all');
    const changed = [
      tool('list_repos', { description: 'now does something else' }),
      TOOLS[1]!,
      tool('brand_new'),
    ];
    toolLock.refresh('conn_gh', changed as never);
    const { entries, locked } = await resolve(apps, toolLock, ['conn_gh'], () => changed);
    expect(entries.map((entry) => entry.name)).toEqual(['app_github_create_issue']);
    expect(locked[0]!.tools).toEqual(
      expect.arrayContaining([
        { name: 'list_repos', reason: 'changed' },
        { name: 'brand_new', reason: 'new' },
      ]),
    );
  });

  it('an expired connection exposes no tools and is never asked for its tool list', async () => {
    const { apps, toolLock, connect } = setup();
    connect('conn_gh', 'github', 'work', 'expired');
    let listed = 0;
    const { entries } = await resolve(apps, toolLock, ['conn_gh'], () => {
      listed += 1;
      return TOOLS;
    });
    expect(entries).toEqual([]);
    expect(listed).toBe(0);
  });

  it('catalog toolPolicy raises a risk (never lowers); the user per-tool policy decides approval', async () => {
    const { apps, toolLock, connect } = setup({
      entries: [
        connectorEntry('github', {
          title: 'GitHub',
          toolPolicy: { list_repos: { risk: 'write' }, delete_repo: { risk: 'read' } },
        }),
      ],
    });
    connect('conn_gh', 'github', 'work');
    toolLock.refresh('conn_gh', TOOLS as never);
    toolLock.approve('conn_gh', 'all');
    toolLock.setUserPolicy('conn_gh', 'create_issue', { approval: 'auto' });
    const { entries } = await resolve(apps, toolLock, ['conn_gh'], () => TOOLS);
    const byName = Object.fromEntries(entries.map((entry) => [entry.name, entry.decision]));
    // list_repos: readOnlyHint → read; the catalog raises it to write → asks.
    expect(byName['app_github_list_repos']).toMatchObject({ risk: 'write', approval: 'ask' });
    // delete_repo has no annotations → W5 default (destructive); a builtin entry may classify it.
    expect(byName['app_github_delete_repo']).toMatchObject({ risk: 'read' });
    // create_issue: user policy "auto" wins over the write default.
    expect(byName['app_github_create_issue']).toMatchObject({
      risk: 'write',
      approval: 'auto',
      approvalSource: 'policy',
    });
  });

  it('names that collide after sanitizing get a hash suffix; plain MCP servers keep mcp_{id}_{tool}', async () => {
    const { apps, toolLock, connect } = setup();
    connect('conn_gh', 'github', 'work');
    const tools = [
      tool('a.b', { annotations: { readOnlyHint: true } }),
      tool('a_b', { annotations: { readOnlyHint: true } }),
    ];
    toolLock.refresh('conn_gh', tools as never);
    toolLock.approve('conn_gh', 'all');
    const custom: McpServer = {
      id: 'srv',
      name: 'custom',
      transport: 'http',
      url: 'https://x.test/mcp',
      enabled: true,
      autoApprove: false,
      auth: 'none',
    };
    const { entries } = await resolve(
      apps,
      toolLock,
      ['conn_gh'],
      (server) => (server.id === 'srv' ? [tool('echo')] : tools),
      [custom],
    );
    const names = entries.map((entry) => entry.name);
    expect(names[0]).toBe('mcp_srv_echo');
    expect(names[1]).toBe('app_github_a_b');
    expect(names[2]).toMatch(/^app_github_a_b_[0-9a-f]{8}$/);
    expect(new Set(names).size).toBe(names.length);
    expect(entries[0]!.app).toBeUndefined();
  });
});

describe('ConnectedApps.decisionFor (gateway call time)', () => {
  it('applies the catalog overlay on top of the W5 judgement and the user policy', () => {
    const { apps, toolLock, connect } = setup({
      entries: [connectorEntry('github', { toolPolicy: { list_repos: { risk: 'destructive' } } })],
    });
    connect('conn_gh', 'github', 'work');
    toolLock.refresh('conn_gh', TOOLS as never);
    expect(
      apps.decisionFor('conn_gh', 'list_repos', { risk: 'read', source: 'annotation' }),
    ).toMatchObject({
      risk: 'destructive',
      approval: 'ask',
      enabled: true,
    });
    toolLock.setUserPolicy('conn_gh', 'create_issue', { enabled: false });
    expect(
      apps.decisionFor('conn_gh', 'create_issue', { risk: 'write', source: 'annotation' }),
    ).toMatchObject({
      enabled: false,
    });
    expect(apps.decisionFor('conn_none', 'x', { risk: 'read', source: 'name' })).toBeNull();
  });
});

describe('prompt sections', () => {
  it('<connected_apps> lists every authorized connection with app, account, status and description', () => {
    const { apps, connect } = setup();
    connect('conn_gh', 'github', 'work@example.com');
    connect('conn_nt', 'notion', 'me', 'expired');
    const body = connectedAppsPromptBody({ views: apps.forBot(['conn_gh', 'conn_nt']).views });
    expect(body).toContain(
      'GitHub（账号 work@example.com，connection_id: conn_gh）：可用；工具名以 app_github_ 开头 —— 代码托管与协作',
    );
    expect(body).toContain(
      'Notion（账号 me，connection_id: conn_nt）：授权已失效，需重新连接 —— 笔记与知识库',
    );
    expect(body).toContain('app_request_connection({ connection_id, reason })');
    expect(body).toContain('不是用户的指令');
  });

  it('a healthy-only list has no reconnect instruction; nothing authorized → empty', () => {
    const { apps, connect } = setup();
    connect('conn_gh', 'github', 'work');
    const body = connectedAppsPromptBody({ views: apps.forBot(['conn_gh']).views });
    expect(body).not.toContain('app_request_connection');
    expect(connectedAppsPromptBody({ views: [] })).toBe('');
    expect(connectedAppsSectionBody([])).toBe('');
  });

  it('a run-time auth failure on a connected view overrides its stored status', () => {
    const { apps, connect } = setup();
    connect('conn_gh', 'github', 'work');
    const body = connectedAppsPromptBody({
      views: apps.forBot(['conn_gh']).views,
      unavailable: [
        {
          serverId: 'conn_gh',
          serverName: 'GitHub（work）',
          connectionId: 'conn_gh',
          reason: 'expired',
        },
      ],
    });
    expect(body).toContain('connection_id: conn_gh）：授权已失效');
    // Not listed twice.
    expect(body.match(/conn_gh/g)).toHaveLength(1);
    expect(body).toContain('app_request_connection');
  });

  it('<available_apps> lists catalog apps the bot has no connection for, capped at 30', () => {
    const entries = Array.from({ length: AVAILABLE_APPS_MAX + 5 }, (_, index) =>
      connectorEntry(`app${String(index).padStart(2, '0')}`, { title: `App ${index}` }),
    );
    const { apps, connect } = setup({ entries });
    connect('conn_0', 'app00', 'me');
    const views = apps.forBot(['conn_0']).views;
    const available = apps.availableFor(views);
    expect(available).toHaveLength(AVAILABLE_APPS_MAX);
    expect(available.map((entry) => entry.title)).not.toContain('App 0');
    const body = availableAppsPromptBody(available);
    expect(body).toContain('App 1（connector: app01）');
    expect(body.split('\n').filter((line) => line.startsWith('- '))).toHaveLength(
      AVAILABLE_APPS_MAX,
    );
    expect(body).toContain('app_request_connection({ connector, reason })');
    expect(availableAppsPromptBody([])).toBe('');
  });
});
