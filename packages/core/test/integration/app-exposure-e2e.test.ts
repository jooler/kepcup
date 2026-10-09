import { afterEach, describe, expect, it } from 'vitest';
import type { Bot } from '@kepcup/shared';
import {
  createTestStack,
  listRuns,
  makeBot,
  openDirect,
  sendBatch,
  step,
  viaTask,
  waitFor,
  waitForRun,
  type MockChatRequest,
  type TestStack,
} from '@kepcup/testkit';

import { ConnectorCatalog } from '../../src/apps/catalog.js';
import { connectorEntry } from '../support/app-catalog-fixtures.js';

/**
 * D73 P1 §5.7 end to end (fakes only): a Bot's authorized catalog connections and the catalog
 * show up in the prompt (`<connected_apps>` / `<available_apps>` + the platform rule); an
 * expired connection exposes no tools and `app_request_connection` raises the right
 * `connect-app` setup (`target: catalog`, with `connectionId` for a reconnect).
 */

const stacks: TestStack[] = [];
afterEach(async () => {
  for (const stack of stacks.splice(0)) await stack.cleanup();
});

const promptOf = (req: MockChatRequest): string => JSON.stringify(req.body.messages ?? []);
const toolNamesOf = (req: MockChatRequest): string[] =>
  (req.body.tools ?? []).map(
    (tool) => (tool as { function?: { name?: string } }).function?.name ?? '',
  );

async function start(options: { statuses?: 'expired' | 'connected' } = {}) {
  const catalog = new ConnectorCatalog({
    env: {},
    source: {
      entries: [
        connectorEntry('github', { title: 'GitHub', description: '代码托管与协作' }),
        connectorEntry('notion', { title: 'Notion', description: '笔记与知识库' }),
      ],
      iconsDir: null,
    },
    approvedGates: null,
  });
  const stack = await createTestStack({ connectorCatalog: catalog });
  stacks.push(stack);
  const { core } = stack;
  const store = core.services.apps!.store;
  store.create({
    id: 'conn_nt',
    connectorId: 'notion',
    label: 'me@example.com',
    serverUrl: 'https://mcp.notion.test/mcp',
    status: options.statuses ?? 'expired',
  });
  const bot = await makeBot(core, '小应');
  await core.rpc.call('bots.update', {
    id: bot.id,
    profile: {
      ...bot.profile,
      runtime: { ...bot.profile.runtime, app_connection_ids: ['conn_nt'] },
    },
  });
  const conv = await openDirect(core, bot.id);
  return { stack, core, bot: bot as Bot, conversationId: conv.id };
}

describe('prompt and tools', () => {
  it('lists the authorized connection (status, account, description) and the unconnected catalog apps', async () => {
    const h = await start();
    h.stack.llm.script('mock-main', [step().inTurn().replyText('收到')]);
    await sendBatch(h.core, h.conversationId, ['随便聊聊']);
    await waitForRun(h.core, h.conversationId, 'completed', { timeoutMs: 20_000 });
    const request = h.stack.llm.requestsFor('mock-main')[0]!;
    const prompt = promptOf(request);
    expect(prompt).toContain('<connected_apps>');
    expect(prompt).toContain(
      'Notion（账号 me@example.com，connection_id: conn_nt）：授权已失效，需重新连接',
    );
    expect(prompt).toContain('笔记与知识库');
    expect(prompt).toContain('<available_apps>');
    expect(prompt).toContain('GitHub（connector: github）');
    // Notion is authorized, so it is not offered again.
    expect(prompt).not.toContain('Notion（connector: notion）');
    expect(prompt).toContain('需要未连接或需重连的应用时调用 app_request_connection');
    // An expired connection exposes no tools; the request tool is there.
    const names = toolNamesOf(request);
    expect(names).toContain('app_request_connection');
    expect(names.some((name) => name.startsWith('app_notion_'))).toBe(false);
  }, 60_000);

  it('a bot without any authorization sees no <connected_apps> but is offered the whole catalog', async () => {
    const h = await start();
    const other = await makeBot(h.core, '小空');
    const conv = await openDirect(h.core, other.id);
    h.stack.llm.script('mock-main', [step().inTurn().replyText('在')]);
    await sendBatch(h.core, conv.id, ['你好']);
    await waitForRun(h.core, conv.id, 'completed', { timeoutMs: 20_000 });
    const prompt = promptOf(h.stack.llm.requestsFor('mock-main').at(-1)!);
    expect(prompt).not.toContain('<connected_apps>');
    expect(prompt).toContain('<available_apps>');
    expect(prompt).toContain('Notion（connector: notion）');
    expect(prompt).toContain('GitHub（connector: github）');
  }, 60_000);
});

