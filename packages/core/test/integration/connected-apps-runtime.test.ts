import { afterEach, describe, expect, it } from 'vitest';
import type { McpServer, Run } from '@kepcup/shared';
import {
  createTestStack,
  listRuns,
  makeBot,
  openDirect,
  sendBatch,
  startFakeOAuthMcpServer,
  step,
  viaTask,
  waitFor,
  waitForRun,
  type FakeOAuthMcpServer,
  type MockChatRequest,
  type TestStack,
} from '@kepcup/testkit';

import { customConnectionId } from '../../src/apps/connection-store.js';
import { discoveryOf } from '../support/app-auth-env.js';

/**
 * D73 P0 runtime auth end to end (todo §4.12): a Bot with an OAuth custom server, the testkit
 * fake authorization/MCP server, tokens seeded through the Token Vault (the interactive flow is
 * not run here). The point: authorization trouble mid-run only ever becomes a reconnect card
 * (SETUP_REQUIRED → failed + setup → runs.retry); the browser is never opened by a run.
 */

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const SERVER_ID = 'oapp';
const CONN = customConnectionId(SERVER_ID);
const CLIENT_ID = 'test-client';

interface Harness {
  stack: TestStack;
  server: FakeOAuthMcpServer;
  botId: string;
  conversationId: string;
  shellCalls: string[];
  statuses: Array<{ connectionId: string; status: string }>;
  services: TestStack['core']['services'];
  connect(options?: {
    expiresInSec?: number;
    scope?: string[];
  }): ReturnType<FakeOAuthMcpServer['issueToken']>;
}

async function start(
  serverOptions: Parameters<typeof startFakeOAuthMcpServer>[0] = {},
): Promise<Harness> {
  const server = await startFakeOAuthMcpServer(serverOptions);
  cleanups.push(() => server.stop());
  const stack = await createTestStack();
  cleanups.push(() => stack.cleanup());
  const { core } = stack;
  const services = core.services;

  // The browser must never be opened by a run: every call is recorded.
  const shellCalls: string[] = [];
  services.shellRpc.bindFacade({
    openExternal: async ({ url }) => {
      shellCalls.push(url);
      return { ok: true };
    },
  });
  const statuses: Harness['statuses'] = [];
  services.events.on('apps.connection_status', (payload) => statuses.push(payload));

  const mcpServer: McpServer = {
    id: SERVER_ID,
    name: '连接应用',
    transport: 'http',
    url: server.mcpUrl,
    enabled: true,
    autoApprove: true,
    auth: 'oauth',
  };
  await core.rpc.call('settings.update', { mcpServers: [mcpServer] });
  const bot = await makeBot(core, '小应');
  await core.rpc.call('bots.update', {
    id: bot.id,
    profile: { ...bot.profile, runtime: { ...bot.profile.runtime, mcp_server_ids: [SERVER_ID] } },
  });
  const conv = await openDirect(core, bot.id);

  const apps = services.apps!;
  // What a finished interactive flow leaves behind (Vault only; no real flow here).
  const connect: Harness['connect'] = (options = {}) => {
    apps.store.ensureCustom(SERVER_ID, { label: '连接应用', serverUrl: server.mcpUrl });
    apps.vault.saveDiscovery(CONN, discoveryOf(server));
    apps.vault.saveClient(server.issuer, { client_id: CLIENT_ID }, { source: 'manual' });
    const issued = server.issueToken({ clientId: CLIENT_ID, scope: options.scope ?? [] });
    apps.vault.saveTokens(CONN, {
      access_token: issued.accessToken,
      token_type: 'Bearer',
      refresh_token: issued.refreshToken!,
      expires_in: options.expiresInSec ?? 3600,
    });
    apps.store.setStatus(CONN, 'connected');
    return issued;
  };
  return {
    stack,
    server,
    botId: bot.id,
    conversationId: conv.id,
    shellCalls,
    statuses,
    services,
    connect,
  };
}

const promptOf = (req: MockChatRequest): string => JSON.stringify(req.body.messages ?? []);
const toolNamesOf = (req: MockChatRequest): string[] =>
  (req.body.tools ?? []).map(
    (tool) => (tool as { function?: { name?: string } }).function?.name ?? '',
  );

