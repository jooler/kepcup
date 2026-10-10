import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page, _electron } from '@playwright/test';
import { startMockLlm, type MockLlmServer } from '@kepcup/testkit';

/**
 * 左栏拖拽调宽（features/sidebar/sidebar-layout）：
 * - 右缘手柄拖到最小宽（macOS 红绿灯占位 80px）吸附为图标模式：顶部搜索
 *   隐藏、「+」移到底部、对话只剩头像且 hover 出名称/预览提示；
 * - 双击手柄复位默认宽；中间宽度释放原样保留；
 * - 宽度落 localStorage，重启应用后恢复。
 */

/** 最小宽 = macOS 红绿灯占位（sidebar-layout.ts 的 SIDEBAR_MIN_WIDTH）。 */
const MIN_WIDTH = 80;
/** 默认宽 = 套件 SIDEBAR_WIDTH（17.5rem）。 */
const DEFAULT_WIDTH = 280;

interface LaunchedApp {
  app: ElectronApplication;
  page: Page;
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
  return { app, page };
}

async function waitReady(page: Page): Promise<void> {
  await expect(page.locator('[data-testid="app-shell"]')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('[data-testid="ping-result"]')).toContainText('ping ✓', {
    timeout: 60_000,
  });
  // 等启动恢复收尾（chat-view / 空态「+」面板）再交互，避免 backdrop 拦点击。
  await expect(
    page.locator('[data-testid="chat-view"]').or(page.locator('[data-testid="start-chat-panel"]')),
  ).toBeVisible({ timeout: 60_000 });
  const startBackdrop = page.locator('[data-testid="start-chat-backdrop"]');
  if (await startBackdrop.isVisible()) {
    await startBackdrop.click({ timeout: 2_000 }).catch(() => {});
  }
  await expect(page.locator('[data-testid="start-chat-backdrop"]')).toHaveCount(0);
}

/** 通过界面建一个 Bot 并直接进入其对话（高级新建表单）。 */
async function createBotAndOpenChat(page: Page, name: string): Promise<void> {
  await page.locator('[data-testid="new-chat-button"]').click();
  await page.locator('[data-testid="bot-create-form"]').click();
  await expect(page.locator('[data-testid="bot-create-dialog"]')).toBeVisible();
  await page.locator('[data-testid="bot-create-dialog"] [data-testid="bot-name-input"]').fill(name);
  await page.locator('[data-testid="bot-create-save"]').click();
  await expect(page.locator('[data-testid="chat-view"]')).toBeVisible({ timeout: 15_000 });
}

/** 沿右缘手柄横向拖到指定窗口 x 坐标后松手（宽度 = x - 侧栏左缘）。 */
async function dragHandleTo(page: Page, x: number): Promise<void> {
  const box = (await page.locator('[data-testid="sidebar-resize-handle"]').boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 6 });
  await page.mouse.up();
}

test('sidebar drag-resize: icon mode at min width, double-click reset, persistence', async () => {
  test.setTimeout(240_000);
  const llm: MockLlmServer = await startMockLlm();
  const home = await mkdtemp(path.join(tmpdir(), 'kepcup-e2e-sidebar-'));
  let app = (await launchApp({ home, llmUrl: llm.url })).app;
  try {
    let page = await app.firstWindow();
    await waitReady(page);
    await createBotAndOpenChat(page, '小宽');

    const sidebar = page.locator('[data-testid="sidebar"]');
    const searchButton = page.locator('[data-testid="sidebar-search-button"]');

    // 默认 280px：搜索/新增都在顶部，条目带名称与预览。
    await expect(sidebar).toHaveCSS('width', `${DEFAULT_WIDTH}px`);
    await expect(searchButton).toBeVisible();
    await expect(page.locator('[data-testid="conversation-name"]')).toContainText('小宽');

    // 拖到最左：吸附为最小宽（红绿灯占位），进入图标模式。
    await dragHandleTo(page, 10);
    await expect(sidebar).toHaveCSS('width', `${MIN_WIDTH}px`);
    await expect(searchButton).toHaveCount(0);
    await expect(page.locator('[data-testid="conversation-preview"]')).toHaveCount(0);

    // 「+」移到底部（y 过侧栏中线），样式与参考一致只余图标。
    const newButton = page.locator('[data-testid="new-chat-button"]');
    await expect(newButton).toBeVisible();
    const newBox = (await newButton.boundingBox())!;
    const sideBox = (await sidebar.boundingBox())!;
    expect(newBox.y + newBox.height / 2).toBeGreaterThan(sideBox.y + sideBox.height / 2);

    // 对话只剩头像；hover 出名称/预览提示。
    const item = page.locator('[data-testid^="conversation-item-"]').first();
    await expect(item.locator('[data-testid="conversation-avatar"]')).toBeVisible();
    await item.hover();
    const tooltip = page.locator('[data-slot="tooltip-content"]');
    await expect(tooltip).toContainText('小宽');

    // 底部扩展中心收成图标（无文字）。
    await expect(page.locator('[data-testid="extension-center-button"]')).toHaveText('');

    // 图标模式下「+」面板贴着窄栏右侧展开。
    await newButton.click();
    const panel = page.locator('[data-testid="start-chat-panel"]');
    await expect(panel).toBeVisible();
    expect((await panel.boundingBox())!.x).toBeGreaterThanOrEqual(MIN_WIDTH);
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);

    // 双击手柄复位默认宽：搜索按钮回到顶部。
    await page.locator('[data-testid="sidebar-resize-handle"]').dblclick();
    await expect(sidebar).toHaveCSS('width', `${DEFAULT_WIDTH}px`);
    await expect(searchButton).toBeVisible();

    // 中间宽度释放原样保留，并落 localStorage：重启后恢复。
    await dragHandleTo(page, 220);
    await expect(sidebar).toHaveCSS('width', '220px');
    await app.close();

    app = (await launchApp({ home, llmUrl: llm.url })).app;
    page = await app.firstWindow();
    await waitReady(page);
    await expect(page.locator('[data-testid="sidebar"]')).toHaveCSS('width', '220px');
  } finally {
    await app.close();
    await llm.stop();
    await rm(home, { recursive: true, force: true });
  }
});
