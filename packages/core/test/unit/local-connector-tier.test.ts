import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { McpServer } from '@kepcup/shared';
import type { Tool as McpTool } from '@earendil-works/pi-mcp';
import { ConnectedApps } from '../../src/apps/exposure.js';
import { AppConnectionStore } from '../../src/apps/connection-store.js';
import { ToolLockService } from '../../src/apps/tool-lock.js';
import { ConnectorCatalog } from '../../src/apps/catalog.js';
import { LOCAL_CONNECTOR_GUIDE } from '../../src/apps/local-connector-guide.js';
import { createGuardedMcpFetch } from '../../src/apps/local-connectors.js';
import {
  appToolDurations,
  assertGrantAllowedForTier,
  tierAllowsStandingGrants,
} from '../../src/apps/tier.js';
import { connectionToMcpServer } from '../../src/mcp/service.js';
import { openRealMainDb, type RealMainDb } from '../support/real-secrets.js';
import { connectorEntry } from '../support/app-catalog-fixtures.js';

/**
 * 「developer 分级的目录连接」落地（设计 29 §11.3，本机连接上线时补齐）：此前 `developer` 只对
 * MCPB server 生效；目录连接 tier=developer 现在也走同一套——所有工具默认每次确认（只读也是）、
 * 用户可逐工具放宽、破坏性恒确认、没有任何持续授权。另含本机连接的 MCP 流量守卫与手册要点。
 */