async function stepsOf(h: Harness, runId: string) {
  return (
    (await h.stack.core.rpc.call('runs.steps', { runId })) as {
      steps: Array<{ type: string; payload: Record<string, unknown> }>;
    }
  ).steps;
}

async function echoResultOf(h: Harness, runId: string) {
  const steps = await stepsOf(h, runId);
  return steps.find((s) => s.type === 'tool_result' && s.payload['toolName'] === 'mcp_oapp_echo');
}

describe('connected app tool calls', () => {
  it('succeeds with the stored token, and refreshes transparently (proactive and after a server-side 401)', async () => {
    const h = await start();
    // Inside the refresh skew → refreshed before the first request.
    const issued = h.connect({ expiresInSec: 20 });
    h.stack.llm.script(
      'mock-main',
      viaTask({
        writes: false,
        taskSteps: [
          step().replyToolCall('mcp_oapp_echo', { text: 'first' }),
          step().replyText('done'),
        ],
        relay: '好了',
      }),
    );
    await sendBatch(h.stack.core, h.conversationId, ['调用应用']);
    const run = await waitForRun(h.stack.core, h.conversationId, 'completed', {
      loopType: 'task',
      timeoutMs: 30_000,
    });
    const result = await echoResultOf(h, run.id);
    expect(result!.payload['ok']).toBe(true);
    expect(String(result!.payload['content']).startsWith('<untrusted>')).toBe(true);
    const refreshed = h.services.apps!.vault.getTokens(CONN)!;
    expect(refreshed.accessToken).not.toBe(issued.accessToken);
    expect(h.server.toolCalls.at(-1)!.token).toBe(refreshed.accessToken);

    // The server drops the token mid-session: 401 → refresh → retry, the run never notices.
    h.server.expireToken(refreshed.accessToken);
    h.stack.llm.script(
      'mock-main',
      viaTask({
        writes: false,
        taskSteps: [
          step().replyToolCall('mcp_oapp_echo', { text: 'second' }),
          step().replyText('done again'),
        ],
        relay: '又好了',
      }),
    );
    await sendBatch(h.stack.core, h.conversationId, ['再调用一次']);
    const second = await waitFor(
      async () =>
        (await listRuns(h.stack.core, h.conversationId)).find(
          (r) => r.loopType === 'task' && r.status === 'completed' && r.id !== run.id,
        ) ?? null,
      { label: 'second task completed', timeoutMs: 30_000 },
    );
    expect((await echoResultOf(h, second.id))!.payload['ok']).toBe(true);
    expect(h.services.apps!.vault.getTokens(CONN)!.accessToken).not.toBe(refreshed.accessToken);
    // Never a browser, never an authorization request.
    expect(h.shellCalls).toEqual([]);
    expect(h.server.authorizeRequests).toEqual([]);
  }, 90_000);

  it('refresh fails → SETUP_REQUIRED → run failed with a connect-app setup → reconnect → runs.retry succeeds', async () => {
    const h = await start();
    const issued = h.connect();
    h.stack.llm.script('mock-main', [
      ...viaTask({
        writes: false,
        taskSteps: [
          // The run started with a working connection (tools listed). Right before the call the
          // server expires the access token and the refresh token is dead too.
          step().replyToolCall('mcp_oapp_echo', () => {
            h.server.expireToken(issued.accessToken);
            h.server.revokeToken(issued.refreshToken!);
            return { text: 'x' };
          }),
        ],
      }),
      // The failed task wakes a turn that tells the user.
      step().inTurn().replyText('应用连接失效了，请重新连接'),
    ]);
    await sendBatch(h.stack.core, h.conversationId, ['调用应用']);

    const failed = await waitForRun(h.stack.core, h.conversationId, 'failed', {
      loopType: 'task',
      timeoutMs: 30_000,
    });
    expect(failed.setup).toEqual({
      kind: 'connect-app',
      target: { kind: 'custom', serverId: SERVER_ID },
      connectionId: CONN,
      reason: 'expired',
    });
    expect(failed.error ?? '').toContain('重新连接');
    const toolResult = await echoResultOf(h, failed.id);
    expect(toolResult!.payload['errorCode']).toBe('SETUP_REQUIRED');
    // The connection is recorded as expired and the UI was told.
    expect(h.services.apps!.store.get(CONN)!.status).toBe('expired');
    expect(h.statuses).toContainEqual({ connectionId: CONN, status: 'expired' });
    // No browser, no authorization request, mid-run.
    expect(h.shellCalls).toEqual([]);
    expect(h.server.authorizeRequests).toEqual([]);

    // The user reconnects (the interactive flow's end state) and the card retries the run.
    h.connect();
    await h.services.appRuntime!.flowInvalidator.invalidate(CONN);
    // The flow's completion is audited (connection / issuer / scopes only).
    const connectAudit = h.services
      .mainDb!.prepare("select detail_json from audit_log where action = 'app_connect'")
      .all() as Array<{ detail_json: string }>;
    expect(connectAudit).toHaveLength(1);
    expect(JSON.parse(connectAudit[0]!.detail_json)).toMatchObject({
      connectionId: CONN,
      connector: CONN,
      issuer: h.server.issuer,
    });
    h.stack.llm.script('mock-main', [
      step().inTask().replyToolCall('mcp_oapp_echo', { text: 'again' }),
      step().inTask().replyText('这次成功了'),
      step().inTurn().replyText('搞定'),
    ]);
    const retried = (
      (await h.stack.core.rpc.call('runs.retry', { runId: failed.id })) as { run: Run }
    ).run;
    expect(retried.continuedFromRunIds).toEqual([failed.id]);
    const done = await waitFor(
      async () =>
        (await listRuns(h.stack.core, h.conversationId)).find(
          (r) => r.id === retried.id && r.status === 'completed',
        ) ?? null,
      { label: 'retried task completed', timeoutMs: 30_000 },
    );
    expect((await echoResultOf(h, done.id))!.payload['ok']).toBe(true);
    expect(h.shellCalls).toEqual([]);
  }, 90_000);
});

