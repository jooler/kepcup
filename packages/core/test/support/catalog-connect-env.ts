import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  AppConnectFlowPayload,
  AppConnectionStatusPayload,
  McpServer,
  PreregisteredClientTable,
} from '@kepcup/shared';
import {
  createTestHome,
  makeBot,
  simulateBrowser,
  startFakeOAuthMcpServer,
  type FakeOAuthMcpOptions,
  type FakeOAuthMcpServer,
  type FakeMcpTool,
} from '@kepcup/testkit';
import { createCore, type CoreHarness } from '../../src/create-core.js';
import { ConnectorCatalog } from '../../src/apps/catalog.js';

/**
 * Harness for the catalog-connection tests (D73 P1 §5.4): a real core (encrypted main.db, real tool
 * lock, real Bot grant writer) + the testkit fake OAuth/MCP server standing in for "the app" + a fake
 * connector catalog pointing at it + a simulated browser. Never touches the network.
 */

export interface FakeEntryInput {
  slug: string;
  title?: string;
  url: string;
  version?: string;
  tier?: 'builtin' | 'verified' | 'community' | 'developer';
  registration?: 'auto' | 'preregistered';
  clientRef?: string;
  releaseGate?: string;
  toolPolicy?: Record<string, { risk: 'read' | 'write' | 'destructive' }>;
  whoami?: {
    tool: string;
    labelPath: string;
    subjectPath?: string;
    arguments?: Record<string, unknown>;
  };
  scopes?: { default: string[]; write: string[] };
}

/** A raw catalog entry (validated by `ConnectorCatalog`). */
export function fakeCatalogEntry(input: FakeEntryInput): Record<string, unknown> {
  const registration = input.registration ?? 'auto';
  return {
    name: `test.${input.slug}/mcp`,
    title: input.title ?? `Fake ${input.slug}`,
    description: `测试应用 ${input.slug}`,
    version: input.version ?? '1.0.0',
    remotes: [{ type: 'streamable-http', url: input.url }],
    _meta: {
      'app.kepcup/connector': {
        slug: input.slug,
        icon: `${input.slug}.svg`,
        category: 'productivity',
        tier: input.tier ?? 'builtin',
        auth: {
          kind: 'oauth',
          registration,
          clientRef: registration === 'preregistered' ? (input.clientRef ?? 'fake-ref') : null,
          scopes: input.scopes ?? { default: [], write: [] },
        },
        toolPolicy: input.toolPolicy ?? {},
        skills: [],
        ui: false,
        privacyPolicy: 'https://example.com/privacy',
        ...(input.whoami !== undefined ? { whoami: input.whoami } : {}),
        releaseGate: input.releaseGate ?? input.slug,
      },
    },
  };
}

async function freePorts(count: number): Promise<number[]> {
  const holders: Server[] = [];
  const ports: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    holders.push(server);
    ports.push((server.address() as AddressInfo).port);
  }
  await Promise.all(holders.map((s) => new Promise<void>((r) => s.close(() => r()))));
  return ports;
}

