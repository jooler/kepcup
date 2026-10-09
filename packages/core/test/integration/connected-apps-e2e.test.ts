import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppConnectFlowPayload, McpServer } from '@kepcup/shared';
import {
  createTestStack,
  listRuns,
  makeBot,
  openDirect,
  publishCimdDocument,
  sendBatch,
  simulateBrowser,
  startFakeOAuthMcpServer,
  startFileServer,
  step,
  viaTask,
  waitFor,
  type FakeOAuthMcpServer,
  type MockChatRequest,
  type TestStack,
} from '@kepcup/testkit';

import { customConnectionId } from '../../src/apps/connection-store.js';

/**
 * D73 P0 gate (todo §4.13), automated part: the REAL interactive flow (core → shellRpc →
 * simulated browser → loopback callback → token exchange) for each client-registration path
 * (CIMD, DCR, manually entered client), then a Bot run calling the connected app's MCP tool,
 * a forced token expiry with transparent refresh, and `apps.disconnect` with the revocation
 * recorded at the fake authorization server — after which the tool is unavailable again.
 * Everything runs against the testkit fake OAuth/MCP server on 127.0.0.1.
 */

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

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

type RegistrationPath = 'cimd' | 'dcr' | 'manual';

interface E2E {
  stack: TestStack;
  server: FakeOAuthMcpServer;
  serverId: string;
  connectionId: string;
  botId: string;
  conversationId: string;
  toolName: string;
  shellCalls: string[];
  flowEvents: AppConnectFlowPayload[];
  /** Runs already consumed by earlier steps. */
  seenRuns: Set<string>;
}

async function start(path: RegistrationPath): Promise<E2E> {
  const serverId = path;
  const server = await startFakeOAuthMcpServer({
    cimdSupported: path === 'cimd',
    dcrEnabled: path === 'dcr',
    tools: [{ name: 'echo', description: 'Echo', annotations: { readOnlyHint: true } }],
  });
  cleanups.push(() => server.stop());

  let cimdUrl: string | undefined;
  if (path === 'cimd') {
    const files = await startFileServer({});
    cleanups.push(() => files.stop());
    cimdUrl = publishCimdDocument(files).clientId;
  }
  const shellCalls: string[] = [];
  const stack = await createTestStack({
    shellRpc: {
      async openExternal({ url }) {
        shellCalls.push(url);
        // The "system browser": consent at the fake authorization server, then the loopback callback.
        void simulateBrowser(url).catch(() => undefined);
        return { ok: true };
      },
    },
    oauthLoopbackAllowlist: ['127.0.0.1'],
    oauthCallbackPorts: await freePorts(3),
    oauthFlowTimeoutMs: 20_000,
    ...(cimdUrl !== undefined ? { oauthCimdUrl: cimdUrl } : {}),
  });
  cleanups.push(() => stack.cleanup());
  const { core } = stack;

  const mcpServer: McpServer = {
    id: serverId,
    name: `应用 ${path}`,
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
    profile: { ...bot.profile, runtime: { ...bot.profile.runtime, mcp_server_ids: [serverId] } },
  });
  const conv = await openDirect(core, bot.id);

  const flowEvents: AppConnectFlowPayload[] = [];
  core.services.events.on('apps.connect_flow', (payload) => flowEvents.push(payload));
  return {
    stack,
    server,
    serverId,
    connectionId: customConnectionId(serverId),
    botId: bot.id,
    conversationId: conv.id,
    toolName: `mcp_${serverId}_echo`,
    shellCalls,
    flowEvents,
    seenRuns: new Set(),
  };
}

const promptOf = (req: MockChatRequest): string => JSON.stringify(req.body.messages ?? []);
const toolNamesOf = (req: MockChatRequest): string[] =>
  (req.body.tools ?? []).map(
    (tool) => (tool as { function?: { name?: string } }).function?.name ?? '',
  );

async function phaseOf(e2e: E2E, flowId: string, phase: AppConnectFlowPayload['phase']) {
  return waitFor(
    async () =>
      e2e.flowEvents.find((event) => event.flowId === flowId && event.phase === phase) ?? null,
    { label: `flow ${phase}`, timeoutMs: 20_000 },
  );
}