describe('listing failure at run start', () => {
  it('does not abort the run: tools are withheld, <connected_apps> names the server, app_request_connection raises the card', async () => {
    const h = await start();
    // Not connected: no tokens at all.
    h.services.apps!.store.ensureCustom(SERVER_ID, {
      label: '连接应用',
      serverUrl: h.server.mcpUrl,
    });
    h.stack.llm.script('mock-main', [
      step()
        .inTurn()
        .expect((req) => promptOf(req).includes('<connected_apps>'))
        .replyText('收到，但应用还没连接'),
    ]);
    await sendBatch(h.stack.core, h.conversationId, ['随便聊聊']);
    await waitForRun(h.stack.core, h.conversationId, 'completed', { timeoutMs: 20_000 });
    const turnRequest = h.stack.llm.requestsFor('mock-main')[0]!;
    expect(promptOf(turnRequest)).toContain('connection_id: custom:oapp');
    expect(promptOf(turnRequest)).toContain('尚未连接');
    expect(toolNamesOf(turnRequest)).toContain('app_request_connection');
    expect(toolNamesOf(turnRequest).some((name) => name.startsWith('mcp_oapp_'))).toBe(false);
    // The not-connected server cost nothing: no request reached it, no failure was counted.
    expect(h.server.requests).toEqual([]);

    // A task that needs the app asks the user via app_request_connection → connect-app setup.
    h.stack.llm.script('mock-main', [
      ...viaTask({
        writes: false,
        taskSteps: [
          step()
            .expect((req) => promptOf(req).includes('<connected_apps>'))
            .replyToolCall('app_request_connection', {
              connection_id: CONN,
              reason: '需要读取应用数据',
            }),
        ],
      }),
      step().inTurn().replyText('请先连接应用'),
    ]);
    await sendBatch(h.stack.core, h.conversationId, ['用应用查一下']);
    const failed = await waitForRun(h.stack.core, h.conversationId, 'failed', {
      loopType: 'task',
      timeoutMs: 30_000,
    });
    expect(failed.setup).toEqual({
      kind: 'connect-app',
      target: { kind: 'custom', serverId: SERVER_ID },
      connectionId: CONN,
      reason: 'not_connected',
    });
    const taskRequest = h.stack.llm
      .requestsFor('mock-main')
      .find((r) => promptOf(r).includes('<task_brief'))!;
    expect(toolNamesOf(taskRequest)).toContain('app_request_connection');
    expect(h.shellCalls).toEqual([]);

    // An id outside the Bot's selection is refused without a card.
    h.stack.llm.script('mock-main', [
      ...viaTask({
        writes: false,
        taskSteps: [
          step().replyToolCall('app_request_connection', { connection_id: 'custom:not-mine' }),
          step().replyText('好吧'),
        ],
        relay: '没有这个应用',
      }),
    ]);
    await sendBatch(h.stack.core, h.conversationId, ['连一个不存在的']);
    const refused = await waitFor(
      async () =>
        (await listRuns(h.stack.core, h.conversationId)).find(
          (r) => r.loopType === 'task' && r.status === 'completed' && r.id !== failed.id,
        ) ?? null,
      { label: 'refused request completes the task', timeoutMs: 30_000 },
    );
    const result = (await stepsOf(h, refused.id)).find(
      (s) => s.type === 'tool_result' && s.payload['toolName'] === 'app_request_connection',
    );
    expect(result!.payload['errorCode']).toBe('INVALID_INPUT');
  }, 90_000);

  it('a connected server is not listed in <connected_apps> and does not get the request tool when no oauth server is selected', async () => {
    const h = await start();
    h.connect();
    h.stack.llm.script('mock-main', [step().inTurn().replyText('在')]);
    await sendBatch(h.stack.core, h.conversationId, ['你好']);
    await waitForRun(h.stack.core, h.conversationId, 'completed', { timeoutMs: 20_000 });
    const request = h.stack.llm.requestsFor('mock-main')[0]!;
    expect(promptOf(request)).not.toContain('<connected_apps>');
  }, 60_000);
});

