import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestStack, listAllMessages, listMessages, makeBot, openDirect, startFileServer, step, waitFor } from '@kepcup/testkit';
import type { TestFileServer } from '@kepcup/testkit';
import type { CoreHarness } from '@kepcup/core';

/**
 * P09 URL 入库（docs/dev/phases/P09-wiki.md 测试要求）：URL 在沙箱中抓取
 * （受网络策略约束），使用本地 http server 夹具，绝不触真实网络。HTML 抓取
 * 结果转 markdown 落 raw/；页面由维护 loop（mock 模型）写入。
 */

const PAGE_HTML = [
  '<!doctype html><html><head><title>Spec</title></head><body>',
  '<h1>接口规范</h1>',
  '<p>本规范描述 <a href="/next">下一章</a> 的 <strong>调用方式</strong>。</p>',
  '<ul><li>第一点</li><li>第二点</li></ul>',
  '<script>fetch("http://intranet")</script>',
  '</body></html>',
].join('');

const MARKDOWN_DOC = '# 纯文本资料\n\nMarkdownUrlDoc 的正文内容。';

/** A binary payload (zip magic + invalid UTF-8 sequences) for BR-P09-006. */
const BINARY_BLOB = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from([0x00, 0xff, 0xfe, 0x89, 0x50, 0x4e, 0x47]),
  Buffer.from([0xc3, 0x28]), // invalid UTF-8 continuation
]);

function wikiRoot(core: CoreHarness, botId: string): string {
  return path.join(core.services.paths.home, 'bots', botId, 'wiki');
}