/** apps.connect → (credentials for the manual path) → consent → browser → done. */
async function connectApp(e2e: E2E, path: RegistrationPath): Promise<string> {
  const { core } = e2e.stack;
  const { flowId } = (await core.rpc.call('apps.connect', {
    target: { kind: 'custom', serverId: e2e.serverId },
  })) as { flowId: string };

  if (path === 'manual') {
    // Neither CIMD nor DCR: the flow parks and tells the UI what to register where.
    const required = await phaseOf(e2e, flowId, 'failed');
    expect(required.error).toMatchObject({
      code: 'OAUTH_CLIENT_REQUIRED',
      issuer: e2e.server.issuer,
    });
    expect(required.error?.redirectUris?.length).toBeGreaterThan(0);
    e2e.server.addPreregisteredClient({
      clientId: 'manual-e2e-client',
      clientSecret: 'manual-e2e-secret',
      redirectUris: ['http://127.0.0.1/callback'],
    });
    await core.rpc.call('apps.setClientCredentials', {
      flowId,
      clientId: 'manual-e2e-client',
      clientSecret: 'manual-e2e-secret',
    });
  }

  const consent = await phaseOf(e2e, flowId, 'awaiting_consent');
  // The user sees the authorization host before the system browser opens.
  expect(consent.authorizationHost).toBe(new URL(e2e.server.url).host);
  expect(e2e.shellCalls).toHaveLength(0);
  await core.rpc.call('apps.connect.continue', { flowId });
  await phaseOf(e2e, flowId, 'done');
  return flowId;
}

/** One Bot task that calls the app's echo tool; resolves with the tool_result payload. */
async function runEcho(e2e: E2E, text: string): Promise<Record<string, unknown>> {
  const { core, llm } = e2e.stack;
  llm.script(
    'mock-main',
    viaTask({
      writes: false,
      taskSteps: [step().replyToolCall(e2e.toolName, { text }), step().replyText('完成')],
      relay: '好了',
    }),
  );
  await sendBatch(core, e2e.conversationId, [`调用应用 ${text}`]);
  const run = await waitFor(
    async () =>
      (await listRuns(core, e2e.conversationId)).find(
        (r) => r.loopType === 'task' && r.status === 'completed' && !e2e.seenRuns.has(r.id),
      ) ?? null,
    { label: `task for ${text} completed`, timeoutMs: 30_000 },
  );
  e2e.seenRuns.add(run.id);
  const { steps } = (await core.rpc.call('runs.steps', { runId: run.id })) as {
    steps: Array<{ type: string; payload: Record<string, unknown> }>;
  };
  const result = steps.find(
    (s) => s.type === 'tool_result' && s.payload['toolName'] === e2e.toolName,
  );
  expect(result, `tool_result of ${e2e.toolName}`).toBeDefined();
  return result!.payload;
}

