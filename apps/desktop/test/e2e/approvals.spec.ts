import { mkdtempSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page, _electron } from '@playwright/test';
import { startMockLlm, step, type MockLlmServer } from '@kepcup/testkit';

/** A real readable file outside every workspace (read tools must reach the gateway). */
function externalFile(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  const file = path.join(dir, 'note.txt');
  writeFileSync(file, 'e2e-external-content');
  return file;
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

test('access approval card appears, keyboard approval works, card folds to a record', async () => {
  test.setTimeout(180_000);
  const session = await startSession('kepcup-e2e-approval-');
  const { page, llm } = session;
  try {
    await waitReady(page);
    await createBotAndOpenChat(page, '小授');

    const target = externalFile('kepcup-e2e-external-');
    llm.script('mock-main', [
      step().replyToolCall('read', { path: target }),
      step().replyText('读完了'),
    ]);

    const composer = page.locator('[data-testid="composer-input"]');
    await composer.fill('读一下外部文件');
    await composer.press('ControlOrMeta+Enter');

    // The interactive card appears above the composer (dock) with focus.
    const card = page.locator('[data-testid^="approval-card-"]');
    await expect(card).toBeVisible({ timeout: 60_000 });
    await expect(card).toBeFocused();

    // 键盘操作：按 2 选择「本对话内一直允许」，Enter 批准。
    await card.press('2');
    await card.press('Enter');

    // The card folds into a one-line record and the run completes.
    const record = page.locator('[data-testid^="approval-record-"]');
    await expect(record).toBeVisible({ timeout: 60_000 });
    await expect(record).toContainText('本对话内一直允许');
    await expect(page.locator('[data-testid="chat-view"]').getByText('读完了')).toBeVisible({
      timeout: 60_000,
    });

    // 右栏授权标签显示该授权并可撤销（右栏默认收起，先经顶部药丸展开）。
    if (!(await page.locator('[data-testid="right-panel-tabs"]').isVisible())) {
      await page.locator('[data-testid="right-panel-toggle"]').click();
    }
    await page.locator('[data-testid="right-panel-tabs"]').locator('text=授权').click();
    const grantItem = page.locator('[data-testid^="grant-item-"]');
    await expect(grantItem).toBeVisible({ timeout: 15_000 });
    await grantItem.locator('[data-testid^="grant-revoke-"]').click();
    await expect(page.locator('[data-testid="grants-empty"]')).toBeVisible({ timeout: 15_000 });
  } finally {
    await closeSession(session);
  }
});

test('left sidebar shows the pending marker while an approval waits; Esc denies', async () => {
  test.setTimeout(180_000);
  const session = await startSession('kepcup-e2e-pending-');
  const { page, llm } = session;
  try {
    await waitReady(page);
    await createBotAndOpenChat(page, '小待');

    const target = externalFile('kepcup-e2e-pending-');
    llm.script('mock-main', [
      step().replyToolCall('read', { path: target }),
      step().replyText('被拒了就算了'),
    ]);

    const composer = page.locator('[data-testid="composer-input"]');
    await composer.fill('读外部');
    await composer.press('ControlOrMeta+Enter');

    const card = page.locator('[data-testid^="approval-card-"]');
    await expect(card).toBeVisible({ timeout: 60_000 });

    // 左栏对话项出现「有待确认」标记。
    await expect(page.locator('[data-testid="pending-badge"]').first()).toBeVisible({
      timeout: 15_000,
    });

    // Esc 拒绝；卡片折叠为已拒绝记录，run 继续完成。
    await card.press('Escape');
    await expect(page.locator('[data-testid^="approval-record-"]')).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.locator('[data-testid="chat-view"]').getByText('被拒了就算了')).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.locator('[data-testid="pending-badge"]')).toBeHidden();
  } finally {
    await closeSession(session);
  }
});

test('unattended mode: enable dialog requires the risk checkbox, banner shows, summary on close', async () => {
  test.setTimeout(180_000);
  const session = await startSession('kepcup-e2e-unattended-');
  const { page, llm } = session;
  try {
    await waitReady(page);
    await page.locator('[data-testid="user-menu-trigger"]').click();
    await page.locator('[data-testid="menu-settings"]').click();
    await expect(page.locator('[data-testid="settings-page-content"]')).toBeVisible();
    await page.locator('[data-testid="settings-nav-unattended"]').click();

    await page.locator('[data-testid="unattended-open-dialog"]').click();
    const dialog = page.locator('[data-testid="unattended-enable-dialog"]');
    await expect(dialog).toBeVisible();

    // 未勾选风险确认时不能开启。
    const confirm = page.locator('[data-testid="unattended-confirm-enable"]');
    await expect(confirm).toBeDisabled();
    await page.locator('[data-testid="unattended-acknowledge"]').click();
    await expect(confirm).toBeEnabled();
    await confirm.click();

    // 横幅出现（全局）。
    await expect(page.locator('[data-testid="unattended-banner"]')).toBeVisible({
      timeout: 15_000,
    });

    // 开启期间审批自动批准：让 Bot 发起一次访问授权。
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="settings-dialog"]')).toBeHidden();
    await createBotAndOpenChat(page, '小无');
    const target = externalFile('kepcup-e2e-unattended-');
    llm.script('mock-main', [
      step().replyToolCall('read', { path: target }),
      step().replyText('自动批准了'),
    ]);
    const composer = page.locator('[data-testid="composer-input"]');
    await composer.fill('读外部文件');
    await composer.press('ControlOrMeta+Enter');
    await expect(page.locator('[data-testid="chat-view"]').getByText('自动批准了')).toBeVisible({
      timeout: 120_000,
    });
    await expect(page.locator('[data-testid^="approval-record-"]')).toContainText('无人值守', {
      timeout: 15_000,
    });

    // 关闭后弹出汇总（设置弹框仍开着：先关再从菜单重开到无人值守分组）。
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="settings-dialog"]')).toBeHidden();
    await page.locator('[data-testid="user-menu-trigger"]').click();
    await page.locator('[data-testid="menu-settings"]').click();
    await page.locator('[data-testid="settings-nav-unattended"]').click();
    await page.locator('[data-testid="unattended-disable"]').click();
    await expect(page.locator('[data-testid="unattended-summary-dialog"]')).toBeVisible({
      timeout: 15_000,
    });
    await page.locator('[data-testid="unattended-summary-close"]').click();
    await expect(page.locator('[data-testid="unattended-banner"]')).toBeHidden();
  } finally {
    await closeSession(session);
  }
});
