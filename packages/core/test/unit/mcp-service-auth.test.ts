import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MCP_RECONNECT_MAX,
  MCP_TOOL_LIST_CACHE_MS,
  type McpServer,
  type Settings,
} from '@kepcup/shared';
import { startFakeOAuthMcpServer, type FakeOAuthMcpServer } from '@kepcup/testkit';

import { AppAuthRequiredError } from '../../src/apps/auth/errors.js';
import { customConnectionId } from '../../src/apps/connection-store.js';
import { McpService, type McpAuthSource, type McpServerStatusSink } from '../../src/mcp/service.js';
import { openAppAuthEnv, seedConnection, type AppAuthEnv } from '../support/app-auth-env.js';

/**
 * McpService with `auth: 'oauth'` servers (D73 §4.8) over the real Streamable HTTP transport and
 * the fake OAuth/MCP server: authorization problems are not connection failures.
 */

const LOGGER = { info() {}, warn() {}, error() {}, debug() {} } as never;
const CONN = customConnectionId('srv');

let app: AppAuthEnv;
let server: FakeOAuthMcpServer;
let service: McpService;
let events: Array<{ serverId: string; status: string; detail?: string }>;

function oauthServer(overrides: Partial<McpServer> = {}): McpServer {
  return {
    id: 'srv',
    name: '连接应用',
    transport: 'http',
    url: server.mcpUrl,
    enabled: true,
    autoApprove: false,
    auth: 'oauth',
    ...overrides,
  };
}

function makeService(auth: McpAuthSource | undefined): McpService {
  const sink: McpServerStatusSink = { emit: (payload) => events.push(payload) };
  return new McpService({
    settings: { get: () => ({ mcpServers: [oauthServer()] }) as unknown as Settings } as never,
    secrets: { getValue: () => null, hasValue: () => false, redact: (t: string) => t } as never,
    logger: LOGGER,
    clock: app.env.clock,
    statusSink: sink,
    auth,
  });
}

beforeEach(async () => {
  app = openAppAuthEnv();
  events = [];
});
afterEach(async () => {
  await service?.closeAll().catch(() => {});
  await server?.stop();
  app.dispose();
});

async function start(options: Parameters<typeof startFakeOAuthMcpServer>[0] = {}): Promise<void> {
  server = await startFakeOAuthMcpServer({ now: () => app.env.clock.now(), ...options });
  service = makeService(app.registry);
  app.registry.bindMcp(service);
}

const statuses = () => events.map((event) => event.status);

describe('connect-time authorization errors', () => {
  it('not connected: AppAuthRequiredError, needs_auth — never counted, never failed, never disabled', async () => {
    await start();
    app.store.ensureCustom('srv', { label: '应用', serverUrl: server.mcpUrl });
    for (let attempt = 0; attempt < MCP_RECONNECT_MAX + 2; attempt += 1) {
      const error = await service.listTools(oauthServer()).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(AppAuthRequiredError);
      expect(error).toMatchObject({ reason: 'not_connected', connectionId: CONN });
    }
    expect(statuses()).not.toContain('failed');
    expect(statuses()).toContain('needs_auth');
    expect(server.mcpRequests).toHaveLength(0);

    // Connecting afterwards works at once: the auth errors burned no reconnect budget.
    seedConnection(app, server, 'srv');
    await app.registry.invalidate(CONN);
    expect((await service.listTools(oauthServer())).map((tool) => tool.name)).toEqual(['echo']);
    expect(statuses().at(-1)).toBe('connected');
  });

  it('a hostile "wrapped" authorization error is still recognised', async () => {
    await start();
    const wrapped: McpAuthSource = {
      providerFor: () => ({
        token: async () => {
          throw new Error('transport said no', {
            cause: new AppAuthRequiredError({ connectionId: CONN, reason: 'expired' }),
          });
        },
      }),
      hasTokens: () => true,
    };
    service = makeService(wrapped);
    await expect(service.listTools(oauthServer())).rejects.toBeInstanceOf(AppAuthRequiredError);
    expect(statuses()).toEqual(['connecting', 'needs_auth']);
  });

  it('a 401 that survives the provider (token rejected after refresh) is treated as expired and marks the connection', async () => {
    await start();
    const marked: string[] = [];
    service = makeService({
      providerFor: () => ({
        token: async () => 'rejected-token',
        onUnauthorized: async () => undefined,
      }),
      hasTokens: () => true,
      markExpired: (connectionId) => marked.push(connectionId),
    });
    for (let attempt = 0; attempt < MCP_RECONNECT_MAX + 1; attempt += 1) {
      await expect(service.listTools(oauthServer())).rejects.toMatchObject({
        name: 'AppAuthRequiredError',
        reason: 'expired',
      });
    }
    expect(marked).toEqual(Array(MCP_RECONNECT_MAX + 1).fill(CONN));
    expect(statuses()).not.toContain('failed');
  });

  it('without an auth source an oauth server is simply "not connected"', async () => {
    await start();
    service = makeService(undefined);
    await expect(service.listTools(oauthServer())).rejects.toMatchObject({
      reason: 'not_connected',
    });
  });
});

