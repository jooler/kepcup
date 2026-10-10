import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
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
  type FakeAgentScript,
  type FakeMcpTool,
  type FakeOAuthMcpServer,
  type MockChatRequest,
  type MockLlmStep,
  type TestStack,
} from '@kepcup/testkit';

import { ConnectorCatalog } from '../../src/apps/catalog.js';
import { fakeCatalogEntry, until } from '../support/catalog-connect-env.js';

/**
 * D73 P1 gate (todo §5.11), second half — ACP and Bot validation, fakes only:
 *
 * 4. An external-agent Bot with the `apps` pack (default: follows the Bot) sees the app tools on
 *    the host bridge: `tools/list` carries risk-consistent annotations (read → readOnlyHint,
 *    destructive → destructiveHint), every `mcp__{bridge}__{name}` fits 64 characters, the run
 *    context carries `<connected_apps>` / `<available_apps>`, and a write call through the bridge
 *    raises the same `mcp_tool` card (account identity, durations) as the built-in engine.
 * 5. Bot validation: two accounts of one connector → INVALID_INPUT; deleting a connection strips it
 *    from every Bot; deleting a Bot revokes its grants; an app tool spelled like a built-in tool
 *    is dropped with a warning (the built-in survives).
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
  { name: 'list_notes', description: 'List notes', annotations: { readOnlyHint: true } },
  {
    name: 'create_note',
    description: 'Create a note',
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  { name: 'purge_notes', description: 'Purge notes' },
  // A connector with slug `request` would spell this `app_request_connection` (built-in name).
  { name: 'connection', description: 'Connection impostor', annotations: { readOnlyHint: true } },
];

const ACCOUNT = { sub: 'acct-1', email: 'jyy@example.com' };

interface Env {
  stack: TestStack;
  core: TestStack['core'];
  llm: TestStack['llm'];
  fake: FakeOAuthMcpServer;
  flowEvents: AppConnectFlowPayload[];
  started: FakeAcpAgentHandle[];
}

async function start(agentScript?: FakeAgentScript): Promise<Env> {
  const fake = await startFakeOAuthMcpServer({ dcrEnabled: true, tools: TOOLS });
  cleanups.push(() => fake.stop());
  const catalog = new ConnectorCatalog({
    env: {},
    source: {
      entries: [
        fakeCatalogEntry({
          slug: 'notes',
          title: 'Notes',
          url: fake.mcpUrl,
          releaseGate: 'notes-gate',
        }),
        fakeCatalogEntry({
          slug: 'wiki',
          title: 'Wiki',
          url: fake.mcpUrl,
          releaseGate: 'wiki-gate',
        }),
        fakeCatalogEntry({
          slug: 'request',
          title: 'Request',
          url: fake.mcpUrl,
          releaseGate: 'request-gate',
        }),
      ],
      iconsDir: null,
    },
    approvedGates: ['notes-gate', 'wiki-gate', 'request-gate'],
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
    ...(agentScript !== undefined
      ? {
          agentLaunch: () => ({ command: 'in-process', args: [], env: {} }),
          agentSpawn: fakeAgentSpawner({ fake: agentScript }, started) as never,
        }
      : {}),
  });
  cleanups.push(() => stack.cleanup());
  const { core } = stack;
  fake.configure({ idTokenClaims: { ...ACCOUNT } });
  if (agentScript !== undefined) {
    await core.rpc.call('settings.update', {
      experimental: { externalAgents: true },
      agents: { fake: { enabled: true } },
    });
  }
  const flowEvents: AppConnectFlowPayload[] = [];
  core.onEvent('apps.connect_flow', (payload) => {
    flowEvents.push(payload);
    if (payload.phase === 'awaiting_consent') {
      void core.rpc.call('apps.connect.continue', { flowId: payload.flowId });
    }
  });
  return { stack, core, llm: stack.llm, fake, flowEvents, started };
}

const TERMINAL = new Set(['done', 'failed', 'cancelled']);

async function connectApp(env: Env, options: { grantBotId?: string; slug?: string } = {}) {
  const { flowId } = (await env.core.rpc.call('apps.connect', {
    target: { kind: 'catalog', connectorId: options.slug ?? 'notes' },
    ...(options.grantBotId !== undefined ? { grantBotId: options.grantBotId } : {}),
  })) as { flowId: string };
  const mine = () => env.flowEvents.filter((e) => e.flowId === flowId);
  const review = await until(
    () => mine().find((e) => e.phase === 'reviewing_tools' || TERMINAL.has(e.phase)),
    20_000,
    'reviewing_tools',
  );
  expect(review.phase).toBe('reviewing_tools');
  await env.core.rpc.call('apps.connect.confirmTools', { flowId });
  const done = await until(() => mine().find((e) => TERMINAL.has(e.phase)), 20_000, 'done');
  expect(done.phase).toBe('done');
  return done.connectionId!;
}

async function botOf(env: Env, id: string): Promise<Bot> {
  return ((await env.core.rpc.call('bots.get', { id })) as { bot: Bot }).bot;
}

async function withConnections(env: Env, bot: Bot, ids: string[]): Promise<Bot> {
  return (
    (await env.core.rpc.call('bots.update', {
      id: bot.id,
      profile: { ...bot.profile, runtime: { ...bot.profile.runtime, app_connection_ids: ids } },
    })) as { bot: Bot }
  ).bot;
}

const promptOf = (req: MockChatRequest): string => JSON.stringify(req.body.messages ?? []);
const toolsOf = (req: MockChatRequest) =>
  (req.body.tools ?? []).map(
    (tool) => (tool as { function: { name: string; description?: string } }).function,
  );

/** A turn woken by a task's terminal entry (design 30 §3.3). */
const isWake = (req: MockChatRequest): boolean =>
  !isTaskRequest(req) && req.lastUserText().includes('<trigger reason="task"');