describe('disconnect and removal', () => {
  it('apps.disconnect revokes at the authorization server (refresh first), clears the tokens and keeps the custom row', async () => {
    const h = await start();
    const issued = h.connect();
    const { core } = h.stack;
    // Use the connection once so a client is cached.
    await core.services.mcp!.listTools(h.services.mcp!.listServers()[0]!);
    expect(
      core.services.domain!.secrets.names().filter((name) => name.startsWith('conn:')),
    ).toHaveLength(2);

    await core.rpc.call('apps.disconnect', { connectionId: CONN });

    expect(h.server.revokeRequests.map((request) => request.params['token_type_hint'])).toEqual([
      'refresh_token',
      'access_token',
    ]);
    expect(h.server.revokeRequests[0]!.params['token']).toBe(issued.refreshToken);
    expect(h.server.isRefreshTokenValid(issued.refreshToken!)).toBe(false);
    expect(h.server.isAccessTokenValid(issued.accessToken)).toBe(false);
    const names = core.services.domain!.secrets.names();
    expect(names.filter((name) => name.startsWith('conn:'))).toEqual([]);
    // A manually registered client is the user's configuration: it survives the disconnect.
    expect(names.filter((name) => name.startsWith('oauth:client:'))).toHaveLength(1);
    const row = h.services.apps!.store.get(CONN)!;
    expect(row).toMatchObject({ status: 'not_connected', issuer: null, tokenExpiresAt: null });
    expect(h.statuses.at(-1)).toEqual({ connectionId: CONN, status: 'not_connected' });
    // The cached MCP client is gone and the server now asks for a connection.
    await expect(
      core.services.mcp!.listTools(core.services.mcp!.listServers()[0]!),
    ).rejects.toMatchObject({ reason: 'not_connected' });
    // Audit: app_disconnect, without any token.
    const audit = core.services
      .mainDb!.prepare("select detail_json from audit_log where action = 'app_disconnect'")
      .all() as Array<{ detail_json: string }>;
    expect(audit).toHaveLength(1);
    const detail = JSON.parse(audit[0]!.detail_json) as Record<string, unknown>;
    expect(detail).toMatchObject({
      connectionId: CONN,
      connector: CONN,
      issuer: h.server.issuer,
      revoked: { refresh: true, access: true },
      removed: false,
    });
    expect(audit[0]!.detail_json).not.toContain(issued.accessToken);
    expect(audit[0]!.detail_json).not.toContain(issued.refreshToken!);
  }, 60_000);

  it('apps.disconnect cancels an in-flight interactive flow for that connection and waits for it: no stale status, no tokens afterwards', async () => {
    const h = await start();
    h.connect();
    const { core } = h.stack;
    const flowEvents: Array<{ flowId: string; phase: string }> = [];
    h.services.events.on('apps.connect_flow', (payload) => flowEvents.push(payload));

    const { flowId } = (await core.rpc.call('apps.connect', {
      target: { kind: 'custom', serverId: SERVER_ID },
    })) as { flowId: string };
    await waitFor(() =>
      flowEvents.some((event) => event.flowId === flowId && event.phase === 'awaiting_consent'),
    );
    await core.rpc.call('apps.connect.continue', { flowId });
    await waitFor(() => h.shellCalls.length === 1); // parked at awaiting_browser
    expect(h.services.apps!.flows.activeFlowIds()).toEqual([flowId]);

    await core.rpc.call('apps.disconnect', { connectionId: CONN });

    expect(h.services.apps!.flows.activeFlowIds()).toEqual([]);
    expect(flowEvents.filter((event) => event.flowId === flowId).at(-1)?.phase).toBe('cancelled');
    // The cancelled flow did not restore its old "connected" status over the disconnect.
    expect(h.services.apps!.store.get(CONN)!.status).toBe('not_connected');
    expect(h.statuses.at(-1)).toEqual({ connectionId: CONN, status: 'not_connected' });
    expect(h.services.apps!.vault.getTokens(CONN)).toBeNull();
  }, 60_000);

  it('a failing revocation endpoint is only logged: the local cleanup still happens', async () => {
    const h = await start({ revokeStatus: 500 });
    h.connect();
    await h.stack.core.rpc.call('apps.disconnect', { connectionId: CONN });
    expect(h.server.revokeRequests).toHaveLength(2);
    expect(
      h.stack.core.services.domain!.secrets.names().filter((name) => name.startsWith('conn:')),
    ).toEqual([]);
    expect(h.services.apps!.store.get(CONN)!.status).toBe('not_connected');
  }, 60_000);

  it('mcp.removeServer deletes the settings entry, secrets, tokens and the connection row (idempotent)', async () => {
    const h = await start();
    h.connect();
    const { core } = h.stack;
    await core.rpc.call('mcp.setSecret', {
      serverId: SERVER_ID,
      kind: 'header',
      name: 'X-Key',
      value: 'static-secret-1',
    });
    expect(core.services.domain!.secrets.names()).toContain(`mcp:${SERVER_ID}:header:X-Key`);

    await core.rpc.call('mcp.removeServer', { serverId: SERVER_ID });
    await core.rpc.call('mcp.removeServer', { serverId: SERVER_ID });

    expect(((await core.rpc.call('settings.get')) as { mcpServers: unknown[] }).mcpServers).toEqual(
      [],
    );
    const names = core.services.domain!.secrets.names();
    expect(
      names.filter((name) => name.startsWith(`mcp:${SERVER_ID}:`) || name.startsWith('conn:')),
    ).toEqual([]);
    expect(h.services.apps!.store.get(CONN)).toBeNull();
    expect(h.server.revokeRequests).toHaveLength(2);
    expect(
      (
        core.services
          .mainDb!.prepare("select count(*) as n from audit_log where action = 'app_disconnect'")
          .get() as { n: number }
      ).n,
    ).toBe(1);
  }, 60_000);
});

