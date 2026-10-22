import { mkdtemp } from 'node:fs/promises';
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
import { createBotAndOpenChat } from './helpers/create-bot';
import { createProjectViaUi } from './helpers/create-project';
import { rmHomeTolerant } from './helpers/home-cleanup';

/**
 * D92 T1b WP10 e2e：项目的 Wiki tab——空态、来源面板（用户粘贴文本 → 维护
 * loop 写页 → 创建者「你」）、成员 Bot 经 wiki_enqueue(scope=project) 入库、
 * 用户删除来源（删除中 → 消失）、删除项目组确认框的 wiki 数量。数据流经真实
 * core：维护 loop 的沙箱 curl 从本地文件服务夹具取网页，绝不触真实网络。
 */

const LOG_TEMPLATE = '# 变更日志\n\n<!-- 只追加：日期 | 来源 | 改动的页面 -->';

const MEMBER_PAGE_HTML = [
  '<!doctype html><html><head><title>MemberDoc</title></head><body>',
  '<h1>成员共享资料</h1>',
  '<p>MemberDocKeyword：成员 Bot 存进项目 wiki 的资料。</p>',
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

interface Session {
  app: ElectronApplication;
  page: Page;
  home: string;
  llm: MockLlmServer;
  server: TestFileServer;
}

async function startSession(prefix: string): Promise<Session> {
  const llm = await startMockLlm();
  const server = await startFileServer({ 'member-doc.html': MEMBER_PAGE_HTML });
  const home = await mkdtemp(path.join(tmpdir(), prefix));
  const app = await _electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      KEPCUP_HOME: home,
      NODE_ENV: 'test',
      KEPCUP_KEYSTORE: 'file',
      KEPCUP_ONBOARDING: 'off',
      KEPCUP_FILE_KEYSTORE_PATH: path.join(home, '.test-master-key'),
      KEPCUP_MOCK_LLM_URL: llm.url,
    },
  });
  const page = await app.firstWindow();
  return { app, page, home, llm, server };
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
  await expect(
    page
      .locator('[data-testid="chat-view"]')
      .or(page.locator('[data-testid="start-chat-panel"]'))
      .or(page.locator('[data-testid="onboarding"]')),
  ).toBeVisible({ timeout: 60_000 });
  const startBackdrop = page.locator('[data-testid="start-chat-backdrop"]');
  if (await startBackdrop.isVisible()) {
    await startBackdrop.click({ timeout: 2_000 }).catch(() => {});
  }
}

async function openWikiTab(page: Page): Promise<void> {
  await page.locator('[data-testid="project-tab-wiki"]').click();
  await expect(page.locator('[data-testid="project-wiki-view"]')).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.locator('[data-testid="project-wiki-view"]')).toHaveAttribute(
    'data-owner-kind',
    'project',
  );
}

/** The pasted-text source flow: add via the panel, then the real maintenance loop writes the page. */
function scriptTextMaintenance(
  llm: MockLlmServer,
  keyword: string,
  pagePath: string,
  pageTitle: string,
): void {
  llm.script('mock-main', [
    step()
      .expect((req) => JSON.stringify(req.body).includes(keyword))
      .replyToolCall('write', {
        path: `pages/${pagePath}`,
        content: `# ${pageTitle}\n\n${keyword} 的整理结果。`,
      }),
    step().replyToolCall('write', {
      path: 'index.md',
      content: `# 目录\n\n- [${pageTitle}](pages/${pagePath}) — ${keyword}`,
    }),
    step().replyToolCall('write', {
      path: 'log.md',
      content: `${LOG_TEMPLATE}\n- 20261018 | 粘贴文本 | pages/${pagePath}`,
    }),
    step().replyText('整理完成'),
    // 删除来源后排一次体检（负责人身份）：直接完成，清悬空引用。
    step()
      .expect((req) => JSON.stringify(req.body).includes('体检'))
      .replyText('项目 wiki 体检完成'),
  ]);
}

async function addTextSource(page: Page, body: string): Promise<void> {
  await page.locator('[data-testid="wiki-sources-toggle"]').click();
  const panel = page.locator('[data-testid="wiki-sources-panel"]');
  await expect(panel).toBeVisible({ timeout: 15_000 });
  await page.locator('[data-testid="wiki-source-add-text"]').fill(body);
  await page.locator('[data-testid="wiki-source-add-text-submit"]').click();
}

/** The sources sub-view replaces the tree while open — toggle back to browse. */
async function closeSourcesPanel(page: Page): Promise<void> {
  await page.locator('[data-testid="wiki-sources-toggle"]').click();
  await expect(page.locator('[data-testid="wiki-sources-panel"]')).toHaveCount(0, {
    timeout: 15_000,
  });
}

