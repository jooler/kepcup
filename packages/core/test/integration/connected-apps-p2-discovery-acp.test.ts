import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppConnectFlowPayload, Approval, Bot } from '@kepcup/shared';
import {
  agentTurn,
  createTestStack,
  fakeAgentSpawner,
  isTaskRequest,
  makeBot,
  openDirect,
  sendBatch,
  simulateBrowser,
  startFakeOAuthMcpServer,
  step,
  waitFor,
  waitForRun,
  type FakeAcpAgentHandle,
  type FakeMcpTool,
  type MockChatRequest,
  type MockLlmStep,
} from '@kepcup/testkit';

import { ConnectorCatalog } from '../../src/apps/catalog.js';
import { fakeCatalogEntry, until } from '../support/catalog-connect-env.js';

/**
 * D73 P2 §6.3 / D91 on the host bridge: an external-agent Bot whose apps carry more than
 * EXTERNAL_TOOLS_INLINE_MAX tools sees only `capability_search` / `capability_call` (+ the request
 * tool) on `tools/list`; the run context carries the same decision (the `<capabilities>` rule that
 * the rest is reached through the pair, tool names spelled the way the agent sees them); a write
 * through `capability_call` raises the ordinary `mcp_tool` card for the real tool.
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

const TOOLS: FakeMcpTool[] = [
  ...Array.from({ length: 44 }, (_, i): FakeMcpTool => ({
    name: `lookup_${String(i).padStart(2, '0')}`,
    description: `Look up thing ${i}`,
    annotations: { readOnlyHint: true },
  })),
  {
    name: 'file_issue',
    description: 'Create a bug report in the tracker',
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
];

const ACCOUNT = { sub: 'acct-1', email: 'jyy@example.com' };
const isWake = (req: MockChatRequest): boolean =>
  !isTaskRequest(req) && req.lastUserText().includes('<trigger reason="task"');

async function setupEnv(
  turns: Array<ReturnType<typeof agentTurn>>,
  agentCapabilities?: string[],
  /** Also give the Bot a custom (no-auth) MCP server `open` next to the connected app. */
  withCustomMcp = false,
) {
  const fake = await startFakeOAuthMcpServer({ dcrEnabled: true, tools: TOOLS });
  cleanups.push(() => fake.stop());
  const catalog = new ConnectorCatalog({
    env: {},
    source: {
      entries: [fakeCatalogEntry({ slug: 'notes', title: 'Notes', url: fake.mcpUrl })],
      iconsDir: null,
    },
    approvedGates: null,
  });
  const started: FakeAcpAgentHandle[] = [];
  const stack = await createTestStack({
    connectorCatalog: catalog,
    shellRpc: {
      async openExternal({ url }) {
        void simulateBrowser(url).catch(() => undefined);
        return { ok: true };
      },
    },
    oauthLoopbackAllowlist: ['127.0.0.1'],
    oauthCallbackPorts: await freePorts(3),
    oauthFlowTimeoutMs: 20_000,
    toolLockTrustFirstList: false,
    agentLaunch: () => ({ command: 'in-process', args: [], env: {} }),
    agentSpawn: fakeAgentSpawner({ fake: { turns } }, started) as never,
  });
  cleanups.push(() => stack.cleanup());
  const { core, llm } = stack;
  fake.configure({ idTokenClaims: { ...ACCOUNT } });
  await core.rpc.call('settings.update', {
    experimental: { externalAgents: true },
    agents: { fake: { enabled: true } },
  });
  const flowEvents: AppConnectFlowPayload[] = [];
  core.onEvent('apps.connect_flow', (payload) => {
    flowEvents.push(payload);
    if (payload.phase === 'awaiting_consent') {
      void core.rpc.call('apps.connect.continue', { flowId: payload.flowId });
    }
  });

  if (withCustomMcp) {
    const open = await startFakeOAuthMcpServer({
      requireAuth: false,
      tools: [{ name: 'echo', description: 'Echo text back', annotations: { readOnlyHint: true } }],
    });
    cleanups.push(() => open.stop());
    await core.rpc.call('settings.update', {
      mcpServers: [
        {
          id: 'open',
          name: 'Open',
          transport: 'http',
          url: open.mcpUrl,
          auth: 'none',
          enabled: true,
          autoApprove: false,
        },
      ],
    });
    // The harness runs with the tool lock on (new tools are locked until reviewed): list the custom
    // server once and review its tool, as a user would in the extension center.
    await core.rpc.call('mcp.refreshTools', { serverId: 'open' });
    await core.rpc.call('apps.connections.reviewTools', {
      connectionId: 'custom:open',
      accept: ['echo'],
    });
  }
  const plain = await makeBot(core, '外援');
  const bot = (
    (await core.rpc.call('bots.update', {
      id: plain.id,
      profile: {
        ...plain.profile,
        runtime: {
          ...plain.profile.runtime,
          ...(withCustomMcp ? { mcp_server_ids: ['open'] } : {}),
          agent: {
            ...plain.profile.runtime.agent,
            id: 'fake',
            ...(agentCapabilities !== undefined ? { capabilities: agentCapabilities } : {}),
          },
        },
      },
    })) as { bot: Bot }
  ).bot;
  const { flowId } = (await core.rpc.call('apps.connect', {
    target: { kind: 'catalog', connectorId: 'notes' },
    grantBotId: bot.id,
  })) as { flowId: string };
  const mine = () => flowEvents.filter((e) => e.flowId === flowId);
  await until(() => mine().find((e) => e.phase === 'reviewing_tools'), 20_000, 'review');
  await core.rpc.call('apps.connect.confirmTools', { flowId });
  const done = await until(
    () => mine().find((e) => ['done', 'failed', 'cancelled'].includes(e.phase)),
    20_000,
    'done',
  );
  expect(done.phase).toBe('done');
  const connectionId = done.connectionId!;
  const conv = await openDirect(core, bot.id);
  return { fake, started, stack, core, llm, bot, conv, connectionId };
}

