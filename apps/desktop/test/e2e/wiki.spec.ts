import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page, _electron } from '@playwright/test';
import {
  startFileServer,
  startMockLlm,
  step,
  type MockLlmServer,
  type TestFileServer,
} from '@kepcup/testkit';
import { createBotAndOpenChat, rpc } from './helpers/create-bot';
import { rmHomeTolerant } from './helpers/home-cleanup';

/**
 * P09 e2e (docs/dev/phases/P09-wiki.md 测试要求「端到端」): the right-panel
 * Wiki tab — page tree, markdown-rendered page content, full-text search,
 * change history, the two-step page deletion and the two-step rollback (both
 * are NEW commits, so the history grows by one entry each). Page data flows
 * through the REAL core stack: the scripted model enqueues the ingest via
 * wiki_enqueue, the real maintenance loop writes the pages (its sandboxed curl
 * fetches the page from a LOCAL file server fixture — the real network is
 * never touched). 入库完成是 Bot 自己的事务：对话里没有完成播报，右栏 Wiki 树
 * 由 wiki_changed 刷新。
 */

// Same template as core's wiki init (log.md is append-only; the loop rewrites
// it with this prefix so the commit message carries the appended record).
const LOG_TEMPLATE = '# 变更日志\n\n<!-- 只追加：日期 | 来源 | 改动的页面 -->';

const PAGE_HTML = [
  '<!doctype html><html><head><title>Deploy</title></head><body>',
  '<h1>DeployFlow 部署指南</h1>',
  '<p>DeployFlow 的关键步骤：构建、推送、发布。</p>',
  '</body></html>',
].join('');

function emptyReflection() {
  return {
    runSummary: '无新记忆',
    memories: [],
    profileProposals: [],
    wikiSuggestions: [],
    skillSuggestion: null,
  };
}

interface LaunchedApp {
  app: ElectronApplication;
  page: Page;
  home: string;
}

async function launchApp(options: { home: string; llmUrl: string }): Promise<LaunchedApp> {
  const app = await _electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      TZ: 'Asia/Shanghai',
      KEPCUP_HOME: options.home,
      NODE_ENV: 'test',
      KEPCUP_KEYSTORE: 'file',
      // P13-B e2e seam: 非引导用例不出现首启向导（packaged 产物恒为 on）。
      KEPCUP_ONBOARDING: 'off',
      KEPCUP_FILE_KEYSTORE_PATH: path.join(options.home, '.test-master-key'),
      KEPCUP_MOCK_LLM_URL: options.llmUrl,
    },
  });
  const page = await app.firstWindow();
  return { app, page, home: options.home };
}

interface Session {
  app: ElectronApplication;
  page: Page;
  home: string;
  llm: MockLlmServer;
  server: TestFileServer;
}

async function startSession(prefix: string): Promise<Session> {
  const llm = await startMockLlm();
  const server = await startFileServer({ 'deploy.html': PAGE_HTML });
  const home = await mkdtemp(path.join(tmpdir(), prefix));
  const launched = await launchApp({ home, llmUrl: llm.url });
  return { ...launched, llm, server };
}

async function closeSession(session: Session): Promise<void> {
  await session.app.close();
  await session.llm.stop();
  await session.server.stop();
  await rmHomeTolerant(session.home);
}

async function waitReady(page: Page): Promise<void> {
  await expect(page.locator('[data-testid="app-shell"]')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('[data-testid="ping-result"]')).toContainText('ping ✓', {
    timeout: 60_000,
  });
  // 等启动恢复收尾：chat-view（恢复了对话）/ 空态引导面板 / 首启向导三者
  // 之一都只在 bootstrap 完成后出现。ping ✓ 早于 bootstrap 结束，慢机器上
  // 直接往下走会与异步尾巴竞态。「+」面板的全屏 backdrop 会拦截后续一切
  // 点击，收尾后确保它已收起（面板只开一次，收掉后不会再出现）。
  await expect(
    page
      .locator('[data-testid="chat-view"]')
      .or(page.locator('[data-testid="start-chat-panel"]'))
      .or(page.locator('[data-testid="onboarding"]')),
  ).toBeVisible({ timeout: 60_000 });
  const startBackdrop = page.locator('[data-testid="start-chat-backdrop"]');
  if (await startBackdrop.isVisible()) {
    // 可能有更高层的模态（如首启沙箱准备向导）盖住 backdrop：收不掉就交给
    // 各测试自己的既有处理（它们大多自带 try-click 收尾），不在这里硬等。
    await startBackdrop.click({ timeout: 2_000 }).catch(() => {});
  }
}

