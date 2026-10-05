import { mkdtemp, rm } from 'node:fs/promises';
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
  await rm(session.home, { recursive: true, force: true });
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

async function createBotAndOpenChat(page: Page, name: string): Promise<void> {
  await page.locator('[data-testid="new-chat-button"]').click();
  await page.locator('[data-testid="bot-create-form"]').click();
  await expect(page.locator('[data-testid="bot-create-dialog"]')).toBeVisible();
  await page.locator('[data-testid="bot-create-dialog"] [data-testid="bot-name-input"]').fill(name);
  await page.locator('[data-testid="bot-create-save"]').click();
  await expect(page.locator('[data-testid="chat-view"]')).toBeVisible({ timeout: 15_000 });

  // 「+」面板的自动展开是启动恢复的异步尾巴，可能落在建 Bot 之后（慢机器）；
  // 其全屏 backdrop 会拦截后续一切点击，进入测试主体前确保它已收起。
  const backdrop = page.locator('[data-testid="start-chat-backdrop"]');
  if (await backdrop.isVisible()) await backdrop.click();
  await expect(backdrop).toHaveCount(0);
}

/** 右栏默认收起：需要时经顶部药丸展开（toggle 语义，不能盲点）。 */
async function expandRightPanel(page: Page): Promise<void> {
  if (!(await page.locator('[data-testid="right-panel-tabs"]').isVisible())) {
    await page.locator('[data-testid="right-panel-toggle"]').click();
  }
}

async function openWikiTab(page: Page): Promise<void> {
  await expandRightPanel(page);
  await page.locator('[data-testid="right-panel-tabs"]').locator('text=Wiki').click();
  await expect(page.locator('[data-testid="wiki-tab"]')).toBeVisible();
}

async function openProfileTab(page: Page): Promise<void> {
  await expandRightPanel(page);
  await page.locator('[data-testid="right-panel-tabs"]').locator('text=配置').click();
}

test('wiki tab: browse the page tree, read rendered markdown, search, history and rollback', async () => {
  test.setTimeout(300_000);
  const session = await startSession('kepcup-e2e-wiki-');
  const { page, llm, server } = session;
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

    // --- browse: the tree lists the new page (wiki_changed refresh + reload) -
    await openWikiTab(page);
    const pageItem = page.locator('[data-testid="wiki-page-pages-deploy-md"]');
    await expect(pageItem).toBeVisible({ timeout: 30_000 });
    await expect(pageItem).toHaveAttribute('data-page-path', 'pages/deploy.md');
    await expect(pageItem).toContainText('部署指南');

    // Page content: wiki.page renders as markdown (`# 部署指南` → <h1>).
    await pageItem.click();
    await expect(page.locator('[data-testid="wiki-page-title"]')).toHaveText('部署指南');
    await expect(page.locator('[data-testid="wiki-page-content"]')).toContainText(
      '构建、推送、发布',
    );
    await expect(page.locator('[data-testid="wiki-page-content"] h1')).toHaveText('部署指南');
    await page.locator('[data-testid="wiki-page-back"]').click();
    await expect(page.locator('[data-testid="wiki-tree"]')).toBeVisible();

    // The 目录 entry opens index.md through the same wiki.page path.
    await page.locator('[data-testid="wiki-page-index"]').click();
    await expect(page.locator('[data-testid="wiki-page-content"]')).toContainText('部署指南', {
      timeout: 15_000,
    });
    await page.locator('[data-testid="wiki-page-back"]').click();

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
    await page.locator('[data-testid="wiki-page-back"]').click();
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

    // --- history: one commit per maintenance (init + ingest + delete) --------
    await page.locator('[data-testid="wiki-history"]').click();
    const dialog = page.locator('[data-testid="wiki-history-dialog"]');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('[data-testid^="wiki-history-item-"]')).toHaveCount(3, {
      timeout: 15_000,
    });
    // Newest first: the user deletion, then the ingest record, then the init.
    await expect(dialog.locator('[data-testid="wiki-history-message"]').first()).toHaveText(
      'wiki: delete pages/deploy.md',
    );
    await expect(dialog.locator('[data-testid="wiki-history-message"]').nth(1)).toContainText(
      'pages/deploy.md',
    );
    await expect(dialog.locator('[data-testid="wiki-history-message"]').last()).toHaveText(
      'wiki: init',
    );
    await expect(dialog.locator('[data-testid^="wiki-history-item-"]').first()).toContainText(
      /\d{4}/,
    ); // the commit time is rendered

    // --- rollback to the init commit (two-step confirm): the pages disappear
    // and the history GROWS to four entries (a rollback is a new commit) ----
    await dialog
      .locator('[data-testid^="wiki-history-item-"]')
      .last()
      .locator('[data-testid^="wiki-rollback-"]')
      .click();
    await dialog.locator('[data-testid="wiki-rollback-confirm"]').click();
    await expect(dialog.locator('[data-testid^="wiki-history-item-"]')).toHaveCount(4, {
      timeout: 30_000,
    });
    await expect(dialog.locator('[data-testid="wiki-history-message"]').first()).toContainText(
      'rollback to',
    );
    await dialog.locator('[data-testid="wiki-history-close"]').click();

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
