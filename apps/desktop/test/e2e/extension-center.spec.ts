import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page, _electron } from '@playwright/test';
import { startMockLlm } from '@kepcup/testkit';

/**
 * 扩展中心分组 e2e（X1–X4，设计 29 §16）：
 * - 三个分组：Skills / 连接 / MCP；
 * - 「连接」只有目录卡片，没有「填 URL」入口；
 * - 「MCP」是已安装 MCP 的管理视图，没有「新建 server」入口；
 * - 自定义入口只在「设置 → 开发者模式」打开后出现；设置「应用」只管已连接账号，
 *   并能跳到扩展中心「连接」。
 * e2e 跑的是 electron-vite 构建产物，带发行门禁（`connector-release-gates.json` 当前为空）：
 * 「连接」组应显示空态、一张卡片都不出现；开发构建不过滤（core 单测覆盖门禁语义）。
 */

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

async function openSettings(page: Page, section: string): Promise<void> {
  await page.locator('[data-testid="user-menu-trigger"]').click();
  await page.locator('[data-testid="menu-settings"]').click();
  await expect(page.locator('[data-testid="settings-page-content"]')).toBeVisible();
  await page.locator(`[data-testid="settings-nav-${section}"]`).click();
}

test('extension center: three groups, no free-form URL entry, custom MCP only behind developer mode', async () => {
  test.setTimeout(240_000);
  const llm = await startMockLlm();
  const home = await mkdtemp(path.join(tmpdir(), 'kepcup-e2e-extcenter-'));
  let app: ElectronApplication | null = null;
  try {
    app = await _electron.launch({
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
    await waitReady(page);

    const dialog = page.locator('[data-testid="extension-center-dialog"]');
    await page.locator('[data-testid="extension-center-button"]').click();
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('[data-testid="extension-center-tab-skills"]')).toHaveAttribute(
      'aria-selected',
      'true',
    );

    // 连接：打包后的构建带发行门禁（放行清单为空）→ 目录里一条都不可见，显示空态；
    // 没有填 URL 的入口。
    await dialog.locator('[data-testid="extension-center-tab-connections"]').click();
    await expect(dialog.locator('[data-testid="apps-catalog-none"]')).toHaveText(
      '暂无已适配的应用',
      {
        timeout: 30_000,
      },
    );
    await expect(dialog.locator('[data-testid^="apps-catalog-card-"]')).toHaveCount(0);
    await expect(dialog.locator('[data-testid="mcp-add"]')).toHaveCount(0);
    await expect(dialog.locator('[data-testid="mcp-new-kind"]')).toHaveCount(0);

    // MCP：管理视图（可装 .mcpb），没有新建 server / BYO 客户端入口。
    await dialog.locator('[data-testid="extension-center-tab-mcp"]').click();
    await expect(dialog.locator('[data-testid="mcp-section"]')).toBeVisible();
    await expect(dialog.locator('[data-testid="mcp-empty"]')).toBeVisible();
    await expect(dialog.locator('[data-testid="mcp-add"]')).toHaveCount(0);
    await expect(dialog.locator('[data-testid="mcp-new-kind"]')).toHaveCount(0);
    await expect(dialog.locator('[data-testid="mcp-dev-mode"]')).toHaveCount(0);

    // 键盘：方向键切换分组。
    await dialog.locator('[data-testid="extension-center-tab-mcp"]').press('ArrowRight');
    await expect(dialog.locator('[data-testid="extension-center-tab-skills"]')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden({ timeout: 15_000 });

    // 设置 → 应用：只管已连接账号，带去扩展中心的入口。
    await openSettings(page, 'apps');
    await expect(page.locator('[data-testid="apps-section"]')).toBeVisible();
    await expect(page.locator('[data-testid="apps-tabs"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="mcp-section"]')).toHaveCount(0);

    // 设置 → 开发者模式：默认关，自定义入口隐藏；打开后出现。
    await page.locator('[data-testid="settings-nav-developer"]').click();
    await expect(page.locator('[data-testid="developer-section"]')).toBeVisible();
    await expect(page.locator('[data-testid="developer-off-hint"]')).toBeVisible();
    await expect(page.locator('[data-testid="mcp-add"]')).toHaveCount(0);
    await page.locator('[data-testid="mcp-dev-mode"]').click();
    await expect(page.locator('[data-testid="mcp-add"]')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid="mcp-new-kind"]')).toBeVisible();

    // 关掉再看：入口重新隐藏。
    await page.locator('[data-testid="mcp-dev-mode"]').click();
    await expect(page.locator('[data-testid="mcp-add"]')).toHaveCount(0, { timeout: 15_000 });

    // 应用分区的横条 → 扩展中心「连接」分组（设置弹框先收起）。
    await page.locator('[data-testid="settings-nav-apps"]').click();
    await page.locator('[data-testid="apps-open-extension-center"]').click();
    await expect(page.locator('[data-testid="settings-dialog"]')).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(
      dialog.locator('[data-testid="extension-center-tab-connections"]'),
    ).toHaveAttribute('aria-selected', 'true');
  } finally {
    await app?.close();
    await llm.stop();
    await rm(home, { recursive: true, force: true });
  }
});