/** 右栏默认收起：需要时经顶部药丸展开（toggle 语义，不能盲点）。 */
async function expandRightPanel(page: Page): Promise<void> {
  if (!(await page.locator('[data-testid="right-panel"]').isVisible())) {
    await page.locator('[data-testid="right-panel-toggle"]').click();
  }
}

/** 从任意下钻详情回到统一二级菜单（已在菜单则不动）。 */
async function openBotMenu(page: Page): Promise<void> {
  await expandRightPanel(page);
  const back = page.locator('[data-testid="bot-detail-back"]');
  if (await back.isVisible()) await back.click();
  await expect(page.locator('[data-testid="bot-menu"]')).toBeVisible();
}

async function openWikiTab(page: Page): Promise<void> {
  await openBotMenu(page);
  await page.locator('[data-testid="bot-menu-row-wiki"]').click();
  await expect(page.locator('[data-testid="wiki-tab"]')).toBeVisible();
}

async function openProfileTab(page: Page): Promise<void> {
  // tabs 已移除：回到统一二级菜单即可。
  await openBotMenu(page);
}

/**
 * 诊断（临时）：树项等到超时仍不出现 → 把沙箱状态与会话尾部消息 dump 进
 * CI 日志报复酒（入库管线任何一环失败都会在 internal 事件里留痕）。
 */