test('project wiki: empty state, user adds a text source, page appears, creator is "you"', async () => {
  test.skip(
    process.platform === 'win32',
    'wiki ingest needs a working sandbox; windows CI has no distro',
  );
  test.setTimeout(300_000);
  const session = await startSession('kepcup-e2e-project-wiki-1-');
  const { page, llm } = session;
  try {
    await waitReady(page);
    await createBotAndOpenChat(page, '阿领');
    await createBotAndOpenChat(page, '阿员');
    await createProjectViaUi(page, '项目知识库', ['阿领', '阿员']);
    llm.script(
      'mock-light',
      Array.from({ length: 4 }, () => step().replyJson(emptyReflection())),
    );

    // Wiki tab 空态（项目 wiki 未初始化）。
    await openWikiTab(page);
    await expect(page.locator('[data-testid="wiki-empty"]')).toHaveText('项目 wiki 还是空的', {
      timeout: 15_000,
    });

    // 来源面板：粘贴文本入库；维护 loop（负责人身份）写出页面。
    scriptTextMaintenance(llm, 'TextDocKeyword', 'text-note.md', '文本页');
    await addTextSource(page, '用户粘贴的正文：TextDocKeyword 项目 wiki 文本入库。');

    // 来源行的创建者是「你」（用户提交）——入库完成后 wiki_changed 刷新面板。
    const creator = page.locator('[data-testid^="wiki-source-creator-"]');
    await expect(creator.first()).toBeVisible({ timeout: 90_000 });
    await expect(creator.first()).toHaveText('提交者：你');

    // 关闭来源子视图回到页面树：维护 loop 写出的页面已出现。
    await closeSourcesPanel(page);
    const pageItem = page.locator('[data-testid="wiki-page-pages-text-note-md"]');
    await expect(pageItem).toBeVisible({ timeout: 90_000 });
    await expect(pageItem).toContainText('文本页');
  } finally {
    await closeSession(session);
  }
});

test('project wiki: a member bot contributes via wiki_enqueue scope=project', async () => {
  test.skip(
    process.platform === 'win32',
    'wiki ingest needs a working sandbox; windows CI has no distro',
  );
  test.setTimeout(300_000);
  const session = await startSession('kepcup-e2e-project-wiki-2-');
  const { page, llm, server } = session;
  const url = `${server.url}/member-doc.html`;
  try {
    await waitReady(page);
    await createBotAndOpenChat(page, '阿领');
    await createBotAndOpenChat(page, '阿员');
    await createProjectViaUi(page, '成员共建组', ['阿领', '阿员']);
    llm.script(
      'mock-light',
      Array.from({ length: 6 }, () => step().replyJson(emptyReflection())),
    );

    // 沟通里 @ 成员，成员的对话轮显式 scope=project 入库（执行者 = 该成员）。
    llm.script('mock-main', [
      step()
        .expect((req) => req.lastUserText().includes('存到项目 wiki'))
        .replyToolCall('wiki_enqueue', {
          source_type: 'url',
          ref: url,
          note: '成员的共享资料',
          scope: 'project',
        }),
      step()
        .expect((req) => JSON.stringify(req.body).includes('已登记入库任务'))
        .replyText('好的，我把它存进项目 wiki'),
      // 维护 loop 以成员身份运行（成员名出现在任务消息里）。
      step()
        .expect((req) => JSON.stringify(req.body).includes('MemberDocKeyword'))
        .replyToolCall('write', {
          path: 'pages/member-doc.md',
          content: '# 成员资料页\n\nMemberDocKeyword 的整理结果。',
        }),
      step().replyToolCall('write', {
        path: 'index.md',
        content: '# 目录\n\n- [成员资料页](pages/member-doc.md) — MemberDocKeyword',
      }),
      step().replyToolCall('write', {
        path: 'log.md',
        content: `${LOG_TEMPLATE}\n- 20261018 | 网页 member-doc.html | pages/member-doc.md`,
      }),
      step().replyText('整理完成'),
    ]);

    const composer = page.locator('[data-testid="composer-input"]');
    await composer.click();
    await composer.pressSequentially('@阿员');
    await page
      .locator('[data-testid="mention-popup"] button')
      .filter({ hasText: '阿员' })
      .first()
      .click();
    await composer.pressSequentially(' 把这份资料存到项目 wiki');
    await composer.press('Meta+Enter');
    await expect(
      page.locator('[data-testid="bot-bubble"]').filter({ hasText: '存进项目 wiki' }).first(),
    ).toBeVisible({ timeout: 60_000 });

    // Wiki tab：页面与来源都出现，来源提交者是该成员 Bot。
    await openWikiTab(page);
    await expect(page.locator('[data-testid="wiki-page-pages-member-doc-md"]')).toBeVisible({
      timeout: 90_000,
    });
    await page.locator('[data-testid="wiki-sources-toggle"]').click();
    const creator = page.locator('[data-testid^="wiki-source-creator-"]');
    await expect(creator.first()).toBeVisible({ timeout: 60_000 });
    await expect(creator.first()).toHaveText('提交者：阿员');
  } finally {
    await closeSession(session);
  }
});