describe.each<RegistrationPath>(['cimd', 'dcr', 'manual'])(
  'connected app gate: %s client registration',
  (path) => {
    it('connect → run → expiry + transparent refresh → disconnect (revoked) → tool unavailable', async () => {
      const e2e = await start(path);
      const { core, llm } = e2e.stack;
      const { server, connectionId } = e2e;
      const apps = core.services.apps!;

      // 1. Interactive connection through the real flow.
      await connectApp(e2e, path);
      expect(e2e.shellCalls).toHaveLength(1);
      expect(server.authorizeRequests).toHaveLength(1);
      expect(server.authorizeRequests[0]).toMatchObject({
        clientSource: path === 'manual' ? 'preregistered' : path,
        outcome: 'redirected',
      });
      expect(server.registrations).toHaveLength(path === 'dcr' ? 1 : 0);
      expect(server.cimdFetches.length > 0).toBe(path === 'cimd');
      const listed = (await core.rpc.call('apps.connections.list', { includeCustom: true })) as {
        connections: Array<{ id: string; status: string; issuer: string | null }>;
      };
      expect(listed.connections).toHaveLength(1);
      expect(listed.connections[0]).toMatchObject({
        id: connectionId,
        status: 'connected',
        issuer: server.issuer,
      });
      const first = apps.vault.getTokens(connectionId)!;
      expect(server.isAccessTokenValid(first.accessToken)).toBe(true);
      // No token in the flow events or the listing.
      expect(JSON.stringify([e2e.flowEvents, listed])).not.toContain(first.accessToken);
      expect(JSON.stringify([e2e.flowEvents, listed])).not.toContain(first.refreshToken!);

      // 2. A Bot run uses the tool with the stored token; no browser, no new authorization.
      const ok = await runEcho(e2e, 'hello');
      expect(ok['ok']).toBe(true);
      expect(String(ok['content']).startsWith('<untrusted>')).toBe(true);
      expect(server.toolCalls.at(-1)).toMatchObject({ name: 'echo', token: first.accessToken });

      // 3. The access token expires at the server: 401 → refresh → retry, the run never notices.
      const refreshesBefore = server.tokenRequests.filter(
        (r) => r.params['grant_type'] === 'refresh_token',
      ).length;
      server.expireToken(first.accessToken);
      const again = await runEcho(e2e, 'after expiry');
      expect(again['ok']).toBe(true);
      const refreshed = apps.vault.getTokens(connectionId)!;
      expect(refreshed.accessToken).not.toBe(first.accessToken);
      expect(
        server.tokenRequests.filter((r) => r.params['grant_type'] === 'refresh_token').length,
      ).toBeGreaterThan(refreshesBefore);
      expect(server.toolCalls.at(-1)!.token).toBe(refreshed.accessToken);
      expect(e2e.shellCalls).toHaveLength(1);
      expect(server.authorizeRequests).toHaveLength(1);
      expect(apps.store.get(connectionId)!.status).toBe('connected');

      // 4. Disconnect: RFC 7009 revocation (refresh token first), vault cleared, audited.
      server.resetRecords();
      await core.rpc.call('apps.disconnect', { connectionId });
      expect(server.revokeRequests.map((r) => r.params['token_type_hint'])).toEqual([
        'refresh_token',
        'access_token',
      ]);
      expect(server.revokeRequests[0]!.params['token']).toBe(refreshed.refreshToken);
      expect(server.revokeRequests[1]!.params['token']).toBe(refreshed.accessToken);
      expect(server.isAccessTokenValid(refreshed.accessToken)).toBe(false);
      expect(server.isRefreshTokenValid(refreshed.refreshToken!)).toBe(false);
      expect(apps.vault.getTokens(connectionId)).toBeNull();
      expect(apps.store.get(connectionId)).toMatchObject({ status: 'not_connected' });
      const names = core.services.domain!.secrets.names();
      expect(names.filter((name) => name.startsWith('conn:'))).toEqual([]);
      // A hand-entered client is the user's configuration and survives; DCR clients do not.
      // (the manual client is stored as client id + client secret.)
      expect(names.filter((name) => name.startsWith('oauth:client:'))).toHaveLength(
        path === 'manual' ? 2 : 0,
      );
      const audit = core.services
        .mainDb!.prepare(
          "select action, detail_json from audit_log where action in ('app_connect', 'app_disconnect') order by rowid",
        )
        .all() as Array<{ action: string; detail_json: string }>;
      expect(audit.map((row) => row.action)).toEqual(['app_connect', 'app_disconnect']);
      expect(JSON.stringify(audit)).not.toContain(refreshed.accessToken);
      expect(JSON.stringify(audit)).not.toContain(refreshed.refreshToken!);

      // 5. The tool is unavailable again: not offered to the model, the prompt asks for a
      //    reconnection, and the run never opens a browser.
      llm.script('mock-main', [
        step()
          .inTurn()
          .expect((req) => promptOf(req).includes('<connected_apps>'))
          .replyText('应用已断开'),
      ]);
      await sendBatch(core, e2e.conversationId, ['还能用应用吗']);
      const turnRequest = await waitFor(
        async () =>
          llm.requestsFor('mock-main').find((req) => promptOf(req).includes('还能用应用吗')) ??
          null,
        { label: 'post-disconnect turn request', timeoutMs: 20_000 },
      );
      expect(toolNamesOf(turnRequest)).not.toContain(e2e.toolName);
      expect(toolNamesOf(turnRequest)).toContain('app_request_connection');
      expect(promptOf(turnRequest)).toContain(`connection_id: ${connectionId}`);
      expect(server.toolCalls).toEqual([]);
      expect(e2e.shellCalls).toHaveLength(1);
    }, 180_000);
  },
);
