import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page, _electron } from '@playwright/test';
import { startMockLlm, type MockLlmServer } from '@kepcup/testkit';

/**
 * 右栏 Bot 配置表单自动保存：不再有手动保存按钮，表单值变化（防抖）即经
 * bots.update RPC 落盘。断言方式：改值后切到另一个 Bot 的会话再切回，右栏
 * draft 由 store 重新克隆，若自动保存未生效则改动丢失。数据走真实 core 栈。
 */

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
}

async function startSession(prefix: string): Promise<Session> {
  const llm = await startMockLlm();
  const home = await mkdtemp(path.join(tmpdir(), prefix));
  const launched = await launchApp({ home, llmUrl: llm.url });
  return { ...launched, llm };
}

async function closeSession(session: Session): Promise<void> {
  await session.app.close();
  await session.llm.stop();
  await rm(session.home, { recursive: true, force: true });
}

async function waitReady(page: Page): Promise<void> {
  await expect(page.locator('[data-testid="app-shell"]')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('[data-testid="ping-result"]')).toContainText('ping ✓', {
    timeout: 60_000,
  });
  // 等启动恢复收尾：chat-view（恢复了对话）/ 空态引导面板 / 首启向导三者
  // 之一都只在 bootstrap 完成后出现。
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

async function createBot(page: Page, name: string): Promise<void> {
  await page.locator('[data-testid="new-chat-button"]').click();
  await page.locator('[data-testid="bot-create-form"]').click();
  await expect(page.locator('[data-testid="bot-create-dialog"]')).toBeVisible();
  await page.locator('[data-testid="bot-create-dialog"] [data-testid="bot-name-input"]').fill(name);
  await page.locator('[data-testid="bot-create-save"]').click();
  await expect(page.locator('[data-testid="chat-view"]')).toBeVisible({ timeout: 15_000 });

  // 「+」面板的自动展开是启动恢复的异步尾巴，可能落在建 Bot 之后（慢机器）；
  // 其全屏 backdrop 会拦截后续一切点击，进入下一步前确保它已收起。
  const backdrop = page.locator('[data-testid="start-chat-backdrop"]');
  if (await backdrop.isVisible()) await backdrop.click();
  await expect(backdrop).toHaveCount(0);
}

async function openProfileTab(page: Page): Promise<void> {
  // 右栏默认收起：需要时经顶部药丸展开（toggle 语义，不能盲点）。
  if (!(await page.locator('[data-testid="right-panel-tabs"]').isVisible())) {
    await page.locator('[data-testid="right-panel-toggle"]').click();
  }
  await page.locator('[data-testid="right-panel-tabs"]').locator('text=配置').click();
  await expect(page.locator('[data-testid="profile-tab"]')).toBeVisible();
}

test('right panel profile form autosaves on change (no save button)', async () => {
  test.setTimeout(180_000);
  const session = await startSession('kepcup-e2e-autosave-');
  const { page } = session;
  try {
    await waitReady(page);
    await createBot(page, '小启');
    await openProfileTab(page);

    // 保存按钮已移除：值变化即自动保存，不存在手动落盘入口。
    await expect(page.locator('[data-testid="profile-save"]')).toHaveCount(0);

    const personality = page.locator(
      '[data-testid="profile-tab"] [data-testid="bot-personality-input"]',
    );
    await personality.fill('温和、耐心，回答简短');

    // 建第二个 Bot 触发会话切换（也在防抖窗口内）：切换时未落盘改动会被
    // 立即补救保存，而不是丢弃。
    await createBot(page, '阿快');

    // 切回第一个 Bot：draft 由 store 重新克隆，值在即说明自动保存已落盘。
    await page.locator('[data-testid^="conversation-row-"]').filter({ hasText: '小启' }).click();
    await expect(page.locator('[data-testid="bot-name-edit"]')).toHaveText('小启');
    await openProfileTab(page);
    await expect(personality).toHaveValue('温和、耐心，回答简短');
  } finally {
    await closeSession(session);
  }
});
