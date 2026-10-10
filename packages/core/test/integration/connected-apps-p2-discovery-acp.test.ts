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
 * D73 P2 §6.3 on the host bridge: an external-agent Bot whose apps carry more than
 * APP_TOOLS_INLINE_MAX tools sees only `app_search_tools` / `app_call_tool` (+ the request tool) on
 * `tools/list`; the run context carries the same decision (summary + 「工具按需发现」, tool names
 * spelled the way the agent sees them); a write through `app_call_tool` raises the ordinary
 * `mcp_tool` card for the real tool.
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

describe('§6.3 ACP', () => {
  it('bridge tools/list = the two discovery tools; prompt mirrors the decision; app_call_tool raises the real tool card', async () => {
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
      agentSpawn: fakeAgentSpawner(
        {
          fake: {
            turns: [
              agentTurn()
                .mcpList()
                .mcpCall('s1', 'app_search_tools', { query: 'bug report' })
                .mcpCall('c1', 'app_call_tool', {
                  name: 'app_notes_file_issue',
                  arguments: { title: '来自外援' },
                })
                .text('记好了'),
            ],
          },
        },
        started,
      ) as never,
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
      { label: 'mcp_tool card from app_call_tool', timeoutMs: 30_000 },
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
    expect(listed).toContain('app_search_tools');
    expect(listed).toContain('app_call_tool');
    expect(listed).toContain('app_request_connection');
    expect(listed.some((n) => n.startsWith('app_notes_'))).toBe(false);
    for (const name of listed)
      expect(`mcp__kepcup_xxxxxxxx__${name}`.length).toBeLessThanOrEqual(64);

    const prompt = observed.prompts[0]!.text;
    expect(prompt).toContain('<connected_apps>');
    expect(prompt).toContain('工具按需发现');
    expect(prompt).toMatch(/mcp__kepcup_[0-9a-f]{8}__app_search_tools/);
    expect(prompt).toMatch(/mcp__kepcup_[0-9a-f]{8}__app_call_tool/);
    expect(prompt).not.toContain('app_notes_ 开头');

    // Steps are attributed to the apps pack; the dispatcher result carries the real tool's output.
    const steps = (await core.rpc.call('runs.steps', { runId: task.id })) as {
      steps: Array<{ type: string; payload: Record<string, unknown> }>;
    };
    expect(steps.steps.filter((s) => s.type === 'tool_call').map((s) => s.payload)).toMatchObject([
      { toolName: 'app_search_tools', capability: 'apps' },
      { toolName: 'app_call_tool', capability: 'apps' },
    ]);
  }, 120_000);
});