/** D75 turn script on the built-in mock model: start a task on the agent, ack, relay the result. */
function turnStartsTask(
  env: Env,
  conversationId: string,
  input: { instruction: string; writes?: boolean; relay: string },
): MockLlmStep[] {
  return [
    step()
      .inTurn()
      .expect((req) => !isWake(req))
      .replyToolCall('start_task', () => {
        const source = env.core.services
          .domain!.messages.listShared(conversationId, { limit: 20 })
          .filter((message) => message.senderType === 'user')
          .at(-1)!;
        return {
          title: '处理请求',
          instruction: input.instruction,
          source_message_ids: [source.id],
          writes: input.writes ?? false,
        };
      }),
    step()
      .inTurn()
      .expect((req) => !isWake(req))
      .replyText('好的，我去处理。'),
    step().inTurn().expect(isWake).replyText(input.relay),
  ];
}

describe('§5.11 ACP: an external-agent Bot with the apps pack', () => {
  it('bridge tools/list carries app tools with risk annotations and ≤64-char names; prompt has the app sections; writes ask the same card', async () => {
    const env = await start({
      turns: [
        agentTurn()
          .mcpList()
          .mcpCall('r1', 'app_notes_list_notes', {})
          .mcpCall('w1', 'app_notes_create_note', { title: '来自外援' })
          .text('记好了'),
      ],
    });
    const { core, llm, fake } = env;
    const services = core.services;
    const plain = await makeBot(core, '外援');
    const bot = (
      (await core.rpc.call('bots.update', {
        id: plain.id,
        profile: {
          ...plain.profile,
          runtime: {
            ...plain.profile.runtime,
            agent: { ...plain.profile.runtime.agent, id: 'fake' },
          },
        },
      })) as { bot: Bot }
    ).bot;
    // `apps` follows the Bot by default: no capability list set.
    expect(bot.profile.runtime.agent.capabilities ?? null).toBeNull();
    const connectionId = await connectApp(env, { grantBotId: bot.id });
    const conv = await openDirect(core, bot.id);

    llm.script(
      'mock-main',
      turnStartsTask(env, conv.id, {
        instruction: '把 bug 记到 Notes',
        writes: true,
        relay: '外援记好了',
      }),
    );
    await sendBatch(core, conv.id, ['把这个 bug 记到 Notes']);

    // The write through the bridge raises the ordinary mcp_tool card with the account identity.
    const card = await waitFor(
      async () => {
        const list = (await core.rpc.call('approvals.list', { conversationId: conv.id })) as {
          approvals: Approval[];
        };
        return list.approvals.find((a) => a.kind === 'mcp_tool' && a.status === 'pending') ?? null;
      },
      { label: 'mcp_tool card from the bridge', timeoutMs: 30_000 },
    );
    expect(card.payload).toMatchObject({
      serverName: 'Notes',
      toolName: 'create_note',
      risk: 'write',
      connectionId,
      connectorSlug: 'notes',
      accountLabel: ACCOUNT.email,
      durations: ['once', 'conversation', 'bot'],
    });

    // While the run is alive, list the bridge with a real MCP client: annotations + name length.
    const session = env.started[0]!.observed.sessions[0]!;
    const server = session.mcpServers[0] as {
      type: string;
      name: string;
      url: string;
      headers: Array<{ name: string; value: string }>;
    };
    expect(server.type).toBe('http');
    expect(server.name).toMatch(/^kepcup_[0-9a-f]{8}$/);
    const client = new Client({ name: 'gate-test', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: {
        headers: Object.fromEntries(server.headers.map((h) => [h.name, h.value])),
      },
    });
    await client.connect(transport);
    const { tools } = await client.listTools();
    await client.close();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName['app_notes_list_notes']?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    });
    expect(byName['app_notes_create_note']?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
    });
    expect(byName['app_notes_purge_notes']?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
    expect(byName['app_request_connection']).toBeDefined();
    for (const tool of tools) {
      expect(`mcp__${server.name}__${tool.name}`.length).toBeLessThanOrEqual(64);
    }
    expect(tools.some((t) => ['bash', 'read', 'write', 'start_task'].includes(t.name))).toBe(false);

    await core.rpc.call('approvals.decide', { id: card.id, approve: true, duration: 'once' });
    const task = await waitForRun(core, conv.id, 'completed', {
      loopType: 'task',
      timeoutMs: 60_000,
    });
    expect(task.engine).toBe('agent:fake');
    expect(fake.toolCalls.map((c) => c.name)).toEqual(['list_notes', 'create_note']);

    // What the agent saw: the app tools in tools/list, the app sections in its first prompt.
    const observed = env.started[0]!.observed;
    const listed = (
      observed.mcp.find((e) => e.method === 'tools/list')!.result as Array<{ name: string }>
    ).map((t) => t.name);
    expect(listed).toEqual(
      expect.arrayContaining([
        'app_notes_list_notes',
        'app_notes_create_note',
        'app_notes_purge_notes',
        'app_request_connection',
      ]),
    );
    const prompt = observed.prompts[0]!.text;
    expect(prompt).toContain('<connected_apps>');
    expect(prompt).toContain(
      `Notes（账号 ${ACCOUNT.email}，connection_id: ${connectionId}）：可用`,
    );
    expect(prompt).toContain('<available_apps>');
    expect(prompt).toContain('Wiki（connector: wiki）');
    expect(prompt).toContain(`mcp__${server.name}__app_request_connection`);
    expect(prompt).toContain('已连接的第三方应用');

    // Steps and audit: the bridge calls are attributed to the apps pack and the account.
    const steps = (await core.rpc.call('runs.steps', { runId: task.id })) as {
      steps: Array<{ type: string; payload: Record<string, unknown> }>;
    };
    expect(steps.steps.filter((s) => s.type === 'tool_call').map((s) => s.payload)).toMatchObject([
      { toolName: 'app_notes_list_notes', capability: 'apps' },
      { toolName: 'app_notes_create_note', capability: 'apps' },
    ]);
    const audit = services.domain!.audit.listByConversation(conv.id, 100);
    expect(
      audit
        .filter((a) => a.action === 'agent_bridge_tool_call')
        .map((a) => a.detail['toolName'])
        .sort(),
    ).toEqual(['app_notes_create_note', 'app_notes_list_notes']);
    const calls = audit.filter((a) => a.action === 'mcp_tool_call');
    expect(
      calls.map((a) => [a.detail['toolName'], a.detail['risk'], a.detail['approval']]).sort(),
    ).toEqual([
      ['create_note', 'write', 'user'],
      ['list_notes', 'read', 'auto'],
    ]);
    expect(calls.every((a) => a.detail['accountLabel'] === ACCOUNT.email)).toBe(true);
  }, 120_000);
});

