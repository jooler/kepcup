import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page, _electron } from '@playwright/test';

interface LaunchedApp {
  app: ElectronApplication;
  page: Page;
  home: string;
}

async function launchApp(): Promise<LaunchedApp> {
  const home = await mkdtemp(path.join(tmpdir(), 'kepcup-e2e-'));
  const app = await _electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      KEPCUP_HOME: home,
      NODE_ENV: 'test',
      KEPCUP_KEYSTORE: 'memory',
      KEPCUP_ONBOARDING: 'off',
    },
  });
  const page = await app.firstWindow();
  return { app, page, home };
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

/** 1×1 PNG（红色像素），上传 fixture。 */
const PNG_1PX_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('avatar: preset picker applies instantly, reset restores default, upload persists and inline edits save', async () => {
  test.setTimeout(120_000);
  const { app, page, home } = await launchApp();
  const uploadPng = path.join(home, 'upload-fixture.png');
  await writeFile(uploadPng, Buffer.from(PNG_1PX_BASE64, 'base64'));
  try {
    await waitReady(page);
    await page
      .locator('[data-testid="start-chat-backdrop"]')
      .click({ timeout: 15_000 })
      .catch(() => {});

    await page.locator('[data-testid="new-chat-button"]').click();
    await page.locator('[data-testid="bot-create-form"]').click();
    await page
      .locator('[data-testid="bot-create-dialog"] [data-testid="bot-name-input"]')
      .fill('小启');
    await page.locator('[data-testid="bot-create-save"]').click();
    await expect(page.locator('[data-testid="chat-view"]')).toBeVisible({ timeout: 15_000 });
    // 右栏（Bot 详情）默认收起：经顶部药丸展开再操作。
    await page.locator('[data-testid="right-panel-toggle"]').click();
    await expect(
      page.locator('[data-testid="right-panel"] [data-testid="bot-name-edit"]'),
    ).toHaveText('小启');

    // 预置页签：默认「第一个形状 + 第一种颜色」带选中标记。
    await page.locator('[data-testid="bot-avatar-button"]').click();
    const picker = page.locator('[data-testid="avatar-picker"]');
    await expect(picker).toBeVisible();
    await expect(page.locator('[data-testid="avatar-shape-orb"]')).toHaveClass(/ring-2/);
    await expect(page.locator('[data-testid="avatar-color-mono"]')).toHaveClass(/ring-2/);

    // 换形状 + 换颜色即时生效（SVG 预置头像出现在右栏、顶部药丸、左栏）。
    await page.locator('[data-testid="avatar-shape-spark"]').click();
    await page.locator('[data-testid="avatar-color-blue"]').click();
    await expect(page.locator('[data-testid="bot-avatar"] svg')).toBeVisible();
    await expect(page.locator('[data-testid="conversation-avatar"] svg')).toBeVisible();

    // Reset 回默认（第一个形状 + 第一种颜色）。
    await page.locator('[data-testid="avatar-reset"]').click();
    await expect(page.locator('[data-testid="avatar-shape-orb"]')).toHaveClass(/ring-2/);
    await expect(page.locator('[data-testid="avatar-color-mono"]')).toHaveClass(/ring-2/);

    // 上传页签：真实走 core 落盘（bots/{id}/avatar/），右栏出现 <img> 头像。
    await page.locator('[data-testid="avatar-tab-upload"]').click();
    await page.locator('[data-testid="avatar-upload-input"]').setInputFiles(uploadPng);
    await expect(page.locator('[data-testid="bot-avatar"] img')).toBeVisible({ timeout: 15_000 });
    await expect(picker).toBeHidden();

    // 名称 / 简介点按直编：Enter 保存并全界面同步。
    await page.locator('[data-testid="bot-name-edit"]').click();
    await page.locator('[data-testid="bot-name-inline-input"]').fill('小诚');
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-testid="bot-name-edit"]')).toHaveText('小诚', {
      timeout: 15_000,
    });
    await expect(page.locator('[data-testid="conversation-name"]')).toHaveText('小诚');

    await page.locator('[data-testid="bot-bio-edit"]').click();
    await page.locator('[data-testid="bot-bio-inline-input"]').fill('可靠、务实');
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-testid="bot-bio-edit"]')).toHaveText('可靠、务实');

    // 名称直编写入的是 profile 持久层：重开右栏（收起再展开）后仍在。
    await page.locator('[data-testid="right-panel-hide"]').click();
    await page.locator('[data-testid="right-panel-toggle"]').click();
    await expect(
      page.locator('[data-testid="right-panel"] [data-testid="bot-name-edit"]'),
    ).toHaveText('小诚');
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});