describe('with a connection', () => {
  it('lists and calls tools with the stored Bearer token', async () => {
    await start();
    const { issued } = seedConnection(app, server, 'srv');
    const tools = await service.listTools(oauthServer());
    expect(tools.map((tool) => tool.name)).toEqual(['echo']);
    const result = await service.callTool(oauthServer(), 'echo', { text: 'hi' });
    expect(result.isError).not.toBe(true);
    expect(server.toolCalls[0]).toMatchObject({ name: 'echo', token: issued.accessToken });
  });

  it('refreshes transparently: inside the skew before connecting, and after a server-side 401', async () => {
    await start();
    const { issued } = seedConnection(app, server, 'srv', { expiresInSec: 20 });
    await service.listTools(oauthServer());
    const afterProactive = app.vault.getTokens(CONN)!;
    expect(afterProactive.accessToken).not.toBe(issued.accessToken);
    expect(
      server.mcpRequests.every((request) => request.token === afterProactive.accessToken),
    ).toBe(true);

    // The server drops the access token early: 401 → onUnauthorized refreshes → the call is retried.
    server.expireToken(afterProactive.accessToken);
    server.resetRecords();
    const result = await service.callTool(oauthServer(), 'echo', {});
    expect(result.isError).not.toBe(true);
    const latest = app.vault.getTokens(CONN)!;
    expect(latest.accessToken).not.toBe(afterProactive.accessToken);
    expect(server.toolCalls[0]!.token).toBe(latest.accessToken);
    expect(
      server.tokenRequests.filter((request) => request.params['grant_type'] === 'refresh_token'),
    ).toHaveLength(1);
    expect(app.store.get(CONN)!.status).toBe('connected');
  });

  it('refresh fails mid-session: callTool throws the same AppAuthRequiredError, no failure counting, reconnect recovers', async () => {
    await start();
    const { issued } = seedConnection(app, server, 'srv');
    await service.listTools(oauthServer());
    server.expireToken(issued.accessToken);
    server.revokeToken(issued.refreshToken!);

    for (let attempt = 0; attempt < MCP_RECONNECT_MAX + 2; attempt += 1) {
      const error = await service
        .callTool(oauthServer(), 'echo', {})
        .catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(AppAuthRequiredError);
      expect(error).toMatchObject({ reason: 'expired', connectionId: CONN });
    }
    expect(app.store.get(CONN)!.status).toBe('expired');
    expect(statuses().filter((status) => status === 'failed')).toEqual([]);
    expect(statuses()).toContain('needs_auth');

    // The interactive flow finishes: new tokens + invalidate → the very next call works.
    const fresh = server.issueToken({ clientId: 'test-client' });
    app.vault.saveTokens(CONN, {
      access_token: fresh.accessToken,
      token_type: 'Bearer',
      refresh_token: fresh.refreshToken!,
      expires_in: 3600,
    });
    app.store.setStatus(CONN, 'connected');
    await app.registry.invalidate(CONN);
    const result = await service.callTool(oauthServer(), 'echo', {});
    expect(result.isError).not.toBe(true);
    expect(server.toolCalls.at(-1)!.token).toBe(fresh.accessToken);
  });

  it('403 insufficient_scope → AppAuthRequiredError(scope) with the step-up scopes; connection untouched', async () => {
    await start({
      tools: [{ name: 'echo', requiredScopes: ['write'], annotations: { readOnlyHint: true } }],
    });
    seedConnection(app, server, 'srv', { scope: ['read'] });
    await service.listTools(oauthServer());
    const error = await service
      .callTool(oauthServer(), 'echo', {})
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(AppAuthRequiredError);
    expect(error).toMatchObject({ reason: 'scope' });
    expect((error as AppAuthRequiredError).scopes).toEqual(
      expect.arrayContaining(['read', 'write']),
    );
    expect(app.store.get(CONN)!.status).toBe('needs_scope');
    expect(server.authorizeRequests).toHaveLength(0);
  });
});

