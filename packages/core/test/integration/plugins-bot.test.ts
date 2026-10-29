import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildPluginFixture,
  buildPluginIndex,
  createTestStack,
  makeBot,
  makeMarketKey,
  memoryMarketFetch,
  openDirect,
  pluginIndexEntryFor,
  sendBatch,
  step,
  waitForRun,
  type TestStack,
} from '@kepcup/testkit';

/**
 * Bot 发起插件安装（D104 P1-3，设计 51 §6.3），真实 core + 脚本化假模型 + 内存市场：
 *
 * - `plugin_search` 只返回官方认证插件，结果整段是不可信内容；
 * - `plugin_request_install` 通过后 run 以 `setup.kind === 'confirm-plugin-install'` 结束；
 * - 用户确认（`plugins.install` 的市场来源）后 `runs.retry` 续跑成功；
 * - `community` 级条目、未启用市场都被拒，且都只返回固定文案。
 */

const BASE = 'https://market.example.com/plugins/v1';
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Env {
  stack: TestStack;
  packages: Record<string, { sha256: string; path: string }>;
}

async function start(
  options: { tiers?: Array<'verified' | 'community'>; noKeys?: boolean; withKeys?: boolean } = {},
): Promise<Env> {
  const dirs: string[] = [];
  const key = makeMarketKey();
  const files = new Map<string, Buffer>();
  const server = memoryMarketFetch(files);
  const packages: Env['packages'] = {};
  const entries: Array<Record<string, unknown>> = [];
  const tiers = options.tiers ?? ['verified', 'community'];
  const ids = ['io.github.market/verified', 'io.github.market/community'];
  for (const [index, tier] of tiers.entries()) {
    const id = ids[index]!;
    const sub = mkdtempSync(path.join(tmpdir(), 'bot-plugin-'));
    const fixture = await buildPluginFixture({
      dir: sub,
      manifest: { id, name: `Plugin ${tier}`, version: '1.0.0' },
      skills: [{ name: `skill-${tier}` }],
    });
    dirs.push(sub);
    packages[id] = { sha256: fixture.sha256, path: fixture.path };
    files.set(`${BASE}/packages/${fixture.sha256}.kepcup`, readFileSync(fixture.path));
    entries.push(
      pluginIndexEntryFor(fixture, {
        tier,
        downloadUrl: `${BASE}/packages/${fixture.sha256}.kepcup`,
        summary: { name: `Plugin ${tier}`, description: 'Does things', author: 'KepCup' },
      }),
    );
  }
  const { indexBytes, sig } = buildPluginIndex({ key, generatedAt: Date.now(), entries });
  files.set(`${BASE}/index.json`, indexBytes);
  files.set(`${BASE}/index.json.sig`, Buffer.from(sig, 'utf8'));

  const stack = await createTestStack({
    ...(options.noKeys === true
      ? { pluginMarketplace: { keys: [], baseUrl: BASE, fetch: server.fetch } }
      : {
          pluginMarketplace: {
            keys: [key.publicEntry],
            baseUrl: BASE,
            fetch: server.fetch,
            downloadFetch: server.fetch,
            initialDelayMs: 60_000,
            intervalMs: 86_400_000,
          },
        }),
  });
  cleanups.push(() => stack.cleanup());
  cleanups.push(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
  return { stack, packages };
}

const promptOf = (req: { body: { messages?: unknown } }): string =>
  JSON.stringify(req.body.messages ?? '');

describe('Bot plugin install flow', () => {
  it('search → request → setup requirement → user install → retry succeeds', async () => {
    const env = await start();
    const { core, llm } = env.stack;
    await core.rpc.call('plugins.marketplace.refresh', undefined);
    const bot = await makeBot(core, '小插');
    const conv = await openDirect(core, bot.id);

    llm.script('mock-main', [
      step()
        .inTurn()
        .expect((req) => promptOf(req).includes('plugin_search'))
        .replyToolCall('plugin_search', { query: 'does' }),
      step()
        .inTurn()
        .expect((req) => promptOf(req).includes('<untrusted>'))
        .replyToolCall('plugin_request_install', {
          plugin_id: 'io.github.market/verified',
          reason: '需要它来转换文档',
        }),
    ]);
    await sendBatch(core, conv.id, ['有没有能转换文档的插件？']);
    const failed = await waitForRun(core, conv.id, 'failed', { timeoutMs: 60_000 });
    expect(failed.setup).toMatchObject({
      kind: 'confirm-plugin-install',
      pluginId: 'io.github.market/verified',
      version: '1.0.0',
      name: 'Plugin verified',
      reason: '需要它来转换文档',
    });

    // 用户确认：与界面同一条 RPC 路径（市场来源 + 确认时的 sha256）。
    const inspected = (await core.rpc.call('plugins.inspect', {
      source: { kind: 'marketplace', id: 'io.github.market/verified' },
    })) as { packageSha256: string; installable: boolean };
    expect(inspected.installable).toBe(true);
    await core.rpc.call('plugins.install', {
      source: { kind: 'marketplace', id: 'io.github.market/verified' },
      sha256: env.packages['io.github.market/verified']!.sha256,
      userConfig: {},
    });

    llm.script('mock-main', [step().inTurn().replyText('装好了，我来处理。')]);
    await core.rpc.call('runs.retry', { runId: failed.id });
    // `runs.retry` 是一次新的 run（同一对话），以 completed 结束即续跑成功。
    const done = await waitForRun(core, conv.id, 'completed', { timeoutMs: 60_000 });
    expect(done.status).toBe('completed');
  }, 120_000);

  it('community entries are rejected with the fixed message', async () => {
    const env = await start();
    const { core, llm } = env.stack;
    await core.rpc.call('plugins.marketplace.refresh', undefined);
    const bot = await makeBot(core, '小插');
    const conv = await openDirect(core, bot.id);

    llm.script('mock-main', [
      step().inTurn().replyToolCall('plugin_request_install', {
        plugin_id: 'io.github.market/community',
        reason: '需要它',
      }),
      step().inTurn().replyText('只有认证插件可以这样安装。'),
    ]);
    await sendBatch(core, conv.id, ['装那个社区插件']);
    const done = await waitForRun(core, conv.id, 'completed', { timeoutMs: 60_000 });
    expect(done.setup).toBeNull();
    const toolResults = env.stack.llm
      .requests()
      .flatMap((request) => request.body.messages ?? [])
      .map((message) => JSON.stringify(message))
      .join('\n');
    expect(toolResults).toContain('只有官方认证的插件可以由 Bot 提议安装。');
  }, 120_000);

  it('official key list empty (injected) → the search returns nothing and the request is refused', async () => {
    const env = await start({ noKeys: true });
    const { core, llm } = env.stack;
    const bot = await makeBot(core, '小插');
    const conv = await openDirect(core, bot.id);

    llm.script('mock-main', [
      step().inTurn().replyToolCall('plugin_search', { query: 'anything' }),
      step().inTurn().replyToolCall('plugin_request_install', {
        plugin_id: 'io.github.market/verified',
        reason: '需要它',
      }),
      step().inTurn().replyText('插件市场没开。'),
    ]);
    await sendBatch(core, conv.id, ['找插件']);
    const done = await waitForRun(core, conv.id, 'completed', { timeoutMs: 60_000 });
    expect(done.setup).toBeNull();
    const text = env.stack.llm
      .requests()
      .flatMap((request) => request.body.messages ?? [])
      .map((message) => JSON.stringify(message))
      .join('\n');
    expect(text).toContain('官方市场里没有匹配的插件。');
    expect(text).toContain('插件市场未启用，或当前不是官方市场。');
  }, 120_000);
});
