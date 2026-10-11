import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page, _electron } from '@playwright/test';
import { startMockLlm, step, type MockLlmServer } from '@kepcup/testkit';

/**
 * 窄屏布局（features/shell/narrow-layout，docs/design/33-narrow-layout.md）：
 * - 窗口拉窄（<640px）即时切换为手机式单栏：底部全局 tab（对话 / 通讯录 /
 *   扩展 / 我），宽屏的调宽手柄消失；
 * - 「对话」tab 两层导航：列表 ↔ 会话详情，详情层隐藏 tab 栏、左上角返回；
 * - 详情顶部 Bot 药丸打开 Bot 详情覆盖层（宽屏右栏的 RightPanel 内容）；
 * - 会话可带消息重进（Tooltip.Provider 由 NarrowShell 提供，消息行不崩）；
 * - 搜索 / 「+」在窄屏是全屏浮层（不再弹框 / 浮板）；
 * - 通讯录 / 我页复用设置分区；设置在窄屏是全屏页（分组列表 ↔ 详情页）：
 *   深链不带分区落列表页、带分区直达详情页，通讯录 / 用户画像直达 tab；
 * - 扩展 tab 整页复用扩展中心分组主体；通讯录卡片不横向溢出；
 * - 拉回宽屏恢复双栏；全程无渲染错误。
 */

/** 截图输出目录（视觉复核用，不入库）。 */
const SHOT_DIR = '/tmp/kepcup-narrow-shots';

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
  await expect(
    page.locator('[data-testid="chat-view"]').or(page.locator('[data-testid="start-chat-panel"]')),
  ).toBeVisible({ timeout: 60_000 });
  const startBackdrop = page.locator('[data-testid="start-chat-backdrop"]');
  if (await startBackdrop.isVisible()) {
    await startBackdrop.click({ timeout: 2_000 }).catch(() => {});
  }
  await expect(page.locator('[data-testid="start-chat-backdrop"]')).toHaveCount(0);
}

/** 拉伸主窗口到指定内容尺寸（Electron BrowserWindow.setSize）。 */
async function resizeWindow(
  app: ElectronApplication,
  width: number,
  height: number,
): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height);
    },
    { width, height },
  );
}

/** 等 toast 全部退场再截图（避免横贯底部的提示条挡住 tab 栏）。 */
async function waitForToastsGone(page: Page): Promise<void> {
  await expect(page.locator('[data-sonner-toast]')).toHaveCount(0, { timeout: 10_000 });
}

/** 等当前项颜色过渡（tab 栏 transition-colors 150ms）完成再截图。 */
async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(400);
}

/** 通过界面建一个 Bot 并直接进入其对话（高级新建表单，窄屏下同样可达）。 */
async function createBotAndOpenChat(page: Page, name: string): Promise<void> {
  await page.locator('[data-testid="new-chat-button"]').click();
  await page.locator('[data-testid="bot-create-form"]').click();
  await expect(page.locator('[data-testid="bot-create-dialog"]')).toBeVisible();
  await page.locator('[data-testid="bot-create-dialog"] [data-testid="bot-name-input"]').fill(name);
  await page.locator('[data-testid="bot-create-save"]').click();
  await expect(page.locator('[data-testid="chat-view"]')).toBeVisible({ timeout: 15_000 });
}

