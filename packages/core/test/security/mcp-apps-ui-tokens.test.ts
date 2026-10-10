import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RPC_EVENT_NAMES,
  type AppConnectFlowPayload,
  type Approval,
  type Message,
} from '@kepcup/shared';
import {
  createTestStack,
  makeBot,
  openDirect,
  sendBatch,
  simulateBrowser,
  startFakeOAuthMcpServer,
  step,
  viaTask,
  waitFor,
  waitForRun,
  type FakeOAuthMcpServer,
  type TestStack,
} from '@kepcup/testkit';
import { ConnectorCatalog } from '../../src/apps/catalog.js';
import { fakeCatalogEntry, until } from '../support/catalog-connect-env.js';

/**
 * D73 P3 §7.5 security gate (MCP Apps, OAuth-backed catalog connection): everything that crosses the
 * UI boundary — the card message, `apps.ui.open`, the page and CSP header the protocol handler serves,
 * UI-initiated tool-call results, link results, events — never contains the connection's access /
 * refresh / id tokens, while the control proves the tokens did travel to the MCP server.
 */

const cleanups: Array<() => Promise<void> | void> = [];
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

const PAGE =
  '<!doctype html><html><body><h1>notes dashboard</h1><script>window.x=1</script></body></html>';

describe('MCP Apps UI boundary: no tokens', () => {
  it('card, open output, served page, UI tool results, link results and events carry no token', async () => {
    const fake: FakeOAuthMcpServer = await startFakeOAuthMcpServer({
      dcrEnabled: true,
      tools: [
        {
          name: 'show_dashboard',
          description: 'Dashboard',
          annotations: { readOnlyHint: true },
          _meta: { ui: { resourceUri: 'ui://notes/dashboard.html' } },
        },
        {
          name: 'refresh',
          description: 'App-only refresh',
          annotations: { readOnlyHint: true },
          _meta: { ui: { visibility: ['app'] } },
          // A (hostile) tool echoing the credential it was called with: the fake server knows it.
          handler: (_args, ctx) => `refreshed with ${ctx.token === null ? 'no token' : 'a token'}`,
        },
        {
          name: 'save',
          description: 'App-only write',
          annotations: { readOnlyHint: false, destructiveHint: false },
          _meta: { ui: { visibility: ['app'] } },
        },
      ],
      resources: [
        {
          uri: 'ui://notes/dashboard.html',
          name: 'dashboard',
          mimeType: 'text/html;profile=mcp-app',
          text: PAGE,
          contentMeta: { ui: { csp: { connectDomains: ['https://api.notes.example.com'] } } },
        },
      ],
    });
    cleanups.push(() => fake.stop());
    const catalog = new ConnectorCatalog({
      env: {},
      source: {
        entries: [fakeCatalogEntry({ slug: 'notes', title: 'Notes', url: fake.mcpUrl })],
        iconsDir: null,
      },
      approvedGates: null,
    });
    const opened: string[] = [];
    const stack: TestStack = await createTestStack({
      connectorCatalog: catalog,
      shellRpc: {
        async openExternal({ url }) {
          if (/\/authorize/.test(url)) void simulateBrowser(url).catch(() => undefined);
          else opened.push(url);
          return { ok: true };
        },
      },
      oauthLoopbackAllowlist: ['127.0.0.1'],
      oauthCallbackPorts: await freePorts(3),
      oauthFlowTimeoutMs: 20_000,
    });
    cleanups.push(() => stack.cleanup());
    const { core, llm } = stack;
    const services = core.services;
    fake.configure({ idTokenClaims: { sub: 'acct-ui', email: 'ui@example.com' } });
    const bot = await makeBot(core, '小界面');

    const events: string[] = [];
    for (const name of RPC_EVENT_NAMES) {
      services.events.on(
        name as never,
        ((payload: unknown) => {
          events.push(`${name} ${JSON.stringify(payload)}`);
        }) as never,
      );
    }
    const flows: AppConnectFlowPayload[] = [];
    core.onEvent('apps.connect_flow', (payload) => flows.push(payload));
    const { flowId } = (await core.rpc.call('apps.connect', {
      target: { kind: 'catalog', connectorId: 'notes' },
      grantBotId: bot.id,
    })) as { flowId: string };
    const mine = () => flows.filter((e) => e.flowId === flowId);
    const first = await until(
      () => mine().find((e) => ['reviewing_tools', 'done', 'failed'].includes(e.phase)),
      20_000,
      'review or done',
    );
    if (first.phase === 'reviewing_tools')
      await core.rpc.call('apps.connect.confirmTools', { flowId });
    const done = await until(
      () => mine().find((e) => ['done', 'failed'].includes(e.phase)),
      20_000,
      'done',
    );
    expect(done.phase).toBe('done');
    const connectionId = done.connectionId!;
    const conv = await openDirect(core, bot.id);

    // The bot calls the app's tool; a card appears.
    llm.script(
      'mock-main',
      viaTask({
        writes: false,
        taskSteps: [step().replyToolCall('app_notes_show_dashboard', {}), step().replyText('完成')],
        relay: '好了',
      }),
    );
    await sendBatch(core, conv.id, ['显示看板']);
    await waitForRun(core, conv.id, 'completed', { loopType: 'task', timeoutMs: 60_000 });
    const card = await waitFor(
      async () => {
        const { messages } = (await core.rpc.call('messages.list', {
          conversationId: conv.id,
        })) as {
          messages: Message[];
        };
        return (
          messages.find((m) => (m.content as { cardType?: string }).cardType === 'mcp_app') ?? null
        );
      },
      { label: 'mcp_app card', timeoutMs: 30_000 },
    );

    const crossed: string[] = [JSON.stringify(card)];
    const out = (await core.rpc.call('apps.ui.open', { messageId: card.id })) as {
      resourceId: string;
      url: string;
    };
    crossed.push(JSON.stringify(out));
    const host = out.url.split('/')[2]!;
    const page = services.appUi!.resource({ resourceId: out.resourceId, host });
    crossed.push(page.html, page.csp);
    expect(page.html).toContain('notes dashboard');
    expect(page.csp).toContain('connect-src https://api.notes.example.com;');

    const refreshed = await core.rpc.call('apps.ui.callTool', {
      resourceId: out.resourceId,
      toolName: 'refresh',
      arguments: {},
    });
    crossed.push(JSON.stringify(refreshed));
    expect(JSON.stringify(refreshed)).toContain('refreshed with a token');

    // A write from the UI raises the normal card (account identity on it), approving runs it.
    const pendingSave = core.rpc.call('apps.ui.callTool', {
      resourceId: out.resourceId,
      toolName: 'save',
      arguments: { text: 'x' },
    });
    const approval = await waitFor(
      async () => {
        const list = (await core.rpc.call('approvals.list', { conversationId: conv.id })) as {
          approvals: Approval[];
        };
        return list.approvals.find((a) => a.kind === 'mcp_tool' && a.status === 'pending') ?? null;
      },
      { label: 'mcp_tool card', timeoutMs: 30_000 },
    );
    expect(approval.payload).toMatchObject({
      toolName: 'save',
      connectionId,
      connectorSlug: 'notes',
      accountLabel: 'ui@example.com',
      risk: 'write',
      // The app's data was read in this conversation: the shared egress rule applies to UI calls too.
      tainted: true,
    });
    crossed.push(JSON.stringify(approval));
    await core.rpc.call('approvals.decide', { id: approval.id, approve: true });
    crossed.push(JSON.stringify(await pendingSave));

    crossed.push(
      JSON.stringify(
        await core.rpc.call('apps.ui.openLink', {
          resourceId: out.resourceId,
          url: 'https://example.com/help',
        }),
      ),
    );
    expect(opened).toEqual(['https://example.com/help']);

    // --- the scan -------------------------------------------------------------------------
    const tokens = services.apps!.vault.getTokens(connectionId);
    expect(tokens).not.toBeNull();
    const secrets = [
      tokens!.accessToken,
      tokens!.refreshToken,
      ...fake.issuedIdTokens,
      'fake-signature',
    ].filter((value): value is string => typeof value === 'string' && value.length > 0);
    expect(secrets.length).toBeGreaterThanOrEqual(2);
    const haystacks = [...crossed, ...events];
    const leaks: string[] = [];
    for (const secret of secrets) {
      for (const [index, text] of haystacks.entries()) {
        if (text.includes(secret)) leaks.push(`#${index}: ${secret.slice(0, 10)}…`);
      }
    }
    expect(leaks).toEqual([]);
    expect(JSON.stringify(haystacks).toLowerCase()).not.toContain('bearer ');
    // Controls: the MCP server really received the credential on the wire (resources/read and the
    // UI-initiated calls included), and the UI path reached it as the account.
    const withToken = fake.mcpRequests.filter((request) => request.token !== null);
    expect(withToken.some((request) => request.rpcMethods.includes('resources/read'))).toBe(true);
    expect(
      fake.toolCalls.filter((call) => call.name === 'refresh' && call.token !== null),
    ).toHaveLength(1);
    expect(fake.toolCalls.filter((call) => call.name === 'save')).toHaveLength(1);
  }, 180_000);
});