test('project wiki: user deletes a source', async () => {
  test.skip(
    process.platform === 'win32',
    'wiki ingest needs a working sandbox; windows CI has no distro',
  );
  test.setTimeout(300_000);
  const session = await startSession('kepcup-e2e-project-wiki-3-');
  const { page, llm } = session;
  try {
    await waitReady(page);
    await createBotAndOpenChat(page, '阿领');
    await createBotAndOpenChat(page, '阿员');
    await createProjectViaUi(page, '来源管理组', ['阿领', '阿员']);
    llm.script(
      'mock-light',
      Array.from({ length: 4 }, () => step().replyJson(emptyReflection())),
    );

    scriptTextMaintenance(llm, 'DeleteDocKeyword', 'delete-note.md', '待删页');
    await openWikiTab(page);
    await addTextSource(page, '等待删除的正文：DeleteDocKeyword。');
    await closeSourcesPanel(page);
    await expect(page.locator('[data-testid="wiki-page-pages-delete-note-md"]')).toBeVisible({
      timeout: 90_000,
    });
    await page.locator('[data-testid="wiki-sources-toggle"]').click();
    const row = page.locator('[data-testid^="wiki-source-row-"]').first();
    await expect(row).toBeVisible({ timeout: 30_000 });

    // 删除：行进入「删除中…」，wiki_changed 到达后整行消失。
    await row.locator('[data-testid^="wiki-source-delete-"]').click();
    await expect(page.locator('[data-testid^="wiki-source-deleting-"]')).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator('[data-testid^="wiki-source-row-"]')).toHaveCount(0, {
      timeout: 60_000,
    });
    await expect(page.locator('[data-testid^="wiki-source-deleting-"]')).toHaveCount(0);
  } finally {
    await closeSession(session);
  }
});

test('project wiki: delete project shows wiki counts', async () => {
  test.skip(
    process.platform === 'win32',
    'wiki ingest needs a working sandbox; windows CI has no distro',
  );
  test.setTimeout(300_000);
  const session = await startSession('kepcup-e2e-project-wiki-4-');
  const { page, llm } = session;
  try {
    await waitReady(page);
    await createBotAndOpenChat(page, '阿领');
    await createBotAndOpenChat(page, '阿员');
    await createProjectViaUi(page, '删除确认组', ['阿领', '阿员']);
    llm.script(
      'mock-light',
      Array.from({ length: 4 }, () => step().replyJson(emptyReflection())),
    );

    scriptTextMaintenance(llm, 'CountDocKeyword', 'count-note.md', '计数页');
    await openWikiTab(page);
    await addTextSource(page, '计数用正文：CountDocKeyword。');
    await closeSourcesPanel(page);
    await expect(page.locator('[data-testid="wiki-page-pages-count-note-md"]')).toBeVisible({
      timeout: 90_000,
    });

    // 详情页危险区：展开确认时并行取 wiki.sources + wiki.tree，显示数量行。
    await page.locator('[data-testid="project-settings-button"]').click();
    await expect(page.locator('[data-testid="project-settings-page"]')).toBeVisible({
      timeout: 15_000,
    });
    // master-detail：同屏只渲染当前分区，删除入口在「其它」分区（危险区卡片）。
    await page.locator('[data-testid="project-settings-nav-danger"]').click();
    await expect(page.locator('[data-testid="project-settings-section-danger"]')).toBeVisible();
    await page.locator('[data-testid="project-delete-begin"]').click();
    await expect(page.locator('[data-testid="project-delete-confirm-box"]')).toBeVisible();
    const counts = page.locator('[data-testid="project-delete-wiki-count"]');
    await expect(counts).toBeVisible({ timeout: 30_000 });
    await expect(counts).toContainText('项目 wiki：1 份来源');
    await expect(counts).toContainText('1 个页面');
  } finally {
    await closeSession(session);
  }
});