describe('settings.update that changes a connected OAuth server (token audience binding)', () => {
  const secretNames = (h: Harness) => h.stack.core.services.domain!.secrets.names();
  const mcpSettings = async (h: Harness) =>
    ((await h.stack.core.rpc.call('settings.get')) as { mcpServers: McpServer[] }).mcpServers;

  it('auth oauth → none: the old connection is revoked at the authorization server and its tokens are cleared', async () => {
    const h = await start();
    const issued = h.connect();
    const [server] = await mcpSettings(h);

    await h.stack.core.rpc.call('settings.update', {
      mcpServers: [{ ...server!, auth: 'none' }],
    });

    expect(h.server.revokeRequests.map((r) => r.params['token_type_hint'])).toEqual([
      'refresh_token',
      'access_token',
    ]);
    expect(h.server.isAccessTokenValid(issued.accessToken)).toBe(false);
    expect(h.server.isRefreshTokenValid(issued.refreshToken!)).toBe(false);
    expect(secretNames(h).filter((name) => name.startsWith('conn:'))).toEqual([]);
    expect(h.services.apps!.store.get(CONN)).toMatchObject({
      status: 'not_connected',
      issuer: null,
    });
    expect(h.statuses.at(-1)).toEqual({ connectionId: CONN, status: 'not_connected' });
    const audit = h.services
      .mainDb!.prepare("select detail_json from audit_log where action = 'app_disconnect'")
      .all() as Array<{ detail_json: string }>;
    expect(audit).toHaveLength(1);
    expect(audit[0]!.detail_json).not.toContain(issued.accessToken);
    // Nothing is sent with the old token any more: the unauthenticated server is simply a plain
    // (here: failing, since the fake still demands auth) connection without a Bearer.
    h.server.resetRecords();
    await h.services.mcp!.listTools(h.services.mcp!.listServers()[0]!).catch(() => undefined);
    expect(h.server.mcpRequests.every((request) => request.token === null)).toBe(true);
  }, 60_000);

  it('auth oauth → headers behaves the same', async () => {
    const h = await start();
    const issued = h.connect();
    const [server] = await mcpSettings(h);
    await h.stack.core.rpc.call('settings.update', {
      mcpServers: [{ ...server!, auth: 'headers', headers: { 'X-Key': 'static' } }],
    });
    expect(h.server.revokeRequests).toHaveLength(2);
    expect(h.server.isAccessTokenValid(issued.accessToken)).toBe(false);
    expect(h.services.apps!.vault.getTokens(CONN)).toBeNull();
    expect(h.services.apps!.store.get(CONN)!.status).toBe('not_connected');
  }, 60_000);

  it('the URL of an OAuth server changes: tokens bound to the old URL are revoked and never sent to the new one', async () => {
    const h = await start();
    const issued = h.connect();
    const other = await startFakeOAuthMcpServer();
    cleanups.push(() => other.stop());
    const [server] = await mcpSettings(h);

    await h.stack.core.rpc.call('settings.update', {
      mcpServers: [{ ...server!, url: other.mcpUrl }],
    });

    expect(h.server.revokeRequests.map((r) => r.params['token_type_hint'])).toEqual([
      'refresh_token',
      'access_token',
    ]);
    expect(h.services.apps!.vault.getTokens(CONN)).toBeNull();
    expect(h.services.apps!.store.get(CONN)!.status).toBe('not_connected');
    // The new URL is asked to connect from scratch, with no credentials at all.
    await expect(
      h.services.mcp!.listTools(h.services.mcp!.listServers()[0]!),
    ).rejects.toMatchObject({ reason: 'not_connected' });
    expect(other.requests).toEqual([]);
    expect(
      [...other.mcpRequests, ...other.tokenRequests, ...other.revokeRequests].some((request) =>
        JSON.stringify(request).includes(issued.accessToken),
      ),
    ).toBe(false);
  }, 60_000);

  it('edits that keep the same OAuth endpoint (rename, autoApprove, trailing-slash-equivalent URL) keep the connection', async () => {
    const h = await start();
    h.connect();
    const [server] = await mcpSettings(h);
    await h.stack.core.rpc.call('settings.update', {
      mcpServers: [
        { ...server!, name: '改个名', autoApprove: false, url: new URL(server!.url!).href },
      ],
    });
    expect(h.server.revokeRequests).toEqual([]);
    expect(h.services.apps!.vault.getTokens(CONN)).not.toBeNull();
    expect(h.services.apps!.store.get(CONN)!.status).toBe('connected');
  }, 60_000);

  it('a server that was never connected is left alone (no audit, no revocation)', async () => {
    const h = await start();
    const [server] = await mcpSettings(h);
    await h.stack.core.rpc.call('settings.update', { mcpServers: [{ ...server!, auth: 'none' }] });
    expect(h.server.revokeRequests).toEqual([]);
    expect(
      (
        h.services
          .mainDb!.prepare("select count(*) as n from audit_log where action = 'app_disconnect'")
          .get() as { n: number }
      ).n,
    ).toBe(0);
  }, 60_000);
});