describe('§6.3 ACP', () => {
  it('bridge tools/list = the two discovery tools; prompt mirrors the decision; capability_call raises the real tool card', async () => {
    const { fake, started, core, llm, conv, connectionId } = await setupEnv([
      agentTurn()
        .mcpList()
        .mcpCall('s1', 'capability_search', { query: 'bug report' })
        .mcpCall('c1', 'capability_call', {
          name: 'app_notes_file_issue',
          arguments: { title: '来自外援' },
        })
        .text('记好了'),
    ]);

    const turnSteps: MockLlmStep[] = [
      step()
        .inTurn()
        .expect((req) => !isWake(req))
        .replyToolCall('start_task', () => {
          const source = core.services
            .domain!.messages.listShared(conv.id, { limit: 20 })
            .filter((message) => message.senderType === 'user')
            .at(-1)!;
          return {
            title: '处理请求',
            instruction: '把 bug 记到 Notes',
            source_message_ids: [source.id],
            writes: true,
          };
        }),
      step()
        .inTurn()
        .expect((req) => !isWake(req))
        .replyText('好的，我去处理。'),
      step().inTurn().expect(isWake).replyText('外援记好了'),
    ];
    llm.script('mock-main', turnSteps);
    await sendBatch(core, conv.id, ['把这个 bug 记到 Notes']);

    // The write goes through the same card, naming the real tool and account.
    const card = await waitFor(
      async () => {
        const list = (await core.rpc.call('approvals.list', { conversationId: conv.id })) as {
          approvals: Approval[];
        };
        return list.approvals.find((a) => a.kind === 'mcp_tool' && a.status === 'pending') ?? null;
      },
      { label: 'mcp_tool card from capability_call', timeoutMs: 30_000 },
    );
    expect(card.payload).toMatchObject({
      serverName: 'Notes',
      toolName: 'file_issue',
      risk: 'write',
      connectionId,
      accountLabel: ACCOUNT.email,
    });
    await core.rpc.call('approvals.decide', { id: card.id, approve: true, duration: 'once' });
    const task = await waitForRun(core, conv.id, 'completed', {
      loopType: 'task',
      timeoutMs: 60_000,
    });
    expect(fake.toolCalls.map((c) => c.name)).toEqual(['file_issue']);

    const observed = started[0]!.observed;
    const listed = (
      observed.mcp.find((e) => e.method === 'tools/list')!.result as Array<{ name: string }>
    ).map((t) => t.name);
    expect(listed).toContain('capability_search');
    expect(listed).toContain('capability_call');
    expect(listed).toContain('app_request_connection');
    expect(listed.some((n) => n.startsWith('app_notes_'))).toBe(false);
    for (const name of listed)
      expect(`mcp__kepcup_xxxxxxxx__${name}`.length).toBeLessThanOrEqual(64);

    const prompt = observed.prompts[0]!.text;
    expect(prompt).toContain('<capabilities>');
    expect(prompt).toContain('- app:notes（Notes，账号');
    expect(prompt).toContain('其余能力的工具没有逐个列出');
    expect(prompt).toMatch(/mcp__kepcup_[0-9a-f]{8}__capability_search/);
    expect(prompt).toMatch(/mcp__kepcup_[0-9a-f]{8}__capability_call/);
    expect(prompt).not.toContain('app_notes_ 开头');

    // Steps are attributed to a pack that owns the pair (shared by mcp and apps; the first
    // registered one is reported); the dispatcher result carries the real tool's output.
    const steps = (await core.rpc.call('runs.steps', { runId: task.id })) as {
      steps: Array<{ type: string; payload: Record<string, unknown> }>;
    };
    expect(steps.steps.filter((s) => s.type === 'tool_call').map((s) => s.payload)).toMatchObject([
      { toolName: 'capability_search', capability: 'mcp' },
      { toolName: 'capability_call', capability: 'mcp' },
    ]);
  }, 120_000);

  it('D91: a Bot whose agent selects only the mcp pack never resolves (or sees) the connected app', async () => {
    const { fake, started, core, llm, conv } = await setupEnv(
      [agentTurn().mcpList().text('好')],
      ['core', 'mcp'],
    );
    const requestsBefore = fake.requests.length;
    llm.script('mock-main', [
      step()
        .inTurn()
        .expect((req) => !isWake(req))
        .replyToolCall('start_task', () => {
          const source = core.services
            .domain!.messages.listShared(conv.id, { limit: 20 })
            .filter((message) => message.senderType === 'user')
            .at(-1)!;
          return {
            title: '看看',
            instruction: '看看能用什么',
            source_message_ids: [source.id],
            writes: false,
          };
        }),
      step()
        .inTurn()
        .expect((req) => !isWake(req))
        .replyText('好的，我去处理。'),
      step().inTurn().expect(isWake).replyText('看完了'),
    ]);
    await sendBatch(core, conv.id, ['看看你能用什么']);
    await waitForRun(core, conv.id, 'completed', { loopType: 'task', timeoutMs: 60_000 });
    const listed = (
      started[0]!.observed.mcp.find((e) => e.method === 'tools/list')!.result as Array<{
        name: string;
      }>
    ).map((t) => t.name);
    expect(listed.some((n) => n.startsWith('app_') || n.startsWith('capability_'))).toBe(false);
    // The app server was not even asked for its tools: no pack, no scope.
    expect(fake.requests.length).toBe(requestsBefore);
    // D91 n2: the run context lists only the capabilities the selected packs can reach — the app
    // the agent has no pack for is not advertised (and so is not asked about).
    const prompt = started[0]!.observed.prompts[0]!.text;
    expect(prompt).not.toContain('其余能力的工具没有逐个列出');
    expect(prompt).not.toContain('app:notes');
    expect(prompt).not.toContain('<capabilities>');
  }, 120_000);

  /** One `capability_search` over everything the pair can see; returns the observed bridge state. */
  async function mixedRun(agentCapabilities: string[]) {
    const { started, core, llm, conv } = await setupEnv(
      [agentTurn().mcpList().mcpCall('s1', 'capability_search', { query: '' }).text('查完了')],
      agentCapabilities,
      true,
    );
    llm.script('mock-main', [
      step()
        .inTurn()
        .expect((req) => !isWake(req))
        .replyToolCall('start_task', () => {
          const source = core.services
            .domain!.messages.listShared(conv.id, { limit: 20 })
            .filter((message) => message.senderType === 'user')
            .at(-1)!;
          return {
            title: '盘点',
            instruction: '盘点能用的工具',
            source_message_ids: [source.id],
            writes: false,
          };
        }),
      step()
        .inTurn()
        .expect((req) => !isWake(req))
        .replyText('好的，我去处理。'),
      step().inTurn().expect(isWake).replyText('盘点完了'),
    ]);
    await sendBatch(core, conv.id, ['盘点一下你能用的工具']);
    await waitForRun(core, conv.id, 'completed', { loopType: 'task', timeoutMs: 60_000 });
    const observed = started[0]!.observed;
    const search = observed.mcp.find(
      (call) => call.method === 'tools/call' && call.tool === 'capability_search',
    );
    return {
      searchText: JSON.stringify(search?.result ?? null),
      prompt: observed.prompts[0]!.text,
      listed: (
        observed.mcp.find((e) => e.method === 'tools/list')!.result as Array<{ name: string }>
      ).map((t) => t.name),
    };
  }

  it('D91 m4: a Bot with an app and a custom MCP — the mcp pack alone indexes only mcp:*, the apps pack alone only the app', async () => {
    const mcpOnly = await mixedRun(['core', 'mcp']);
    expect(mcpOnly.listed).toContain('capability_search');
    expect(mcpOnly.searchText).toContain('mcp_open_echo');
    expect(mcpOnly.searchText).not.toContain('app_notes_');
    expect(mcpOnly.prompt).toContain('- mcp:open（Open）');
    expect(mcpOnly.prompt).not.toContain('app:notes');
  }, 120_000);

  it('D91 m4: ...and the apps pack alone is the mirror image', async () => {
    const appsOnly = await mixedRun(['core', 'apps']);
    expect(appsOnly.listed).toContain('capability_search');
    expect(appsOnly.searchText).toContain('app_notes_');
    expect(appsOnly.searchText).not.toContain('mcp_open_');
    expect(appsOnly.prompt).toContain('- app:notes（Notes');
    expect(appsOnly.prompt).not.toContain('mcp:open');
  }, 120_000);
});
