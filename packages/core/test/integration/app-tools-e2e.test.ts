import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppConnectFlowPayload, Approval } from '@kepcup/shared';
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
  type FakeMcpTool,
  type FakeOAuthMcpServer,
  type MockChatRequest,
  type TestStack,
} from '@kepcup/testkit';

import { ConnectorCatalog } from '../../src/apps/catalog.js';
import { fakeCatalogEntry, until } from '../support/catalog-connect-env.js';

/**
 * D73 P1 §5.6/§5.7 through the real orchestrator (fakes only): a Bot authorized for a catalog
 * connection gets `app_{slug}_{tool}` tools (approved ones only), reads run freely, writes ask
 * with the account identity and 3 durations, destructive calls ask with full parameters and only
 * "once", a standing grant skips the card, the read-only turn surface keeps only read tools, an
 * expired connection withdraws every tool, and unattended mode approves + audits with identity.
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
  {
    name: 'delete_all',
    description: 'Delete everything',
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
];

interface Env {
  stack: TestStack;
  fake: FakeOAuthMcpServer;
  botId: string;
  conversationId: string;
  connectionId: string;
}

async function start(): Promise<Env> {
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
  });
  cleanups.push(() => stack.cleanup());
  const { core } = stack;
  fake.configure({ idTokenClaims: { sub: 'acct-1', email: 'jyy@example.com' } });
  const bot = await makeBot(core, '小应');
  const events: AppConnectFlowPayload[] = [];
  core.onEvent('apps.connect_flow', (payload) => events.push(payload));
  const { flowId } = (await core.rpc.call('apps.connect', {
    target: { kind: 'catalog', connectorId: 'notes' },
    grantBotId: bot.id,
  })) as { flowId: string };
  const mine = () => events.filter((e) => e.flowId === flowId);
  // The test stack trusts the first tool list (no review step); confirm one if it does appear.
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
  // These tests are about naming, risk tiers and standing grants. Reading app data taints the
  // (bot, conversation) and a taint turns a grant-covered write into an `egress` card (D73 P2 §6.2,
  // covered by connected-apps-p2-egress.test.ts), so the harness switches the guard off.
  await core.rpc.call('settings.update', { apps: { taintGuard: false } });
  const conv = await openDirect(core, bot.id);
  return { stack, fake, botId: bot.id, conversationId: conv.id, connectionId: done.connectionId! };
}

const promptOf = (req: MockChatRequest): string => JSON.stringify(req.body.messages ?? []);
const toolNamesOf = (req: MockChatRequest): string[] =>
  (req.body.tools ?? []).map(
    (tool) => (tool as { function?: { name?: string } }).function?.name ?? '',
  );

async function pendingCard(env: Env): Promise<Approval> {
  return waitFor(
    async () => {
      const list = (await env.stack.core.rpc.call('approvals.list', {
        conversationId: env.conversationId,
      })) as { approvals: Approval[] };
      return list.approvals.find((a) => a.kind === 'mcp_tool' && a.status === 'pending') ?? null;
    },
    { label: 'mcp_tool card', timeoutMs: 30_000 },
  );
}

async function resultOf(env: Env, runId: string, toolName: string) {
  const steps = (
    (await env.stack.core.rpc.call('runs.steps', { runId })) as {
      steps: Array<{ type: string; payload: Record<string, unknown> }>;
    }
  ).steps;
  return steps.filter((s) => s.type === 'tool_result' && s.payload['toolName'] === toolName);
}

const taskOf = (env: Env, steps: ReturnType<typeof step>[], relay = '好了') =>
  viaTask({ writes: true, taskSteps: steps, relay });

describe('exposure and approvals', () => {
  it('names the tools app_{slug}_{tool}; reads run free; writes ask with identity + 3 durations; "bot" grants stop the card', async () => {
    const env = await start();
    const { core, llm } = env.stack;
    llm.script('mock-main', [
      ...taskOf(env, [
        step()
          .expect((req) => toolNamesOf(req).includes('app_notes_create_note'))
          .replyToolCall('app_notes_list_notes', {}),
        step().replyToolCall('app_notes_create_note', { title: '第一条' }),
        step().replyToolCall('app_notes_create_note', { title: '第二条' }),
        step().replyText('完成'),
      ]),
    ]);
    await sendBatch(core, env.conversationId, ['记两条笔记']);

    // The write asks: identity line data + the three durations.
    const card = await pendingCard(env);
    expect(card.payload).toMatchObject({
      serverName: 'Notes',
      toolName: 'create_note',
      risk: 'write',
      connectionId: env.connectionId,
      connectorSlug: 'notes',
      accountLabel: 'jyy@example.com',
      durations: ['once', 'conversation', 'bot'],
    });
    expect(core.services.domain!.approvals.renderContextLine(card)).toContain(
      '以 jyy@example.com 身份在 Notes 执行 create_note',
    );
    await core.rpc.call('approvals.decide', { id: card.id, approve: true, duration: 'bot' });

    const task = await waitForRun(core, env.conversationId, 'completed', {
      loopType: 'task',
      timeoutMs: 60_000,
    });
    // list_notes (read) ran without a card; the second create_note was covered by the grant.
    const results = [
      ...(await resultOf(env, task.id, 'app_notes_list_notes')),
      ...(await resultOf(env, task.id, 'app_notes_create_note')),
    ];
    expect(results).toHaveLength(3);
    expect(results.every((s) => s.payload['ok'] === true)).toBe(true);
    const list = (await core.rpc.call('approvals.list', {
      conversationId: env.conversationId,
    })) as {
      approvals: Approval[];
    };
    expect(list.approvals.filter((a) => a.kind === 'mcp_tool')).toHaveLength(1);

    // The bot-wide grant exists, keyed by (bot, connection, tool), with the approval id.
    const grants = core.services.appToolGrants!.list({ connectionId: env.connectionId });
    expect(grants).toMatchObject([
      { botId: env.botId, toolName: 'create_note', conversationId: null, approvalId: card.id },
    ]);
    // Audit names the account for the grant-covered call.
    const audit = core.services
      .domain!.audit.listByConversation(env.conversationId, 100)
      .filter((a) => a.action === 'mcp_tool_call' && a.detail['toolName'] === 'create_note');
    expect(audit.map((a) => a.detail['approval']).sort()).toEqual(['grant', 'user']);
    expect(audit.every((a) => a.detail['accountLabel'] === 'jyy@example.com')).toBe(true);
    // Both writes reached the fake server with the account's token.
    expect(env.fake.toolCalls.filter((c) => c.name === 'create_note')).toHaveLength(2);
  }, 120_000);

  it('a destructive call asks with the full parameters and only "once" (a forged bot choice degrades, no grant)', async () => {
    const env = await start();
    const { core, llm } = env.stack;
    const longNote = 'x'.repeat(900);
    llm.script('mock-main', [
      ...taskOf(env, [
        step().replyToolCall('app_notes_delete_all', { confirm: true, note: longNote }),
        // W4: an identical repeat of a completed operation is deduplicated (no new card), so
        // the second call differs in its arguments to exercise "still asks".
        step().replyToolCall('app_notes_delete_all', { confirm: true, note: 'second' }),
        step().replyText('完成'),
      ]),
    ]);
    await sendBatch(core, env.conversationId, ['清空笔记']);
    const card = await pendingCard(env);
    expect(card.payload['risk']).toBe('destructive');
    expect(card.payload['durations']).toEqual(['once']);
    expect(String(card.payload['argsSummary']).length).toBeLessThan(450);
    expect(JSON.parse(String(card.payload['argsFull']))).toEqual({ confirm: true, note: longNote });
    await core.rpc.call('approvals.decide', { id: card.id, approve: true, duration: 'bot' });
    // Same call again: still asks (no grant was created from the degraded choice).
    const second = await waitFor(
      async () => {
        const list = (await core.rpc.call('approvals.list', {
          conversationId: env.conversationId,
        })) as {
          approvals: Approval[];
        };
        return list.approvals.find((a) => a.status === 'pending' && a.id !== card.id) ?? null;
      },
      { label: 'second destructive card', timeoutMs: 30_000 },
    );
    expect(second.payload['durations']).toEqual(['once']);
    await core.rpc.call('approvals.decide', { id: second.id, approve: true });
    await waitForRun(core, env.conversationId, 'completed', {
      loopType: 'task',
      timeoutMs: 60_000,
    });
    expect(core.services.appToolGrants!.list()).toEqual([]);
    const decided = (await core.rpc.call('approvals.list', {
      conversationId: env.conversationId,
    })) as {
      approvals: Approval[];
    };
    expect(decided.approvals.find((a) => a.id === card.id)!.decision).toEqual({ duration: 'once' });
  }, 120_000);

  it('the read-only turn surface keeps only read + auto app tools', async () => {
    const env = await start();
    const { core, llm } = env.stack;
    llm.script('mock-main', [step().inTurn().replyText('在')]);
    await sendBatch(core, env.conversationId, ['你好']);
    await waitForRun(core, env.conversationId, 'completed', { timeoutMs: 30_000 });
    const request = llm.requestsFor('mock-main')[0]!;
    const names = toolNamesOf(request);
    expect(names).toContain('app_notes_list_notes');
    expect(names).not.toContain('app_notes_create_note');
    expect(names).not.toContain('app_notes_delete_all');
    const prompt = promptOf(request);
    expect(prompt).toContain('<connected_apps>');
    expect(prompt).toContain('Notes（账号 jyy@example.com');
    expect(prompt).toContain('工具名以 app_notes_ 开头');
  }, 60_000);

  it('a task gets all three tools; once the connection expires none is offered and the prompt says so', async () => {
    const env = await start();
    const { core, llm } = env.stack;
    llm.script('mock-main', [
      ...viaTask({
        writes: true,
        taskSteps: [
          step()
            .expect((req) =>
              ['app_notes_list_notes', 'app_notes_create_note', 'app_notes_delete_all'].every((n) =>
                toolNamesOf(req).includes(n),
              ),
            )
            .replyText('三个工具都在'),
        ],
        relay: '好',
      }),
    ]);
    await sendBatch(core, env.conversationId, ['看看你能做什么']);
    await waitForRun(core, env.conversationId, 'completed', {
      loopType: 'task',
      timeoutMs: 60_000,
    });

    core.services.apps!.store.setStatus(env.connectionId, 'expired');
    llm.script('mock-main', [step().inTurn().replyText('已过期')]);
    await sendBatch(core, env.conversationId, ['再看看']);
    await waitFor(async () => (llm.requestsFor('mock-main').length >= 5 ? true : null), {
      label: 'turn after expiry',
      timeoutMs: 30_000,
    });
    const request = llm.requestsFor('mock-main').at(-1)!;
    expect(toolNamesOf(request).some((n) => n.startsWith('app_notes_'))).toBe(false);
    expect(toolNamesOf(request)).toContain('app_request_connection');
    expect(promptOf(request)).toContain(
      `connection_id: ${env.connectionId}）：授权已失效，需重新连接`,
    );
  }, 120_000);

  it('unattended mode approves every tier and the audit carries risk + account identity', async () => {
    const env = await start();
    const { core, llm } = env.stack;
    await core.rpc.call('unattended.enable', { hours: null, acknowledgeRisk: true });
    llm.script('mock-main', [
      ...taskOf(env, [
        step().replyToolCall('app_notes_create_note', { title: 'a' }),
        step().replyToolCall('app_notes_delete_all', { confirm: true }),
        step().replyText('完成'),
      ]),
    ]);
    await sendBatch(core, env.conversationId, ['无人值守清理']);
    await waitForRun(core, env.conversationId, 'completed', {
      loopType: 'task',
      timeoutMs: 60_000,
    });
    const audit = core.services.domain!.audit.listByConversation(env.conversationId, 100);
    const calls = audit.filter((a) => a.action === 'mcp_tool_call');
    expect(
      calls.map((a) => [a.detail['toolName'], a.detail['risk'], a.detail['approval']]).sort(),
    ).toEqual([
      ['create_note', 'write', 'unattended'],
      ['delete_all', 'destructive', 'unattended'],
    ]);
    for (const call of calls) {
      expect(call.detail).toMatchObject({
        accountLabel: 'jyy@example.com',
        connectionId: env.connectionId,
        unattendedAutoApproved: true,
      });
    }
    const autos = audit.filter(
      (a) => a.action === 'approval_auto' && a.detail['kind'] === 'mcp_tool',
    );
    expect(autos).toHaveLength(2);
    for (const auto of autos) {
      expect(auto.detail).toMatchObject({
        accountLabel: 'jyy@example.com',
        connectionId: env.connectionId,
      });
    }
    expect(core.services.appToolGrants!.list()).toEqual([]);
  }, 120_000);
});