describe('P09 Wiki：URL 来源在沙箱中抓取（本地 http 夹具）', () => {
  let stack: Awaited<ReturnType<typeof createTestStack>>;
  let server: TestFileServer;
  let botId: string;
  let conversationId: string;

  beforeAll(async () => {
    stack = await createTestStack();
    server = await startFileServer({
      'spec.html': PAGE_HTML,
      'doc.md': MARKDOWN_DOC,
      'blob.bin': BINARY_BLOB,
    });
    const bot = await makeBot(stack.core, '阿抓');
    botId = bot.id;
    conversationId = (await openDirect(stack.core, bot.id)).id;
  });

  afterAll(async () => {
    await stack.cleanup();
    await server.stop();
  });

  it('HTML 页面抓取后转 markdown 入 raw/，维护 loop 写页面并提交', async () => {
    const url = `${server.url}/spec.html`;
    stack.llm.script('mock-main', [
      step()
        .expect((req) => String(req.lastUserText()).includes('学一下这个网页'))
        .replyToolCall('wiki_enqueue', { source_type: 'url', ref: url, note: '接口规范页面' }),
      step()
        .expect(
          (req) =>
            JSON.stringify(req.body).includes('已登记入库任务') &&
            !String(req.lastUserText()).includes('接口规范页面'),
        )
        .replyText('好的，登记了'),
      step()
        .expect(
          (req) =>
            String(req.lastUserText()).includes('接口规范') &&
            String(req.lastUserText()).includes('整理进你的 Wiki'),
        )
        .replyToolCall('write', {
          path: 'pages/spec.md',
          content: '# 接口规范\n\nSpecPage 的调用方式整理。',
        }),
      step().replyToolCall('write', {
        path: 'index.md',
        content: '# 目录\n\n- [接口规范](pages/spec.md) — SpecPage',
      }),
      step().replyToolCall('write', {
        path: 'log.md',
        content: '# 变更日志\n\n- 20261001 | 网页 spec.html | pages/spec.md',
      }),
      step().replyText('整理完成'),
      // 入库成功静默（消息原则）：没有事件触发 run。
    ]);
    await stack.core.rpc.call('drafts.add', {
      conversationId,
      text: `学一下这个网页 ${url}`,
    });
    await stack.core.rpc.call('drafts.flush', { conversationId });

    // 维护 loop 的任务消息里内联的是转换后的 markdown（HTML 已消失）。
    await waitFor(
      () =>
        stack.llm.requestsFor('mock-main').some((req) => {
          const text = String(req.lastUserText());
          return text.includes('# 接口规范') && text.includes('- 第一点');
        })
          ? true
          : null,
      { label: 'maintenance prompt carries converted markdown', timeoutMs: 60_000 },
    );
    expect(
      stack.llm.requestsFor('mock-main').some((req) => String(req.lastUserText()).includes('fetch(')),
    ).toBe(false); // script 内容不进提示词（已被转换剥离）

    await waitFor(
      () => {
        const rows = stack.core.services.mainDb!
          .prepare("select status from jobs where type = 'wiki_ingest'")
          .all() as Array<{ status: string }>;
        return rows.length >= 1 && rows.every((row) => row.status === 'done') ? true : null;
      },
      { label: 'wiki_ingest done', timeoutMs: 60_000 },
    );

    // raw/：转换后的 .md 文件（内容含 markdown 结构，不含 script）。
    const rawDir = path.join(wikiRoot(stack.core, botId), 'raw');
    const files = readdirSync(rawDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{8}-[0-9a-f]{12}-spec\.md$/);
    const raw = readFileSync(path.join(rawDir, files[0]!), 'utf8');
    expect(raw).toContain('# 接口规范');
    expect(raw).toContain('- 第一点');
    expect(raw).not.toContain('<script');
    expect(server.requestsServed()).toBeGreaterThanOrEqual(1); // 抓取确实走了本地服务

    // 抓取在沙箱内完成：数据目录对抓取命令不可见（curl 只回传 stdout）。
    expect(existsSync(path.join(wikiRoot(stack.core, botId), 'pages/spec.md'))).toBe(true);
    const history = (await stack.core.rpc.call('wiki.history', { botId })) as {
      history: Array<{ message: string }>;
    };
    expect(history.history).toHaveLength(2);
  }, 120_000);

  it('allowlist 网络策略下非名单内主机直接拒绝（任务失败，无抓取）', async () => {
    const servedBefore = server.requestsServed();
    const url = `${server.url}/doc.md`;
    stack.llm.script('mock-main', [
      step()
        .expect((req) => String(req.lastUserText()).includes('学一下被拒绝的网页'))
        .replyToolCall('wiki_enqueue', { source_type: 'url', ref: url, note: '名单外' }),
      step().replyText('登记了（可能失败）'),
      // BR-P09-005：失败以 internal 事件触发 Bot，Bot 用自己的话向用户交代。
      step()
        .expect((req) => String(req.lastUserText()).includes('入库失败'))
        .replyText('好的，这次入库失败了，我知道了'),
    ]);
    // 直接改 Profile 的网络策略为 allowlist（不含本地主机）。
    const current = (await stack.core.rpc.call('bots.get', { id: botId })) as {
      bot: { profile: Record<string, unknown> };
    };
    const profile = current.bot.profile as {
      runtime: { network_policy: string; network_allowlist: string[] };
    };
    profile.runtime.network_policy = 'allowlist';
    profile.runtime.network_allowlist = ['example.com'];
    await stack.core.rpc.call('bots.update', {
      id: botId,
      profile: current.bot.profile as never,
    });

    await stack.core.rpc.call('drafts.add', {
      conversationId,
      text: '学一下被拒绝的网页',
    });
    await stack.core.rpc.call('drafts.flush', { conversationId });
    // 入库任务以失败终态（网络策略拒绝），没有任何抓取发生。
    await waitFor(
      () => {
        const rows = stack.core.services.mainDb!
          .prepare("select status, attempts from jobs where type = 'wiki_ingest' order by created_at desc")
          .all() as Array<{ status: string; attempts: number }>;
        const latest = rows[0];
        return latest !== undefined && latest.status === 'failed' ? true : null;
      },
      { label: 'ingest job failed by network policy', timeoutMs: 60_000 },
    );
    expect(server.requestsServed()).toBe(servedBefore);
    // raw/ 没有新增文件。
    expect(readdirSync(path.join(wikiRoot(stack.core, botId), 'raw'))).toHaveLength(1);
    // BR-P09-005 + 消息原则：失败事件只发给 Bot（internal，domain 层可见、
    // 用户可见流被过滤），Bot 用自己的话应答（脚本最后一步）。
    await waitFor(
      async () =>
        (await listAllMessages(stack.core, conversationId)).find(
          (m) =>
            m.senderType === 'system' &&
            (m.content as { event?: string; internal?: boolean }).event === 'wiki_ingest_failed' &&
            (m.content as { text?: string }).text?.includes('入库失败') === true,
        ) ?? null,
      { label: 'internal wiki_ingest_failed event', timeoutMs: 30_000 },
    );
    // 只在最后一次尝试通知一次（重试过程不刷屏）。
    const failureNotices = (await listAllMessages(stack.core, conversationId)).filter(
      (m) =>
        m.senderType === 'system' && (m.content as { event?: string }).event === 'wiki_ingest_failed',
    );
    expect(failureNotices).toHaveLength(1);
    expect((failureNotices[0]!.content as { internal?: boolean }).internal).toBe(true);
    // 用户可见流里没有任何入库失败的系统事件（Bot 的应答不是 system 消息）。
    const visible = await listMessages(stack.core, conversationId);
    expect(
      visible.some(
        (m) => m.senderType === 'system' && (m.content as { event?: string }).event === 'wiki_ingest_failed',
      ),
    ).toBe(false);
  }, 120_000);

  it('二进制内容被明确拒绝（BR-P09-006）：任务失败、raw 无文件、Bot 收到内部事件并应答', async () => {
    const url = `${server.url}/blob.bin`;
    stack.llm.script('mock-main', [
      step()
        .expect((req) => String(req.lastUserText()).includes('学一下二进制'))
        .replyToolCall('wiki_enqueue', { source_type: 'url', ref: url, note: '二进制' }),
      step().replyText('登记了（二进制应该失败）'),
      // BR-P09-005：失败说明的事件 run 应答。
      step()
        .expect((req) => String(req.lastUserText()).includes('入库失败'))
        .replyText('这份是二进制内容，无法入库，我知道了'),
    ]);
    await stack.core.rpc.call('drafts.add', {
      conversationId,
      text: '学一下二进制页面',
    });
    await stack.core.rpc.call('drafts.flush', { conversationId });
    await waitFor(
      () => {
        const rows = stack.core.services.mainDb!
          .prepare("select status from jobs where type = 'wiki_ingest' order by created_at desc")
          .all() as Array<{ status: string }>;
        return rows[0]?.status === 'failed' ? true : null;
      },
      { label: 'binary ingest job failed', timeoutMs: 60_000 },
    );
    // raw/ 仍只有第一个用例的 spec 文件，没有二进制文件。
    const files = readdirSync(path.join(wikiRoot(stack.core, botId), 'raw'));
    expect(files.some((f) => f.endsWith('.bin'))).toBe(false);
    // 失败事件只进 Bot 的上下文（internal）；具体拒绝理由由 fetchableTextVerdict
    // 的单元测试固定，重负载下沙箱抓取可能先撞上瞬时错误，这里只固定事件与送达。
    await waitFor(
      async () =>
        (await listAllMessages(stack.core, conversationId)).find(
          (m) =>
            m.senderType === 'system' &&
            (m.content as { event?: string }).event === 'wiki_ingest_failed',
        ) ?? null,
      { label: 'internal wiki_ingest_failed event', timeoutMs: 30_000 },
    );
    // Bot 的可见应答（自己的话，非系统播报）。
    await waitFor(
      async () =>
        (await listMessages(stack.core, conversationId)).find(
          (m) =>
            m.senderType === 'bot' &&
            (m.content as { text?: string }).text?.includes('无法入库') === true,
        ) ?? null,
      { label: 'bot own-words failure reply', timeoutMs: 30_000 },
    );
  }, 120_000);
});