test('narrow layout: single column, bottom tabs, detail layers, fullscreen overlays', async () => {
  test.setTimeout(240_000);
  const llm: MockLlmServer = await startMockLlm();
  const home = await mkdtemp(path.join(tmpdir(), 'kepcup-e2e-narrow-'));
  await mkdir(SHOT_DIR, { recursive: true });
  const { app, page } = await launchApp({ home, llmUrl: llm.url });
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  try {
    await waitReady(page);

    // 宽屏基线：双栏（侧栏 + 聊天区），无窄屏外壳。
    await expect(page.locator('[data-testid="sidebar-resize-handle"]')).toBeVisible();
    await expect(page.locator('[data-testid="narrow-shell"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="narrow-tab-bar"]')).toHaveCount(0);

    // 拉窄到手机宽：单栏外壳 + 底部全局 tab（四个都在）。
    await resizeWindow(app, 375, 812);
    await expect(page.locator('[data-testid="narrow-shell"]')).toBeVisible();
    await expect(page.locator('[data-testid="narrow-tab-bar"]')).toBeVisible();
    await expect(page.locator('[data-testid="narrow-tab-chats"]')).toBeVisible();
    await expect(page.locator('[data-testid="narrow-tab-contacts"]')).toBeVisible();
    await expect(page.locator('[data-testid="narrow-tab-extensions"]')).toBeVisible();
    await expect(page.locator('[data-testid="narrow-tab-me"]')).toBeVisible();
    // 列表层：无返回按钮、无调宽手柄（宽度跟窗口）。
    await expect(page.locator('[data-testid="narrow-back-button"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="sidebar-resize-handle"]')).toHaveCount(0);

    // 搜索：全屏浮层（不是弹框），返回关闭。
    await page.locator('[data-testid="sidebar-search-button"]').click();
    await expect(page.locator('[data-testid="global-search-layer"]')).toBeVisible();
    await expect(page.locator('[data-testid="global-search-dialog"]')).toHaveCount(0);
    await page.locator('[data-testid="global-search-back"]').click();
    await expect(page.locator('[data-testid="global-search-layer"]')).toHaveCount(0);

    // 「+」：全屏浮层，返回关闭。
    await page.locator('[data-testid="new-chat-button"]').click();
    await expect(page.locator('[data-testid="start-chat-layer"]')).toBeVisible();
    await expect(page.locator('[data-testid="start-chat-backdrop"]')).toHaveCount(0);
    await page.locator('[data-testid="start-chat-layer-back"]').click();
    await expect(page.locator('[data-testid="start-chat-layer"]')).toHaveCount(0);

    // 新建 Bot → 自动进入会话详情层：tab 栏隐藏、左上角返回、顶部 Bot 药丸。
    await createBotAndOpenChat(page, '窄屏助手');
    await expect(page.locator('[data-testid="chat-view"]')).toBeVisible();
    await expect(page.locator('[data-testid="narrow-tab-bar"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="narrow-back-button"]')).toBeVisible();
    await expect(page.locator('[data-testid="right-panel-toggle"]')).toBeVisible();

    // 发一条消息并等 mock 回复：为 Tooltip 回归准备「带消息的会话」。
    // （Cmd/Ctrl+Enter 立即发送；Enter 是入队草稿。）
    llm.script('mock-main', [step().replyText('窄屏回复成功')]);
    const composerInput = page.locator('[data-testid="composer-input"]');
    await composerInput.fill('你好');
    await composerInput.press('Meta+Enter');
    await expect(page.locator('[data-testid="bot-bubble"]').first()).toContainText('窄屏回复成功', {
      timeout: 30_000,
    });
    // 窄屏不渲染 hover 操作钮（引用/复制/固定/编辑只留右键菜单入口）。
    await expect(page.locator('[data-testid="message-actions"]')).toHaveCount(0);
    await waitForToastsGone(page);
    await page.screenshot({ path: path.join(SHOT_DIR, '01-chat-detail.png') });

    // 药丸 → Bot 详情覆盖层（宽屏右栏内容），tab 栏仍隐藏；✕ 关闭回详情。
    await page.locator('[data-testid="right-panel-toggle"]').click();
    const overlay = page.locator('[data-testid="narrow-bot-detail"]');
    await expect(overlay).toBeVisible();
    await expect(overlay.locator('[data-testid="right-panel"]')).toBeVisible();
    await expect(overlay.locator('[data-testid="bot-avatar"]')).toBeVisible();
    await expect(page.locator('[data-testid="narrow-tab-bar"]')).toHaveCount(0);
    await page.screenshot({ path: path.join(SHOT_DIR, '02-bot-overlay.png') });
    await overlay.locator('[data-testid="right-panel-hide"]').click();
    await expect(overlay).toHaveCount(0);
    await expect(page.locator('[data-testid="chat-view"]')).toBeVisible();

    // 返回 → 列表层：tab 栏回归，会话条目在。
    await page.locator('[data-testid="narrow-back-button"]').click();
    await expect(page.locator('[data-testid="chat-view"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="narrow-tab-bar"]')).toBeVisible();
    await expect(page.locator('[data-testid="conversation-name"]')).toContainText('窄屏助手');
    await page.screenshot({ path: path.join(SHOT_DIR, '03-chat-list.png') });

    // Tooltip 回归：重进带消息的会话，消息行渲染不崩（Provider 由 NarrowShell 提供）。
    await page.locator('[data-testid^="conversation-item-"]').first().click();
    await expect(page.locator('[data-testid="chat-view"]')).toBeVisible();
    await expect(page.getByText('窄屏回复成功')).toBeVisible();
    await page.locator('[data-testid="narrow-back-button"]').click();

    // 通讯录 tab：复用设置「通讯录」分区；卡片不横向溢出（全部在视口内）。
    await page.locator('[data-testid="narrow-tab-contacts"]').click();
    await expect(page.locator('[data-testid="narrow-contacts-page"]')).toBeVisible();
    await expect(page.locator('[data-testid="bot-card-name"]')).toContainText('窄屏助手');
    const cardBox = (await page.locator('[data-testid^="bot-card-"]').first().boundingBox())!;
    expect(cardBox.x).toBeGreaterThanOrEqual(0);
    expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(375);
    await settle(page);
    await page.screenshot({ path: path.join(SHOT_DIR, '04-contacts.png') });
    await page.locator('[data-testid^="bot-open-"]').click();
    await expect(page.locator('[data-testid="chat-view"]')).toBeVisible();
    await expect(page.locator('[data-testid="narrow-tab-bar"]')).toHaveCount(0);
    await page.locator('[data-testid="narrow-back-button"]').click();

    // 扩展 tab：整页分组主体（Skills / 连接 / MCP），不弹扩展中心弹框；
    // 顶部无标题（红绿灯拖拽带占位）。
    await page.locator('[data-testid="narrow-tab-extensions"]').click();
    await expect(page.locator('[data-testid="narrow-extensions-page"]')).toBeVisible();
    await expect(page.locator('[data-testid="extension-center-tabs"]')).toBeVisible();
    await expect(page.locator('[data-testid="extension-center-dialog"]')).toHaveCount(0);
    await settle(page);
    await page.screenshot({ path: path.join(SHOT_DIR, '05-extensions.png') });

    // 我 tab：用户画像 + 设置入口；设置在窄屏是全屏页：分组列表（无通讯录 /
    // 用户画像两项）→ 点「通用」进详情 → 返回列表 → 返回关闭。
    await page.locator('[data-testid="narrow-tab-me"]').click();
    await expect(page.locator('[data-testid="narrow-me-page"]')).toBeVisible();
    await expect(page.locator('[data-testid="settings-profile"]')).toBeVisible();
    await settle(page);
    await page.screenshot({ path: path.join(SHOT_DIR, '06-me.png') });
    await page.locator('[data-testid="narrow-me-settings"]').click();
    const settingsPage = page.locator('[data-testid="narrow-settings-page"]');
    await expect(settingsPage).toBeVisible();
    await expect(page.locator('[data-testid="narrow-settings-list"]')).toBeVisible();
    await expect(page.locator('[data-testid="narrow-settings-item-contacts"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="narrow-settings-item-profile"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="narrow-settings-item-general"]')).toBeVisible();
    await settle(page);
    await page.screenshot({ path: path.join(SHOT_DIR, '07-settings.png') });
    await page.locator('[data-testid="narrow-settings-item-general"]').click();
    const settingsContent = page.locator('[data-testid="narrow-settings-content"]');
    await expect(settingsContent).toBeVisible();
    await expect(settingsContent.locator('[data-settings-section="general"]')).toBeVisible();
    // 详情页返回 → 列表；列表返回 → 关页面。
    await page.locator('[data-testid="narrow-settings-back"]').click();
    await expect(page.locator('[data-testid="narrow-settings-list"]')).toBeVisible();
    await page.locator('[data-testid="narrow-settings-back"]').click();
    await expect(settingsPage).toHaveCount(0);

    // 深链直达：全局搜索里的「默认模型」设置条目 → 直达模型分组详情页；
    // Esc 在详情页回列表、列表页关页面。（搜索入口在对话 tab 的列表页。）
    await page.locator('[data-testid="narrow-tab-chats"]').click();
    await expect(page.locator('[data-testid="sidebar-search-button"]')).toBeVisible();
    await page.locator('[data-testid="sidebar-search-button"]').click();
    await page.locator('[data-testid="global-search-input"]').fill('默认模型');
    await page.locator('[data-testid^="global-search-item-settings-"]').first().click();
    await expect(settingsPage).toBeVisible();
    const modelsContent = page.locator('[data-testid="narrow-settings-content"]');
    await expect(modelsContent.locator('[data-settings-section="models"]')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="narrow-settings-list"]')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(settingsPage).toHaveCount(0);

    // 返回已清当前会话：切回对话 tab 是列表层（详情层无 tab 栏，出详情只能
    // 走左上角返回或药丸——预期行为）。
    await page.locator('[data-testid="narrow-tab-chats"]').click();
    await expect(page.locator('[data-testid^="conversation-item-"]').first()).toBeVisible();
    await expect(page.locator('[data-testid="narrow-tab-bar"]')).toBeVisible();

    // 再进详情后拉回宽屏：恢复双栏布局，会话详情仍在（回到上次会话）；
    // hover 操作钮恢复渲染（DOM 常驻、hover 显形）。
    await page.locator('[data-testid^="conversation-item-"]').first().click();
    await expect(page.locator('[data-testid="chat-view"]')).toBeVisible();
    await resizeWindow(app, 1280, 840);
    await expect(page.locator('[data-testid="narrow-shell"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="sidebar-resize-handle"]')).toBeVisible();
    await expect(page.locator('[data-testid="chat-view"]')).toBeVisible();
    await expect(page.locator('[data-testid="message-actions"]').first()).toBeAttached();
    await page.screenshot({ path: path.join(SHOT_DIR, '08-wide-restored.png') });

    // 全程无渲染错误（如窄屏缺 Tooltip.Provider 的崩溃）。
    expect(pageErrors).toEqual([]);
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
    await llm.stop();
  }
});