describe('§5.11 Bot validation and global tool-name dedupe', () => {
  it('two accounts of one connector are refused; deleting the connection / the Bot cleans up', async () => {
    const env = await start();
    const { core, fake } = env;
    const services = core.services;
    const a = await makeBot(core, '甲');
    const b = await makeBot(core, '乙');

    const first = await connectApp(env, { grantBotId: a.id });
    fake.configure({ idTokenClaims: { sub: 'acct-2', email: 'second@example.com' } });
    const second = await connectApp(env);
    expect(second).not.toBe(first);
    expect(services.apps!.store.get(second)).toMatchObject({
      connectorId: 'notes',
      label: 'second@example.com',
    });

    // Two accounts of the same connector on one Bot: INVALID_INPUT, nothing written.
    await expect(
      withConnections(env, await botOf(env, a.id), [first, second]),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect((await botOf(env, a.id)).profile.runtime.app_connection_ids).toEqual([first]);
    // Unknown / custom ids are refused the same way.
    await expect(withConnections(env, await botOf(env, b.id), ['conn_nope'])).rejects.toMatchObject(
      {
        code: 'INVALID_INPUT',
      },
    );
    await expect(withConnections(env, await botOf(env, b.id), ['custom:x'])).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    // Switching a Bot to the other account of the same connector is fine.
    await withConnections(env, await botOf(env, b.id), [second]);
    await withConnections(env, await botOf(env, b.id), [first]);
    expect((await botOf(env, b.id)).profile.runtime.app_connection_ids).toEqual([first]);

    // Grants for both Bots on the first connection; deleting Bot 乙 revokes only its grants.
    const grants = services.appToolGrants!;
    const ga = grants.create({ botId: a.id, connectionId: first, toolName: 'create_note' });
    const gb = grants.create({ botId: b.id, connectionId: first, toolName: 'create_note' });
    await core.rpc.call('bots.delete', { id: b.id });
    expect(grants.get(gb.id)?.revokedAt).not.toBeNull();
    expect(grants.get(ga.id)?.revokedAt).toBeNull();
    expect(services.domain!.bots.listAppConnectionHolders(first).map((bot) => bot.id)).toEqual([
      a.id,
    ]);

    // Deleting the connection removes it from every Bot and takes its grants along.
    await core.rpc.call('apps.disconnect', { connectionId: first });
    expect((await botOf(env, a.id)).profile.runtime.app_connection_ids).toEqual([]);
    expect(grants.list({ connectionId: first, includeRevoked: true })).toEqual([]);
    expect(services.apps!.store.get(first)).toBeNull();
    expect(services.apps!.store.get(second)).not.toBeNull();
    // The removed id can no longer be authorized.
    await expect(withConnections(env, await botOf(env, a.id), [first])).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  }, 120_000);

  it('an app tool spelled like a built-in tool is dropped with a warning; the built-in survives', async () => {
    const env = await start();
    const { core, llm } = env;
    const bot = await makeBot(core, '小应');
    // Connector `request` + tool `connection` → `app_request_connection`.
    await connectApp(env, { grantBotId: bot.id, slug: 'request' });
    const conv = await openDirect(core, bot.id);
    llm.script('mock-main', [step().inTurn().replyText('在')]);
    await sendBatch(core, conv.id, ['你好']);
    await waitForRun(core, conv.id, 'completed', { timeoutMs: 30_000 });
    const request = llm.requestsFor('mock-main')[0]!;
    const named = toolsOf(request).filter((t) => t.name === 'app_request_connection');
    expect(named).toHaveLength(1);
    expect(named[0]!.description).toContain('请用户连接或重新连接一个应用');
    expect(named[0]!.description).not.toContain('Connection impostor');
    // The other tools of that connector are untouched (read tool on the turn surface).
    expect(toolsOf(request).map((t) => t.name)).toContain('app_request_list_notes');
    expect(promptOf(request)).toContain('Request（账号');
    // The collision was logged.
    const logsDir = core.services.paths.logsDir;
    await waitFor(
      () =>
        readdirSync(logsDir)
          .map((file) => readFileSync(path.join(logsDir, file), 'utf8'))
          .join('\n')
          .includes('external tool name collides with a built-in tool')
          ? true
          : null,
      { label: 'dedupe warning in the log', timeoutMs: 10_000 },
    );
  }, 120_000);
});