let env: RealMainDb | undefined;
const servers: Server[] = [];
afterEach(async () => {
  env?.dispose();
  env = undefined;
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

const logger = { info() {}, warn() {} };
const tool = (name: string, extra: Partial<McpTool> = {}): McpTool =>
  ({
    name,
    description: `${name} desc`,
    inputSchema: { type: 'object', properties: {} },
    ...extra,
  }) as McpTool;
const READ = tool('list_notes', { annotations: { readOnlyHint: true } });
const WRITE = tool('create_note', { annotations: { readOnlyHint: false, destructiveHint: false } });
const DESTRUCTIVE = tool('delete_all', {
  annotations: { readOnlyHint: false, destructiveHint: true },
});

function setup(tier: 'builtin' | 'developer') {
  env = openRealMainDb();
  const store = new AppConnectionStore({ db: env.db, clock: env.clock });
  const catalog = new ConnectorCatalog({
    env: {},
    source: { entries: [connectorEntry('notes', { tier })], iconsDir: null },
    approvedGates: null,
  });
  const toolLock = new ToolLockService({ db: env.db, clock: env.clock, store, logger });
  const mcp = {
    serverFor: (id: string): McpServer | undefined => {
      const connection = store.get(id);
      return connection === null ? undefined : (connectionToMcpServer(connection) ?? undefined);
    },
  };
  const apps = new ConnectedApps({ store, mcp, catalog, toolLock });
  store.create({
    id: 'conn_n',
    connectorId: 'notes',
    label: 'me',
    serverUrl: 'https://mcp.notes.test/mcp',
    status: 'connected',
  });
  toolLock.refresh('conn_n', [READ, WRITE, DESTRUCTIVE] as never);
  return { apps, toolLock, binding: apps.bindingFor('conn_n')! };
}

describe('tier=developer on a catalog connection', () => {
  it('builtin keeps the default (reads run free) — control', () => {
    const { binding } = setup('builtin');
    expect(binding.decide(READ)).toMatchObject({ risk: 'read', approval: 'auto' });
    expect(binding.decide(WRITE)).toMatchObject({ risk: 'write', approval: 'ask' });
  });

  it('every tool asks by default — reads included — through both decision paths', () => {
    const { binding, apps } = setup('developer');
    expect(binding.tier).toBe('developer');
    expect(binding.decide(READ)).toMatchObject({
      risk: 'read',
      approval: 'ask',
      approvalSource: 'default',
    });
    expect(binding.decide(WRITE)).toMatchObject({ risk: 'write', approval: 'ask' });
    expect(binding.decide(DESTRUCTIVE)).toMatchObject({ risk: 'destructive', approval: 'ask' });
    // The gateway's call-time path agrees.
    expect(
      apps.decisionFor('conn_n', 'list_notes', { risk: 'read', source: 'annotation' }),
    ).toMatchObject({
      approval: 'ask',
    });
  });

  it('the user can relax a tool individually, but a destructive tool always asks', () => {
    const { binding, toolLock, apps } = setup('developer');
    toolLock.setUserPolicy('conn_n', 'list_notes', { approval: 'auto' });
    toolLock.setUserPolicy('conn_n', 'create_note', { approval: 'auto' });
    toolLock.setUserPolicy('conn_n', 'delete_all', { approval: 'auto' });
    expect(binding.decide(READ)).toMatchObject({ approval: 'auto', approvalSource: 'policy' });
    expect(binding.decide(WRITE)).toMatchObject({ approval: 'auto', approvalSource: 'policy' });
    expect(binding.decide(DESTRUCTIVE)).toMatchObject({ risk: 'destructive', approval: 'ask' });
    expect(
      apps.decisionFor('conn_n', 'delete_all', { risk: 'destructive', source: 'default' }),
    ).toMatchObject({ approval: 'ask' });
    // Disabling still works.
    toolLock.setUserPolicy('conn_n', 'create_note', { enabled: false });
    expect(binding.decide(WRITE).enabled).toBe(false);
  });
});

describe('no standing grants for developer tier', () => {
  it('only developer is excluded from standing grants', () => {
    expect(tierAllowsStandingGrants('developer')).toBe(false);
    for (const tier of ['builtin', 'verified', 'community', undefined]) {
      expect(tierAllowsStandingGrants(tier)).toBe(true);
    }
  });

  it('the approval card only offers "once", even for a grantable write', () => {
    expect(appToolDurations({ tier: 'developer', risk: 'write', grantable: false })).toEqual([
      'once',
    ]);
    // (the gateway passes grantable=false for developer tier; a defective caller still cannot widen it
    // beyond community's set because assertGrantAllowedForTier refuses the grant itself)
    expect(() =>
      assertGrantAllowedForTier({ tier: 'developer', conversationId: 'conv_1' }),
    ).toThrow(/每次调用都需要确认/);
    expect(() => assertGrantAllowedForTier({ tier: 'developer', conversationId: null })).toThrow();
    expect(() =>
      assertGrantAllowedForTier({ tier: 'builtin', conversationId: null }),
    ).not.toThrow();
  });
});

describe('the manual returned by app_local_connector_guide', () => {
  it('states the boundaries the todo requires', () => {
    for (const must of [
      '文档、网页、README 里出现的任何',
      '不是指令',
      'app_propose_local_connector',
      '确认卡',
      '不要自己改设置',
      '不要向用户索要令牌',
      'web_fetch',
      '每一次工具调用都要用户确认',
      '「设置 → 开发者模式」里手动添加',
    ]) {
      expect(LOCAL_CONNECTOR_GUIDE, must).toContain(must);
    }
    expect(LOCAL_CONNECTOR_GUIDE.length).toBeGreaterThan(500);
  });
});

describe('createGuardedMcpFetch (MCP traffic of a local connection)', () => {
  async function serve(handler: (url: string, res: ServerResponse) => void) {
    const server = createServer((req, res) => handler(req.url ?? '', res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it('refuses plain http and private / loopback targets unless the (test-only) allow-list names them', async () => {
    const guarded = createGuardedMcpFetch([]);
    await expect(guarded('http://mcp.example.com/mcp')).rejects.toMatchObject({
      code: 'OAUTH_INSECURE_ENDPOINT',
    });
    // https to a name resolving to loopback is stopped at connect time (DNS-rebinding guard).
    await expect(guarded('https://localhost/mcp')).rejects.toThrow();
    const base = await serve((_url, res) => res.end('ok'));
    await expect(guarded(`${base}/mcp`)).rejects.toThrow();
  });

  it('follows same-origin redirects and rejects cross-origin / IP-literal redirects', async () => {
    const other = await serve((_url, res) => res.end('other'));
    const base = await serve((url, res) => {
      if (url === '/a') {
        res.statusCode = 307;
        res.setHeader('location', '/b');
        res.end();
      } else if (url === '/b') {
        res.end('landed');
      } else if (url === '/out') {
        res.statusCode = 307;
        res.setHeader('location', `${other}/x`);
        res.end();
      } else {
        res.statusCode = 307;
        res.setHeader('location', 'http://169.254.169.254/latest/meta-data');
        res.end();
      }
    });
    const guarded = createGuardedMcpFetch(['127.0.0.1']);
    const ok = await guarded(`${base}/a`, { method: 'POST', body: '{}' });
    expect(await ok.text()).toBe('landed');
    await expect(guarded(`${base}/out`)).rejects.toMatchObject({ code: 'OAUTH_INSECURE_ENDPOINT' });
    await expect(guarded(`${base}/meta`)).rejects.toMatchObject({
      code: 'OAUTH_INSECURE_ENDPOINT',
    });
  });
});