describe('app_request_connection', () => {
  async function runRequest(
    h: Awaited<ReturnType<typeof start>>,
    args: Record<string, unknown>,
    seen: string[] = [],
  ) {
    h.stack.llm.script('mock-main', [
      ...viaTask({
        writes: false,
        taskSteps: [step().replyToolCall('app_request_connection', args), step().replyText('好的')],
        relay: '已处理',
      }),
      step().inTurn().replyText('请在对话里连接'),
    ]);
    await sendBatch(h.core, h.conversationId, ['用应用查一下']);
    return waitFor(
      async () => {
        const runs = await listRuns(h.core, h.conversationId);
        return (
          runs.find(
            (r) =>
              r.loopType === 'task' &&
              ['failed', 'completed'].includes(r.status) &&
              !seen.includes(r.id),
          ) ?? null
        );
      },
      { label: 'task settles', timeoutMs: 30_000 },
    );
  }

  it('an unconnected catalog app → setup target catalog (no connectionId)', async () => {
    const h = await start();
    const run = await runRequest(h, { connector: 'github', reason: '需要查 issue' });
    expect(run.status).toBe('failed');
    expect(run.setup).toEqual({
      kind: 'connect-app',
      target: { kind: 'catalog', connectorId: 'github' },
      reason: 'not_connected',
    });
  }, 90_000);

  it('an authorized but expired connection → catalog target with its connectionId', async () => {
    const h = await start();
    const byId = await runRequest(h, { connection_id: 'conn_nt', reason: '需要读笔记' });
    expect(byId.status).toBe('failed');
    expect(byId.setup).toEqual({
      kind: 'connect-app',
      target: { kind: 'catalog', connectorId: 'notion' },
      connectionId: 'conn_nt',
      reason: 'expired',
    });
  }, 90_000);

  it('asking for a connector the bot already has (expired) is treated as the reconnect', async () => {
    const h = await start();
    const run = await runRequest(h, { connector: 'notion' });
    expect(run.setup).toMatchObject({
      kind: 'connect-app',
      target: { kind: 'catalog', connectorId: 'notion' },
      connectionId: 'conn_nt',
    });
  }, 90_000);

  it('refuses unknown connectors and connections that are not the bot’s (no card)', async () => {
    const h = await start();
    const seen: string[] = [];
    for (const args of [{ connector: 'nope' }, { connection_id: 'conn_other' }]) {
      const run = await runRequest(h, args, seen);
      seen.push(run.id);
      expect(run.status).toBe('completed');
      const steps = (
        (await h.core.rpc.call('runs.steps', { runId: run.id })) as {
          steps: Array<{ type: string; payload: Record<string, unknown> }>;
        }
      ).steps;
      const result = steps.find(
        (s) => s.type === 'tool_result' && s.payload['toolName'] === 'app_request_connection',
      );
      expect(result!.payload['errorCode']).toBe('INVALID_INPUT');
      // Let the relay turn finish before the next scenario reuses the conversation.
      await waitForRun(h.core, h.conversationId, 'completed', { timeoutMs: 30_000 });
    }
  }, 120_000);
});