describe('testServer', () => {
  it('oauth without tokens: a readable "not connected" result, no request, no authorization', async () => {
    await start();
    const result = await service.testServer(oauthServer());
    expect(result).toMatchObject({ tools: [], needsAuth: 'not_connected' });
    expect(result.message).toContain('尚未连接');
    expect(server.requests).toHaveLength(0);
    expect(server.authorizeRequests).toHaveLength(0);
  });

  it('oauth with tokens lists tools; with dead tokens reports expired instead of throwing', async () => {
    await start();
    const { issued } = seedConnection(app, server, 'srv');
    expect(await service.testServer(oauthServer())).toMatchObject({ tools: ['echo'] });
    server.expireToken(issued.accessToken);
    server.revokeToken(issued.refreshToken!);
    const dead = await service.testServer(oauthServer());
    expect(dead).toMatchObject({ tools: [], needsAuth: 'expired' });
    expect(server.authorizeRequests).toHaveLength(0);
  });
});

describe('testServer never sends a stored token to a renderer-supplied URL (D73 review)', () => {
  it('a draft that points the saved oauth server at another URL gets "not connected" — no request at all, the real connection untouched', async () => {
    await start();
    seedConnection(app, server, 'srv');
    const attacker = await startFakeOAuthMcpServer({ now: () => app.env.clock.now() });
    try {
      const result = await service.testServer(oauthServer({ url: attacker.mcpUrl }));
      expect(result).toMatchObject({ tools: [], needsAuth: 'not_connected' });
      expect(attacker.requests).toHaveLength(0);
      expect(server.requests).toHaveLength(0);
      expect(app.store.get(CONN)!.status).toBe('connected');
      expect(app.statuses).toEqual([]);
      // Same for an id that was never saved.
      expect(await service.testServer(oauthServer({ id: 'draft' }))).toMatchObject({
        needsAuth: 'not_connected',
      });
      expect(attacker.requests).toHaveLength(0);
    } finally {
      await attacker.stop();
    }
  });

  it('a draft whose URL is only spelled differently (trailing-slash-equivalent) is still the saved server', async () => {
    await start();
    seedConnection(app, server, 'srv');
    const spelled = new URL(server.mcpUrl);
    expect(await service.testServer(oauthServer({ url: spelled.href }))).toMatchObject({
      tools: ['echo'],
    });
  });

  it('defense in depth: the auth source refuses a URL other than the one the connection row records', async () => {
    await start();
    seedConnection(app, server, 'srv');
    const attacker = await startFakeOAuthMcpServer({ now: () => app.env.clock.now() });
    try {
      // Bypass the testServer pre-check: a stale/forged server entry reaching the connect path.
      const error = await service
        .listTools(oauthServer({ url: attacker.mcpUrl }))
        .catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(AppAuthRequiredError);
      expect(error).toMatchObject({ reason: 'not_connected' });
      expect(attacker.requests).toHaveLength(0);
      expect(statuses()).not.toContain('failed');
    } finally {
      await attacker.stop();
    }
  });
});

describe('listTools on a cached connection (D73 review)', () => {
  it('a 401 that survives the refresh becomes AppAuthRequiredError + needs_auth + markExpired, like callTool', async () => {
    await start();
    const issued = server.issueToken({ clientId: 'test-client' });
    const marked: string[] = [];
    service = makeService({
      providerFor: () => ({
        token: async () => issued.accessToken,
        onUnauthorized: async () => undefined,
      }),
      hasTokens: () => true,
      markExpired: (connectionId) => marked.push(connectionId),
    });
    expect((await service.listTools(oauthServer())).map((tool) => tool.name)).toEqual(['echo']);
    // The cached list is stale and the server has dropped the token meanwhile.
    app.env.clock.set(app.env.clock.now() + MCP_TOOL_LIST_CACHE_MS + 1);
    server.expireToken(issued.accessToken);
    events.length = 0;

    const error = await service.listTools(oauthServer()).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(AppAuthRequiredError);
    expect(error).toMatchObject({ reason: 'expired', connectionId: CONN });
    expect(marked).toEqual([CONN]);
    expect(statuses()).toEqual(['needs_auth']);
  });
});

describe('service controls', () => {
  it('resetFailures lifts a "disabled" server; closeServer drops the cached client without counting', async () => {
    await start();
    seedConnection(app, server, 'srv');
    await service.listTools(oauthServer());
    await service.closeServer('srv');
    expect(statuses().at(-1)).toBe('closed');
    // Reconnects lazily and nothing was counted.
    expect((await service.listTools(oauthServer())).length).toBe(1);
    service.resetFailures('srv');
    await service.closeServer('unknown-server'); // no-op
  });
});
