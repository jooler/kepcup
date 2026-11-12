import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page, _electron } from '@playwright/test';
import { startMockLlm } from '@kepcup/testkit';
import { createBotAndOpenChat, openConversationByName } from './helpers/create-bot';
import { rmHomeTolerant } from './helpers/home-cleanup';

/**
 * 右栏 Bot 详情 tab 记忆：每个对话记住自己上次打开的 tab，切对话 / 面板重新
 * 挂载 / 应用重启后都恢复；没有记录的对话默认停在「详情」。
 */

async function launchApp(
  home: string,
  llmUrl: string,
): Promise<{
  app: ElectronApplication;
  page: Page;
}> {
  const app = await _electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      TZ: 'Asia/Shanghai',
      KEPCUP_HOME: home,
      NODE_ENV: 'test',
      KEPCUP_KEYSTORE: 'file',
      KEPCUP_ONBOARDING: 'off',
      KEPCUP_FILE_KEYSTORE_PATH: path.join(home, '.test-master-key'),
      KEPCUP_MOCK_LLM_URL: llmUrl,
    },
  });
  return { app, page: await app.firstWindow() };
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
  const backdrop = page.locator('[data-testid="start-chat-backdrop"]');
  if (await backdrop.isVisible()) await backdrop.click({ timeout: 2_000 }).catch(() => {});
}

async function openRightPanel(page: Page): Promise<void> {
  if (!(await page.locator('[data-testid="right-panel"]').isVisible())) {
    await page.locator('[data-testid="right-panel-toggle"]').click();
  }
  await expect(page.locator('[data-testid="right-panel"]')).toBeVisible({ timeout: 15_000 });
}

type PanelTabId = 'detail' | 'widgets' | 'tasks' | 'notes';

function panelTab(page: Page, id: PanelTabId) {
  return page.locator(`[data-testid="right-panel-tab-${id}"]`);
}

async function expectActiveTab(page: Page, id: PanelTabId): Promise<void> {
  await expect(panelTab(page, id)).toHaveAttribute('aria-selected', 'true', { timeout: 15_000 });
}

test('bot detail remembers the active tab per conversation across switches, remounts and restart', async () => {
  test.setTimeout(180_000);
  const llm = await startMockLlm();
  const home = await mkdtemp(path.join(tmpdir(), 'kepcup-e2e-panel-tabs-'));
  let app: ElectronApplication | null = null;
  try {
    let launched = await launchApp(home, llm.url);
    app = launched.app;
    await waitReady(launched.page);
    let page = launched.page;

    await createBotAndOpenChat(page, '标签甲');
    await openRightPanel(page);
    await expectActiveTab(page, 'detail');
    await panelTab(page, 'tasks').click();
    await expectActiveTab(page, 'tasks');

    // 面板重新挂载（收起 → 展开）：仍停在任务 tab。
    await page.locator('[data-testid="right-panel-hide"]').click();
    await expect(page.locator('[data-testid="right-panel"]')).toHaveCount(0, { timeout: 15_000 });
    await openRightPanel(page);
    await expectActiveTab(page, 'tasks');

    // 另一个对话没有记录：默认详情；在它上面打开便签。
    await createBotAndOpenChat(page, '标签乙');
    await openRightPanel(page);
    await expectActiveTab(page, 'detail');
    await panelTab(page, 'notes').click();
    await expectActiveTab(page, 'notes');

    // 切回甲恢复任务，再切到乙恢复便签——各记各的。
    await openConversationByName(page, '标签甲');
    await expectActiveTab(page, 'tasks');
    await openConversationByName(page, '标签乙');
    await expectActiveTab(page, 'notes');
    await openConversationByName(page, '标签甲');
    await expectActiveTab(page, 'tasks');

    // 重启后回到上次查看的对话（甲），tab 同样恢复。
    await app.close();
    app = null;
    launched = await launchApp(home, llm.url);
    app = launched.app;
    page = launched.page;
    await waitReady(page);
    await expect(page.locator('[data-testid="right-panel-toggle"]')).toContainText('标签甲', {
      timeout: 15_000,
    });
    await openRightPanel(page);
    await expectActiveTab(page, 'tasks');
  } finally {
    if (app !== null) await app.close().catch(() => {});
    await llm.stop();
    await rmHomeTolerant(home);
  }
});
