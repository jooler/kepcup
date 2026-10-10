import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AppConnectFlowPayload, Message } from '@kepcup/shared';
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
import { fakeCatalogEntry, until } from './catalog-connect-env.js';

/**
 * An OAuth-backed catalog connection ("Notes") whose tool `show_dashboard` produces an MCP App card
 * and which has an app-only read tool `refresh` and an app-only write tool `save`
 * (D73 P3 §7.5 — used by the UI-initiated approval tests).
 */

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

export interface CatalogUiEnv {
  stack: TestStack;
  fake: FakeOAuthMcpServer;
  botId: string;
  conversationId: string;
  connectionId: string;
  card: Message;
  cleanup(): Promise<void>;
}

export async function startCatalogUiEnv(): Promise<CatalogUiEnv> {
  const fake = await startFakeOAuthMcpServer({
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
        text: '<!doctype html><html><body>notes dashboard</body></html>',
      },
    ],
  });
  const catalog = new ConnectorCatalog({
    env: {},
    source: {
      entries: [fakeCatalogEntry({ slug: 'notes', title: 'Notes', url: fake.mcpUrl })],
      iconsDir: null,
    },
    approvedGates: null,
  });
  const stack = await createTestStack({
    connectorCatalog: catalog,
    shellRpc: {
      async openExternal({ url }) {
        if (/\/authorize/.test(url)) void simulateBrowser(url).catch(() => undefined);
        return { ok: true };
      },
    },
    oauthLoopbackAllowlist: ['127.0.0.1'],
    oauthCallbackPorts: await freePorts(3),
    oauthFlowTimeoutMs: 20_000,
  });
  const { core, llm } = stack;
  fake.configure({ idTokenClaims: { sub: 'acct-ui', email: 'ui@example.com' } });
  const bot = await makeBot(core, '小界面');
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
  if (done.phase !== 'done') throw new Error('catalog connect failed');
  const conv = await openDirect(core, bot.id);
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
      const { messages } = (await core.rpc.call('messages.list', { conversationId: conv.id })) as {
        messages: Message[];
      };
      return (
        messages.find((m) => (m.content as { cardType?: string }).cardType === 'mcp_app') ?? null
      );
    },
    { label: 'mcp_app card', timeoutMs: 30_000 },
  );
  return {
    stack,
    fake,
    botId: bot.id,
    conversationId: conv.id,
    connectionId: done.connectionId!,
    card,
    async cleanup() {
      await stack.cleanup();
      await fake.stop();
    },
  };
}