async function dumpWikiDiag(page: Page, home: string): Promise<void> {
  try {
    // 入库终态失败的 Bot 交代不带技术细节：真实原因只写进 home/logs。
    const logFiles = (await readdir(path.join(home, 'logs'), { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.startsWith('kepcup'))
      .map((entry) => entry.name);
    for (const file of logFiles) {
      const content = await readFile(path.join(home, 'logs', file), 'utf8');
      const lines = content.split('\n').slice(-500);
      for (const line of lines) {
        if (/wiki|ingest/i.test(line)) {
          console.warn(`[wiki-diag-log] ${file} ${line.slice(-500)}`);
        }
      }
    }
  } catch (error) {
    console.warn(`[wiki-diag] log dump failed: ${String(error)}`);
  }
  try {
    const sandbox = await rpc(page, 'sandbox.status', { probe: false });
    console.warn(`[wiki-diag] sandbox.status ${JSON.stringify(sandbox)}`);
    const { bots } = (await rpc(page, 'bots.list')) as {
      bots: Array<{ id: string; name: string; status: string }>;
    };
    for (const bot of bots) {
      const tree = (await rpc(page, 'wiki.tree', {
        owner: { kind: 'bot', id: bot.id },
      })) as unknown;
      console.warn(`[wiki-diag] bot ${bot.name}(${bot.status}) tree ${JSON.stringify(tree)}`);
      const history = (await rpc(page, 'wiki.history', {
        owner: { kind: 'bot', id: bot.id },
      })) as unknown;
      console.warn(`[wiki-diag] bot ${bot.name} history ${JSON.stringify(history)}`);
    }
    const { conversations } = (await rpc(page, 'conversations.list')) as {
      conversations: Array<{ id: string; botId: string | null; title?: string }>;
    };
    for (const conversation of conversations.slice(-3)) {
      const { runs } = (await rpc(page, 'runs.list', {
        conversationId: conversation.id,
        limit: 20,
      })) as {
        runs: Array<{
          loopType: string;
          status: string;
          error: string | null;
          summary: string | null;
        }>;
      };
      for (const run of runs) {
        console.warn(
          `[wiki-diag] run ${run.loopType} ${run.status} ${run.error ?? ''} ${run.summary ?? ''}`,
        );
      }
    }
    for (const conversation of conversations.slice(-3)) {
      const { messages } = (await rpc(page, 'messages.list', {
        conversationId: conversation.id,
        limit: 8,
      })) as {
        messages: Array<{ seq: number; senderType: string; kind: string; content: unknown }>;
      };
      for (const message of messages) {
        const text =
          typeof message.content === 'object' &&
          message.content !== null &&
          'text' in message.content
            ? String((message.content as { text: unknown }).text).slice(0, 200)
            : JSON.stringify(message.content).slice(0, 200);
        console.warn(`[wiki-diag] ${message.seq} ${message.senderType}/${message.kind} ${text}`);
      }
    }
  } catch (error) {
    console.warn(`[wiki-diag] dump failed: ${String(error)}`);
  }
}

test('wiki tab: browse the page tree, read rendered markdown, search, history and rollback', async () => {
  // Windows CI：WSL2 CLI 可用但应用私有发行版未导入 → 沙箱 probe 不可用 →
  // URL 入库按设计 fail-closed（沙箱不可用就不抓），树项永远不会出现。
  // 发行版级 fixture 属另一工程，这里直接跳过整个入库 → 阅读 → 回滚链路。
  test.skip(
    process.platform === 'win32',
    'wiki URL ingest needs a working sandbox; windows CI has no distro',
  );
  // 慢 CI（ubuntu 在负载下入库管线可能超过半分钟）余量：整用例放宽，
  // 树项等待也从 30s 放宽到 90s（validation/fixtures 全走同样管线）。
  test.setTimeout(360_000);
  const session = await startSession('kepcup-e2e-wiki-');
  const { page, llm, server, home } = session;
  const url = `${server.url}/deploy.html`;
  try {
    await waitReady(page);
    await createBotAndOpenChat(page, '阿识');

    // The tab starts empty (the bot has no wiki yet).
    await openWikiTab(page);
    await expect(page.locator('[data-testid="wiki-empty"]')).toBeVisible({ timeout: 15_000 });
    await openProfileTab(page);

    // Response run: enqueue → ack. Maintenance loop: write page / index / log.
    // 入库完成静默（消息原则）：没有事件触发 run，也没有完成播报。
    llm.script('mock-main', [
      step()
        .expect((req) => req.lastUserText().includes('学一下这个网页'))
        .replyToolCall('wiki_enqueue', { source_type: 'url', ref: url, note: '部署指南网页' }),
      step()
        .expect((req) => JSON.stringify(req.body).includes('已登记入库任务'))
        .replyText('好的，读完后告诉你'),
      step()
        .expect(
          (req) =>
            req.lastUserText().includes('DeployFlow') &&
            req.lastUserText().includes('整理进你的 Wiki'),
        )
        .replyToolCall('write', {
          path: 'pages/deploy.md',
          content: '# 部署指南\n\nDeployFlow 的关键步骤：构建、推送、发布，最后验证。',
        }),
      step().replyToolCall('write', {
        path: 'index.md',
        content: '# 目录\n\n- [部署指南](pages/deploy.md) — DeployFlow 部署步骤',
      }),
      step().replyToolCall('write', {
        path: 'log.md',
        content: `${LOG_TEMPLATE}\n- 20261001 | 网页 deploy.html | pages/deploy.md`,
      }),
      step().replyText('整理完成'),
    ]);
    // Reflection after the enqueue response run (维护 loop 不产生反思)。
    llm.script(
      'mock-light',
      Array.from({ length: 4 }, () => step().replyJson(emptyReflection())),
    );

    const composer = page.locator('[data-testid="composer-input"]');
    await composer.fill(`学一下这个网页 ${url}`);
    await composer.press('ControlOrMeta+Enter');
    // 只有登记回执；没有"读完了"式的完成播报（消息原则）。
    await expect(
      page.locator('[data-testid="bot-bubble"]').filter({ hasText: '读完后告诉你' }).first(),
    ).toBeVisible({ timeout: 60_000 });

    // --- browse: the root lists the pages FOLDER plus the 目录 entry; page
    // entries live one level down (wiki_changed refresh + reload) -------------
    await openWikiTab(page);
    const pageItem = page.locator('[data-testid="wiki-page-pages-deploy-md"]');
    const pagesFolder = page.locator('[data-testid="wiki-dir-pages"]');
    try {
      await expect(pagesFolder).toBeVisible({ timeout: 90_000 });
    } catch (error) {
      await dumpWikiDiag(page, home);
      throw error;
    }
    await expect(page.locator('[data-testid="wiki-page-index"]')).toBeVisible();
    await expect(pagesFolder).toContainText('1'); // one page under pages/
    await pagesFolder.click();
    await expect(pageItem).toBeVisible({ timeout: 15_000 });
    await expect(pageItem).toHaveAttribute('data-page-path', 'pages/deploy.md');
    await expect(pageItem).toContainText('部署指南');

    // Page content: wiki.page renders as markdown (`# 部署指南` → <h1>).
    // 导航走头部面包屑（「< Wiki」改造）：末段是当前页面，根段点击回列表。
    await pageItem.click();
    await expect(page.locator('[data-testid="wiki-page-title"]')).toHaveText('部署指南');
    await expect(page.locator('[data-testid="wiki-page-content"]')).toContainText(
      '构建、推送、发布',
    );
    await expect(page.locator('[data-testid="wiki-page-content"] h1')).toHaveText('部署指南');
    const breadcrumb = page.locator('[data-testid="wiki-breadcrumb"]');
    await expect(breadcrumb).toContainText('Wiki');
    await expect(breadcrumb).toContainText('pages');
    await expect(breadcrumb).toContainText('部署指南');
    await breadcrumb.locator('button').first().click();
    await expect(page.locator('[data-testid="wiki-tree"]')).toBeVisible();

    // The 目录 entry opens index.md through the same wiki.page path.
    await page.locator('[data-testid="wiki-page-index"]').click();
    await expect(page.locator('[data-testid="wiki-page-content"]')).toContainText('部署指南', {
      timeout: 15_000,
    });
    await breadcrumb.locator('button').first().click();

    // --- search: FTS hits with snippet; misses show the empty state ----------
    const searchBox = page.locator('[data-testid="wiki-search"]');
    await searchBox.fill('构建');
    const hit = page.locator('[data-testid="wiki-search-hit-pages-deploy-md"]');
    await expect(hit).toBeVisible({ timeout: 15_000 });
    await expect(hit).toContainText('部署指南');
    // The snippet is the FTS-segmented preview (tokens space-separated).
    await expect(hit).toContainText('推送');
    // A hit opens the page.
    await hit.click();
    await expect(page.locator('[data-testid="wiki-page-title"]')).toHaveText('部署指南', {
      timeout: 15_000,
    });
    await page.locator('[data-testid="wiki-breadcrumb"] button').first().click();
    // No-hit query: tokens that appear nowhere (avoid particles like 的 — the
    // FTS retrieval is OR-combined, so a shared particle would still match).
    await searchBox.fill('量子隐身斗篷');
    await expect(page.locator('[data-testid="wiki-search-empty"]')).toBeVisible({
      timeout: 15_000,
    });
    await searchBox.fill('');
    await expect(page.locator('[data-testid="wiki-tree"]')).toBeVisible({ timeout: 15_000 });

    // --- delete: two-step confirm in the page view (pages/ pages only); the
    // deletion is a NEW commit on the append-only history, so it stays
    // recoverable via rollback -----------------------------------------------
    await pagesFolder.click();
    await pageItem.click();
    await expect(page.locator('[data-testid="wiki-page-title"]')).toHaveText('部署指南');
    await page.locator('[data-testid="wiki-page-delete"]').click();
    await page.locator('[data-testid="wiki-page-delete-confirm"]').click();
    await expect(page.locator('[data-testid="wiki-empty"]')).toBeVisible({ timeout: 30_000 });
    // The FTS index followed: the deleted page is no longer searchable.
    await searchBox.fill('构建');
    await expect(page.locator('[data-testid="wiki-search-empty"]')).toBeVisible({
      timeout: 15_000,
    });
    await searchBox.fill('');
    await expect(page.locator('[data-testid="wiki-empty"]')).toBeVisible({ timeout: 15_000 });

    // --- history: inline list (toggle replaces search + tree), one commit per
    // maintenance (init + ingest + delete). An entry opens that commit's wiki
    // snapshot so the user can read the historical content before rolling back
    await page.locator('[data-testid="wiki-history"]').click();
    const historyList = page.locator('[data-testid="wiki-history-list"]');
    // 历史视图不属于内容导航：顶栏「< Wiki」一行隐藏（面包屑只负责内容）。
    await expect(page.locator('[data-testid="wiki-breadcrumb"]')).toHaveCount(0);
    await expect(historyList.locator('[data-testid^="wiki-history-item-"]')).toHaveCount(3, {
      timeout: 15_000,
    });
    // Newest first: the user deletion, then the ingest record, then the init.
    await expect(historyList.locator('[data-testid="wiki-history-message"]').first()).toHaveText(
      'wiki: delete pages/deploy.md',
    );
    await expect(historyList.locator('[data-testid="wiki-history-message"]').nth(1)).toContainText(
      'pages/deploy.md',
    );
    await expect(historyList.locator('[data-testid="wiki-history-message"]').last()).toHaveText(
      'wiki: init',
    );
    await expect(historyList.locator('[data-testid^="wiki-history-item-"]').first()).toContainText(
      /\d{4}/,
    ); // the commit time is rendered

    // The ingest commit's snapshot: folder layout like the browse view (the
    // 目录 entry + the pages folder), and the historical full text of the page
    // (read-only). The top hint rows stay hidden inside the commit.
    await historyList.locator('[data-testid^="wiki-history-open-"]').nth(1).click();
    await expect(page.locator('[data-testid="wiki-commit-view"]')).toBeVisible();
    await expect(page.locator('[data-testid="wiki-history-breadcrumb"]')).toBeVisible();
    const snapshotFolder = page.locator('[data-testid="wiki-history-dir-pages"]');
    await expect(snapshotFolder).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid="wiki-history-page-index"]')).toBeVisible();
    await snapshotFolder.click();
    const snapshotPage = page.locator('[data-testid="wiki-history-page-pages-deploy-md"]');
    await expect(snapshotPage).toBeVisible({ timeout: 15_000 });
    await expect(snapshotPage).toContainText('部署指南');
    await snapshotPage.click();
    // 快照页面：「← 返回 + 摘要」行保留，面包屑（含文档名末段）在其下方；
    // 上一级走面包屑目录段——与浏览视图同一体验（无重复的文档标题行）。
    const historyBreadcrumb = page.locator('[data-testid="wiki-history-breadcrumb"]');
    await expect(page.locator('[data-testid="wiki-commit-back"]')).toBeVisible();
    await expect(historyBreadcrumb).toContainText('部署指南', { timeout: 15_000 });
    await expect(historyBreadcrumb).toContainText('pages');
    await expect(page.locator('[data-testid="wiki-history-page-back"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="wiki-history-page-title"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="wiki-history-page-content"] h1')).toHaveText(
      '部署指南',
    );
    await historyBreadcrumb.getByRole('button', { name: 'pages' }).click();
    await expect(snapshotPage).toBeVisible({ timeout: 15_000 });
    // 提交内的「← 返回」直接退出到历史条目列表
    await page.locator('[data-testid="wiki-commit-back"]').click();
    await expect(historyList.locator('[data-testid^="wiki-history-item-"]')).toHaveCount(3);

    // --- rollback to the init commit (two-step confirm): the pages disappear
    // and the history GROWS to four entries (a rollback is a new commit) ----
    await historyList
      .locator('[data-testid^="wiki-history-item-"]')
      .last()
      .locator('[data-testid^="wiki-rollback-"]')
      .click();
    await historyList.locator('[data-testid="wiki-rollback-confirm"]').click();
    await expect(historyList.locator('[data-testid^="wiki-history-item-"]')).toHaveCount(4, {
      timeout: 30_000,
    });
    await expect(historyList.locator('[data-testid="wiki-history-message"]').first()).toContainText(
      'rollback to',
    );
    // History has its own back button next to the hint text (the breadcrumb
    // stays content-only): exit the history view with it.
    await expect(page.locator('[data-testid="wiki-history-back"]')).toBeVisible();
    await page.locator('[data-testid="wiki-history-back"]').click();

    // Rolled back to init: no pages, and the search index followed (no hits).
    await expect(page.locator('[data-testid="wiki-empty"]')).toBeVisible({ timeout: 30_000 });
    await searchBox.fill('构建');
    await expect(page.locator('[data-testid="wiki-search-empty"]')).toBeVisible({
      timeout: 15_000,
    });
  } finally {
    await closeSession(session);
  }
});