export async function until<T>(
  probe: () => T | null | undefined | false,
  ms = 10_000,
  label = 'until',
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`${label}: timed out`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

export interface CatalogEnvOptions {
  fake?: FakeOAuthMcpOptions;
  /** Entry slug (default `fake`) and extra entry fields. */
  entry?: Partial<FakeEntryInput>;
  /** Additional raw entries (e.g. a preregistered one) appended to the catalog. */
  extraEntries?: (fake: FakeOAuthMcpServer) => unknown[];
  /** Release gates: `null` = open (default). */
  approvedGates?: readonly string[] | null;
  flowTimeoutMs?: number;
  cimdUrl?: string;
  loopbackAllowlist?: string[];
  /** Pre-registered OAuth client table (replaces oauth-clients.json). */
  preregisteredClients?: (fake: FakeOAuthMcpServer) => PreregisteredClientTable;
  /** Extra `toolLockTrustFirstList` override (default false: new tools are locked until reviewed). */
  trustFirstList?: boolean;
}

export interface ConnectOutcome {
  flowId: string;
  events: AppConnectFlowPayload[];
  last: AppConnectFlowPayload;
  review: AppConnectFlowPayload | undefined;
}

export interface CatalogEnv {
  core: CoreHarness;
  fake: FakeOAuthMcpServer;
  slug: string;
  shellCalls: string[];
  flowEvents: AppConnectFlowPayload[];
  statusEvents: AppConnectionStatusPayload[];
  mcpStatus: Array<{ serverId: string; serverName: string; status: string }>;
  home: string;
  /** apps.connect → wait for review / terminal → decide → wait for terminal. */
  connect(options?: {
    slug?: string;
    grantBotId?: string;
    connectionId?: string;
    /** What to do at `reviewing_tools`: confirm (default) / cancel / nothing (park). */
    review?: 'confirm' | 'cancel' | 'park';
  }): Promise<ConnectOutcome>;
  makeBot(name: string): Promise<{ id: string }>;
  cleanup(): Promise<void>;
}

export async function startCatalogEnv(options: CatalogEnvOptions = {}): Promise<CatalogEnv> {
  const cleanups: Array<() => Promise<void> | void> = [];
  const cleanup = async (): Promise<void> => {
    for (const fn of cleanups.splice(0).reverse()) await fn();
  };
  const slug = options.entry?.slug ?? 'fake';
  const home = await createTestHome();
  cleanups.push(() => home.cleanup());
  const iconsDir = await mkdtemp(path.join(tmpdir(), 'kepcup-icons-'));
  cleanups.push(() => rm(iconsDir, { recursive: true, force: true }));
  await writeFile(path.join(iconsDir, `${slug}.svg`), '<svg xmlns="http://www.w3.org/2000/svg"/>');

  const fake = await startFakeOAuthMcpServer({ dcrEnabled: true, ...options.fake });
  cleanups.push(() => fake.stop());
  const entries = [
    fakeCatalogEntry({ slug, url: fake.mcpUrl, ...options.entry }),
    ...(options.extraEntries?.(fake) ?? []),
  ];
  const catalog = new ConnectorCatalog({
    env: {},
    source: { entries, iconsDir },
    approvedGates: options.approvedGates ?? null,
  });

  const shellCalls: string[] = [];
  const core = await createCore({
    home: home.home,
    appVersion: '0.0.0-test',
    shellRpc: {
      async openExternal({ url }) {
        shellCalls.push(url);
        void simulateBrowser(url).catch(() => undefined);
        return { ok: true };
      },
    },
    oauthLoopbackAllowlist: options.loopbackAllowlist ?? ['127.0.0.1'],
    oauthCallbackPorts: await freePorts(3),
    oauthFlowTimeoutMs: options.flowTimeoutMs ?? 20_000,
    ...(options.cimdUrl !== undefined ? { oauthCimdUrl: options.cimdUrl } : {}),
    toolLockTrustFirstList: options.trustFirstList ?? false,
    connectorCatalog: catalog,
    ...(options.preregisteredClients !== undefined
      ? { oauthPreregisteredClients: options.preregisteredClients(fake) }
      : {}),
  });
  cleanups.push(() => core.close());

  const flowEvents: AppConnectFlowPayload[] = [];
  const statusEvents: AppConnectionStatusPayload[] = [];
  const mcpStatus: CatalogEnv['mcpStatus'] = [];
  core.onEvent('apps.connect_flow', (payload) => {
    flowEvents.push(payload);
    if (payload.phase === 'awaiting_consent') {
      void core.rpc.call('apps.connect.continue', { flowId: payload.flowId });
    }
  });
  core.onEvent('apps.connection_status', (payload) => statusEvents.push(payload));
  core.onEvent('mcp.server_status', (payload) =>
    mcpStatus.push({
      serverId: payload.serverId,
      serverName: payload.serverName,
      status: payload.status,
    }),
  );

  const terminal = new Set(['done', 'failed', 'cancelled']);
  return {
    core,
    fake,
    slug,
    shellCalls,
    flowEvents,
    statusEvents,
    mcpStatus,
    home: home.home,
    async connect(connectOptions = {}) {
      const { flowId } = (await core.rpc.call('apps.connect', {
        target: { kind: 'catalog', connectorId: connectOptions.slug ?? slug },
        ...(connectOptions.grantBotId !== undefined
          ? { grantBotId: connectOptions.grantBotId }
          : {}),
        ...(connectOptions.connectionId !== undefined
          ? { connectionId: connectOptions.connectionId }
          : {}),
      })) as { flowId: string };
      const mine = (): AppConnectFlowPayload[] => flowEvents.filter((e) => e.flowId === flowId);
      const first = await until(
        () => mine().find((e) => e.phase === 'reviewing_tools' || terminal.has(e.phase)),
        20_000,
        'review or terminal phase',
      );
      const review = first.phase === 'reviewing_tools' ? first : undefined;
      if (review !== undefined && (connectOptions.review ?? 'confirm') !== 'park') {
        if ((connectOptions.review ?? 'confirm') === 'confirm') {
          await core.rpc.call('apps.connect.confirmTools', { flowId });
        } else {
          await core.rpc.call('apps.connect.cancel', { flowId });
        }
      }
      if (review === undefined || (connectOptions.review ?? 'confirm') !== 'park') {
        await until(() => mine().find((e) => terminal.has(e.phase)), 20_000, 'terminal phase');
      }
      const events = mine();
      return { flowId, events, last: events.at(-1)!, review };
    },
    makeBot: async (name) => makeBot(core, name),
    cleanup,
  };
}

/** A read-only whoami tool answering the current account of the fake app. */
export function whoamiTool(account: { current: { id: string; email: string } }): FakeMcpTool {
  return {
    name: 'whoami',
    description: 'Who am I',
    annotations: { readOnlyHint: true },
    handler: () =>
      JSON.stringify({ user: { id: account.current.id, email: account.current.email } }),
  };
}

export type { McpServer };
