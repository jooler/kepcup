import { afterEach, describe, expect, it } from 'vitest';
import type { Approval, Message } from '@kepcup/shared';
import {
  createTestStack,
  makeBot,
  openDirect,
  sendBatch,
  startFakeMcpAppServer,
  step,
  viaTask,
  waitFor,
  waitForRun,
  type FakeMcpAppServer,
  type TestStack,
} from '@kepcup/testkit';
import { startCatalogUiEnv, type CatalogUiEnv } from '../support/mcp-apps-ui-env.js';

/**
 * D73 P3 §7.5 — approvals for UI-initiated tool calls (security review items 2–4):
 * write tools from an app's UI ALWAYS need a human click (unattended mode does not decide them,
 * standing grants are ignored, only「仅这一次」is offered, the app can not mint grants); the card
 * and audit say where the action came from; a denied tool is not asked about again for 30 s; at
 * most 3 UI calls per conversation are in flight; closing the card / removing the server cancels
 * pending approvals and nothing runs afterwards.
 */

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Env {
  stack: TestStack;
  fake: FakeMcpAppServer;
  conversationId: string;
  card: Message;
}

async function start(): Promise<Env> {
  const fake = await startFakeMcpAppServer({ html: '<html><body>page</body></html>' });
  cleanups.push(() => fake.stop());
  const stack = await createTestStack();
  cleanups.push(() => stack.cleanup());
  const { core, llm } = stack;
  await core.rpc.call('settings.update', {
    mcpServers: [
      {
        id: 'app1',
        name: '假界面应用',
        transport: 'http',
        url: fake.mcpUrl,
        enabled: true,
        autoApprove: false,
        auth: 'none',
      },
    ],
  });
  const bot = await makeBot(core, '小界面');
  await core.rpc.call('bots.update', {
    id: bot.id,
    profile: { ...bot.profile, runtime: { ...bot.profile.runtime, mcp_server_ids: ['app1'] } },
  });
  const conv = await openDirect(core, bot.id);
  llm.script(
    'mock-main',
    viaTask({
      writes: false,
      taskSteps: [step().replyToolCall('mcp_app1_show_dashboard', {}), step().replyText('ok')],
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
  return { stack, fake, conversationId: conv.id, card };
}

type Rpc = TestStack['core']['rpc'];
const open = async (rpc: Rpc, card: Message) =>
  (await rpc.call('apps.ui.open', { messageId: card.id })) as { resourceId: string };
const callTool = (rpc: Rpc, resourceId: string, toolName: string, args: Record<string, unknown>) =>
  rpc.call('apps.ui.callTool', { resourceId, toolName, arguments: args }) as Promise<{
    content: Array<{ text: string }>;
    isError?: boolean;
  }>;
const approvalsOf = async (rpc: Rpc, conversationId: string): Promise<Approval[]> =>
  (
    (await rpc.call('approvals.list', { conversationId })) as {
      approvals: Approval[];
    }
  ).approvals.filter((a) => a.kind === 'mcp_tool');
const pendingCards = async (rpc: Rpc, conversationId: string, count = 1) =>
  waitFor(
    async () => {
      const pending = (await approvalsOf(rpc, conversationId)).filter(
        (a) => a.status === 'pending',
      );
      return pending.length >= count ? pending : null;
    },
    { label: `${count} pending mcp_tool card(s)`, timeoutMs: 30_000 },
  );
const settle = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms));

describe('UI-initiated writes always need a human', () => {
  it('unattended mode does not decide them: the card stays pending, carries origin + only "once"; a forged "bot" degrades; audit has the origin', async () => {
    const env = await start();
    const { core } = env.stack;
    await core.rpc.call('unattended.enable', { hours: null, acknowledgeRisk: true });
    const { resourceId } = await open(core.rpc, env.card);

    // Reads still run as today (no card, even in unattended mode).
    expect((await callTool(core.rpc, resourceId, 'refresh_data', {})).content[0]!.text).toMatch(
      /^refreshed:/,
    );

    const pendingWrite = callTool(core.rpc, resourceId, 'save_note', { text: 'a' });
    const [card] = await pendingCards(core.rpc, env.conversationId);
    // Not auto-approved, not executed — it waits for a person.
    await settle();
    expect(card!.status).toBe('pending');
    expect(card!.autoApproved).not.toBe(true);
    expect(env.fake.toolCalls.filter((c) => c.name === 'save_note')).toHaveLength(0);
    expect(card!.payload).toMatchObject({
      toolName: 'save_note',
      origin: 'app_ui',
      appName: '假界面应用',
      durations: ['once'],
      risk: 'write',
    });

    // A forged wider choice degrades to once.
    await core.rpc.call('approvals.decide', { id: card!.id, approve: true, duration: 'bot' });
    expect((await pendingWrite).content[0]!.text).toBe('saved:a');
    const decided = (await approvalsOf(core.rpc, env.conversationId)).find(
      (a) => a.id === card!.id,
    )!;
    expect(decided.status).toBe('approved');
    expect(decided.decision).toEqual({ duration: 'once' });
    expect(decided.autoApproved).not.toBe(true);

    const audit = core.services
      .domain!.audit.listByConversation(env.conversationId, 100)
      .filter((a) => a.action === 'mcp_tool_call' && a.detail['toolName'] === 'save_note');
    expect(audit).toHaveLength(1);
    expect(audit[0]!.detail).toMatchObject({
      origin: 'app_ui',
      appName: '假界面应用',
      approval: 'user',
    });
  }, 120_000);

  it('a server whose policy says "auto" (autoApprove) still raises the card for a UI write; a model-initiated call does not', async () => {
    const env = await start();
    const { core, llm } = env.stack;
    await core.rpc.call('settings.update', {
      mcpServers: [
        {
          id: 'app1',
          name: '假界面应用',
          transport: 'http',
          url: env.fake.mcpUrl,
          enabled: true,
          autoApprove: true,
          auth: 'none',
        },
      ],
    });
    const { resourceId } = await open(core.rpc, env.card);
    const pendingWrite = callTool(core.rpc, resourceId, 'save_note', { text: 'auto?' });
    const [card] = await pendingCards(core.rpc, env.conversationId);
    expect(env.fake.toolCalls.filter((c) => c.name === 'save_note')).toHaveLength(0);
    await core.rpc.call('approvals.decide', { id: card!.id, approve: true });
    expect((await pendingWrite).content[0]!.text).toBe('saved:auto?');
    void llm;
  }, 120_000);
});

describe('approval spam limits', () => {
  it('after a denial the same tool on the same card is locked for 30 s: no new card, other tools unaffected', async () => {
    const env = await start();
    const { core } = env.stack;
    const { resourceId } = await open(core.rpc, env.card);
    const first = callTool(core.rpc, resourceId, 'save_note', { text: '1' });
    const [card] = await pendingCards(core.rpc, env.conversationId);
    await core.rpc.call('approvals.decide', { id: card!.id, approve: false });
    expect(await first).toMatchObject({ isError: true });

    const before = (await approvalsOf(core.rpc, env.conversationId)).length;
    await expect(callTool(core.rpc, resourceId, 'save_note', { text: '2' })).rejects.toMatchObject({
      code: 'APP_UI_RATE_LIMITED',
    });
    expect(await approvalsOf(core.rpc, env.conversationId)).toHaveLength(before);
    // Another tool, and the same tool on a fresh card, are not locked.
    expect((await callTool(core.rpc, resourceId, 'refresh_data', {})).isError).not.toBe(true);
    const other = await open(core.rpc, env.card);
    const again = callTool(core.rpc, other.resourceId, 'save_note', { text: '3' });
    const [card2] = await pendingCards(core.rpc, env.conversationId);
    expect(card2!.id).not.toBe(card!.id);
    await core.rpc.call('approvals.decide', { id: card2!.id, approve: false });
    await again;
    expect(env.fake.toolCalls.filter((c) => c.name === 'save_note')).toHaveLength(0);
  }, 120_000);

  it('at most 3 UI-initiated calls per conversation may be pending; more fail fast without a card', async () => {
    const env = await start();
    const { core } = env.stack;
    const a = await open(core.rpc, env.card);
    const b = await open(core.rpc, env.card);
    const calls = [
      callTool(core.rpc, a.resourceId, 'save_note', { text: 'a1' }),
      callTool(core.rpc, a.resourceId, 'save_note', { text: 'a2' }),
      callTool(core.rpc, b.resourceId, 'save_note', { text: 'b1' }),
    ];
    const pending = await pendingCards(core.rpc, env.conversationId, 3);
    expect(pending).toHaveLength(3);
    await expect(
      callTool(core.rpc, b.resourceId, 'save_note', { text: 'b2' }),
    ).rejects.toMatchObject({
      code: 'APP_UI_RATE_LIMITED',
    });
    expect(
      (await approvalsOf(core.rpc, env.conversationId)).filter((x) => x.status === 'pending'),
    ).toHaveLength(3);
    for (const card of pending)
      await core.rpc.call('approvals.decide', { id: card.id, approve: false });
    await Promise.all(calls);
    // Slots are released: a new call can raise a card again (a different tool is not denial-locked).
    const next = callTool(core.rpc, b.resourceId, 'internal_write_not_allowed', {}).catch(
      (e: unknown) => e,
    );
    expect(await next).toMatchObject({ code: 'APP_UI_TOOL_NOT_ALLOWED' });
  }, 120_000);
});

describe('stale approvals never execute', () => {
  it('closing the card while an approval is pending cancels it; approving later does not execute', async () => {
    const env = await start();
    const { core } = env.stack;
    const { resourceId } = await open(core.rpc, env.card);
    const outcome = callTool(core.rpc, resourceId, 'save_note', { text: 'late' }).then(
      () => null,
      (error: unknown) => error,
    );
    const [card] = await pendingCards(core.rpc, env.conversationId);
    await core.rpc.call('apps.ui.close', { resourceId });
    expect(await outcome).toMatchObject({ code: 'APP_UI_EXPIRED' });
    const after = (await approvalsOf(core.rpc, env.conversationId)).find((a) => a.id === card!.id)!;
    expect(after.status).toBe('cancelled');
    // A late "approve" on the already-cancelled card is a no-op or an error — never an execution.
    await core.rpc.call('approvals.decide', { id: card!.id, approve: true }).catch(() => undefined);
    await settle();
    expect(env.fake.toolCalls.filter((c) => c.name === 'save_note')).toHaveLength(0);
  }, 120_000);

  it('the server being closed (disconnect / credential change) cancels pending approvals promptly', async () => {
    const env = await start();
    const { core } = env.stack;
    const { resourceId } = await open(core.rpc, env.card);
    const outcome = callTool(core.rpc, resourceId, 'save_note', { text: 'gone' }).then(
      () => null,
      (error: unknown) => error,
    );
    const [card] = await pendingCards(core.rpc, env.conversationId);
    await core.services.mcp!.closeServer('app1');
    expect(await outcome).toMatchObject({ code: 'APP_UI_EXPIRED' });
    const after = (await approvalsOf(core.rpc, env.conversationId)).find((a) => a.id === card!.id)!;
    expect(after.status).toBe('cancelled');
    expect(env.fake.toolCalls.filter((c) => c.name === 'save_note')).toHaveLength(0);
  }, 120_000);

  it('the server being removed from settings while pending: approving afterwards does not execute', async () => {
    const env = await start();
    const { core } = env.stack;
    const { resourceId } = await open(core.rpc, env.card);
    const outcome = callTool(core.rpc, resourceId, 'save_note', { text: 'removed' }).then(
      () => null,
      (error: unknown) => error,
    );
    const [card] = await pendingCards(core.rpc, env.conversationId);
    await core.rpc.call('settings.update', { mcpServers: [] });
    await core.rpc.call('approvals.decide', { id: card!.id, approve: true }).catch(() => undefined);
    expect(await outcome).toMatchObject({ code: expect.stringMatching(/APP_UI_EXPIRED|MCP_/) });
    expect(env.fake.toolCalls.filter((c) => c.name === 'save_note')).toHaveLength(0);
  }, 120_000);
});

describe('catalog connection: standing grants are ignored for UI writes', () => {
  it('a bot-level grant for the tool still raises a card (durations: once only); a forged "bot" creates no grant; the card says app_ui', async () => {
    const env: CatalogUiEnv = await startCatalogUiEnv();
    cleanups.push(() => env.cleanup());
    const { core } = env.stack;
    const grants = core.services.appToolGrants!;
    grants.create({
      botId: env.botId,
      connectionId: env.connectionId,
      toolName: 'save',
      conversationId: null,
    });
    const before = grants.list({ connectionId: env.connectionId }).length;
    await core.rpc.call('unattended.enable', { hours: null, acknowledgeRisk: true });
    const { resourceId } = await open(core.rpc, env.card);

    const pending = callTool(core.rpc, resourceId, 'save', { text: 'x' });
    const [card] = await pendingCards(core.rpc, env.conversationId);
    expect(card!.payload).toMatchObject({
      toolName: 'save',
      origin: 'app_ui',
      connectionId: env.connectionId,
      durations: ['once'],
    });
    expect(env.fake.toolCalls.filter((c) => c.name === 'save')).toHaveLength(0);
    await core.rpc.call('approvals.decide', { id: card!.id, approve: true, duration: 'bot' });
    await pending;
    expect(env.fake.toolCalls.filter((c) => c.name === 'save')).toHaveLength(1);
    expect(grants.list({ connectionId: env.connectionId })).toHaveLength(before);
    const decided = (await approvalsOf(core.rpc, env.conversationId)).find(
      (a) => a.id === card!.id,
    )!;
    expect(decided.decision).toEqual({ duration: 'once' });
    const audit = core.services
      .domain!.audit.listByConversation(env.conversationId, 100)
      .filter((a) => a.action === 'mcp_tool_call' && a.detail['toolName'] === 'save');
    expect(audit[0]!.detail).toMatchObject({ origin: 'app_ui', appName: 'Notes' });
  }, 180_000);
});
