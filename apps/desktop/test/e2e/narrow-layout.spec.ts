import { mkdir, mkdtemp } from 'node:fs/promises';
import { rmHomeTolerant } from './helpers/home-cleanup';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page, _electron } from '@playwright/test';
import { startMockLlm, step, type MockLlmServer } from '@kepcup/testkit';
import { createBotAndOpenChat } from './helpers/create-bot';

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
 *
 * 第二个用例（审查修复轮）：会话详情里的扩展中心深链、全屏层的 Esc 层级仲裁、搜索层的
 * 焦点约束与 Cmd+K 全局可用、drag 区结构性断言、移除 Bot 后覆盖层收起、宽窄切换时
 * 设置类浮层复位、滞回断点、窄窗口下聊天区可用宽度。
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
      TZ: 'Asia/Shanghai',
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

/**
 * 结构性断言：页面上「用户实际看得见、点得到」的可交互控件，其有效 -webkit-app-region
 * 不得是 drag。Electron 把 drag 区矩形当窗口拖拽区，区内的输入框 / 按钮真实鼠标点击、
 * 框选会被吞（Playwright 的 CDP 点击绕过窗口系统，测不出）。
 *
 * 有效区域按 Electron 的规则模拟：所有声明了 drag / no-drag 的元素按 DOM 顺序收集矩形，
 * 点上最后（DOM 顺序）包含该点的矩形胜出；无矩形包含 = 非拖拽。只检查 elementFromPoint
 * 命中自身（未被其它层盖住）的控件，所以同时覆盖「下层 drag 矩形延伸到上层全屏层」的情形。
 */
async function dragRegionViolations(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const regionOf = (el: Element): string =>
      getComputedStyle(el).getPropertyValue('-webkit-app-region').trim();
    const regions: Array<{ rect: DOMRect; drag: boolean }> = [];
    for (const el of Array.from(document.querySelectorAll('*'))) {
      const value = regionOf(el);
      if (value !== 'drag' && value !== 'no-drag') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      regions.push({ rect, drag: value === 'drag' });
    }
    const violations: string[] = [];
    const controls = document.querySelectorAll(
      'input:not([type=hidden]), textarea, select, button, a[href], [role=tab], [role=button]',
    );
    for (const el of Array.from(controls)) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue;
      const hit = document.elementFromPoint(x, y);
      if (hit === null || !(hit === el || el.contains(hit))) continue;
      let drag = false;
      for (const region of regions) {
        const r = region.rect;
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) drag = region.drag;
      }
      if (drag) {
        violations.push(
          el.getAttribute('data-testid') ?? `${el.tagName.toLowerCase()}.${el.className}`,
        );
      }
    }
    return violations;
  });
}

/** 焦点是否在指定容器内。 */
async function focusInside(page: Page, testid: string): Promise<boolean> {
  return page.evaluate(
    (id) => document.activeElement?.closest(`[data-testid="${id}"]`) != null,
    testid,
  );
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
    // 深链直达的详情页 Esc / 返回一次直接关闭（回到来源页，不必先回分组列表）。
    // （搜索入口在对话 tab 的列表页。）
    await page.locator('[data-testid="narrow-tab-chats"]').click();
    await expect(page.locator('[data-testid="sidebar-search-button"]')).toBeVisible();
    await page.locator('[data-testid="sidebar-search-button"]').click();
    await page.locator('[data-testid="global-search-input"]').fill('默认模型');
    await page.locator('[data-testid^="global-search-item-settings-"]').first().click();
    await expect(settingsPage).toBeVisible();
    const modelsContent = page.locator('[data-testid="narrow-settings-content"]');
    await expect(modelsContent.locator('[data-settings-section="models"]')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(settingsPage).toHaveCount(0);
    // 再走一次，用返回按钮：同样一次回到来源页。
    await page.locator('[data-testid="sidebar-search-button"]').click();
    await page.locator('[data-testid="global-search-input"]').fill('默认模型');
    await page.locator('[data-testid^="global-search-item-settings-"]').first().click();
    await expect(settingsPage).toBeVisible();
    await page.locator('[data-testid="narrow-settings-back"]').click();
    await expect(settingsPage).toHaveCount(0);
    // 从「我」页进设置列表再点进分组：Esc 先回列表、再关页面。
    await page.locator('[data-testid="narrow-tab-me"]').click();
    await page.locator('[data-testid="narrow-me-settings"]').click();
    await page.locator('[data-testid="narrow-settings-item-general"]').click();
    await expect(page.locator('[data-testid="narrow-settings-content"]')).toBeVisible();
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

    // 窄屏「返回列表」（chat.leaveCurrent）后拉回宽屏：恢复上次查看的会话——
    // 宽屏没有列表层，右侧聊天区不该空着。
    await resizeWindow(app, 375, 812);
    await expect(page.locator('[data-testid="narrow-shell"]')).toBeVisible();
    await page.locator('[data-testid="narrow-back-button"]').click();
    await expect(page.locator('[data-testid="chat-view"]')).toHaveCount(0);
    await resizeWindow(app, 1280, 840);
    await expect(page.locator('[data-testid="chat-view"]')).toBeVisible();

    // 全程无渲染错误（如窄屏缺 Tooltip.Provider 的崩溃）。
    expect(pageErrors).toEqual([]);
  } finally {
    await app.close();
    await rmHomeTolerant(home);
    await llm.stop();
  }
});

test('narrow layout: deep links in detail, Esc layering, focus containment, layout switches', async () => {
  test.setTimeout(300_000);
  const llm: MockLlmServer = await startMockLlm();
  const home = await mkdtemp(path.join(tmpdir(), 'kepcup-e2e-narrow2-'));
  const { app, page } = await launchApp({ home, llmUrl: llm.url });
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const overlay = page.locator('[data-testid="narrow-bot-detail"]');
  const settingsPage = page.locator('[data-testid="narrow-settings-page"]');
  const searchLayer = page.locator('[data-testid="global-search-layer"]');
  try {
    await waitReady(page);
    await resizeWindow(app, 375, 812);
    await expect(page.locator('[data-testid="narrow-shell"]')).toBeVisible();
    await createBotAndOpenChat(page, '层级助手');

    // --- 审查 #1：会话详情里的 openExtensionCenter 深链不再被弹回对话 tab ----------
    await page.locator('[data-testid="right-panel-toggle"]').click();
    await expect(overlay).toBeVisible();
    await overlay.locator('#tab-skills').click();
    await overlay.locator('[data-testid="skills-open-market"]').click();
    await expect(page.locator('[data-testid="narrow-extensions-page"]')).toBeVisible();
    await expect(overlay).toHaveCount(0);
    await expect(page.locator('[data-testid="narrow-tab-bar"]')).toBeVisible();
    await page.waitForTimeout(500); // 回归点是「随后被弹回」：多等一会儿再断言。
    await expect(page.locator('[data-testid="narrow-extensions-page"]')).toBeVisible();
    // 回到对话 tab：详情仍在（会话没丢）。
    await page.locator('[data-testid="narrow-tab-chats"]').click();
    await expect(page.locator('[data-testid="chat-view"]')).toBeVisible();

    // --- 审查 #2：设置里「去扩展中心」会收起窄屏设置页 --------------------------
    await page.locator('[data-testid="narrow-back-button"]').click();
    await page.locator('[data-testid="narrow-tab-me"]').click();
    await page.locator('[data-testid="narrow-me-settings"]').click();
    await page.locator('[data-testid="narrow-settings-item-apps"]').click();
    await page.locator('[data-testid="apps-open-extension-center"]').click();
    await expect(settingsPage).toHaveCount(0);
    await expect(page.locator('[data-testid="narrow-extensions-page"]')).toBeVisible();

    // --- 审查 #11b + #4：Cmd/Ctrl+K 在任意 tab / 详情层可用；搜索层 Esc 与焦点约束 ---
    await page.locator('[data-testid="narrow-tab-chats"]').click();
    await page.locator('[data-testid^="conversation-item-"]', { hasText: '层级助手' }).click();
    await expect(page.locator('[data-testid="chat-view"]')).toBeVisible();
    // 详情层里侧栏（AppSidebar）没有挂载：快捷键必须挂在 App 级。
    await expect(page.locator('[data-testid="sidebar-search-button"]')).toHaveCount(0);
    await page.keyboard.press('ControlOrMeta+k');
    await expect(searchLayer).toBeVisible();
    await expect(page.locator('[data-testid="global-search-input"]')).toBeFocused();
    // 底层主布局 inert：连按 Tab 焦点始终留在搜索层内。
    for (let i = 0; i < 8; i += 1) {
      await page.keyboard.press('Tab');
      expect(await focusInside(page, 'global-search-layer')).toBe(true);
    }
    // 审查 #3：搜索输入框不在 drag 区内（结构性断言，含检查器自检）。
    expect(await dragRegionViolations(page)).toEqual([]);
    await page.evaluate(() => {
      document
        .querySelector('[data-testid="global-search-input"]')
        ?.classList.remove('app-no-drag');
    });
    expect(await dragRegionViolations(page)).toContain('global-search-input');
    await page.evaluate(() => {
      document.querySelector('[data-testid="global-search-input"]')?.classList.add('app-no-drag');
    });
    expect(await dragRegionViolations(page)).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(searchLayer).toHaveCount(0);
    await expect(page.locator('[data-testid="chat-view"]')).toBeVisible();

    // --- 审查 #5：Esc 层级仲裁 -------------------------------------------------
    await page.locator('[data-testid="right-panel-toggle"]').click();
    await expect(overlay).toBeVisible();
    // 覆盖层内的可交互控件同样不在 drag 区内（含头像按钮：审查 #11a）。
    expect(await dragRegionViolations(page)).toEqual([]);
    // 行内改名：Esc 只取消编辑，不关覆盖层。
    await overlay.locator('[data-testid="bot-name-edit"]').click();
    const nameInput = overlay.locator('[data-testid="bot-name-inline-input"]');
    await expect(nameInput).toBeVisible();
    await nameInput.fill('不该保存的名字');
    await page.keyboard.press('Escape');
    await expect(nameInput).toHaveCount(0);
    await expect(overlay).toBeVisible();
    await expect(overlay.locator('[data-testid="bot-name-edit"]')).toHaveText('层级助手');
    // 头像选择器：Esc 只收起选择器。
    await overlay.locator('[data-testid="bot-avatar-button"]').click();
    await expect(page.locator('[data-testid="avatar-picker"]')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="avatar-picker"]')).toHaveCount(0);
    await expect(overlay).toBeVisible();
    // 设置页开在 Bot 覆盖层之上：一次 Esc 只关设置页（深链直达详情，一次回到来源）。
    await page.keyboard.press('ControlOrMeta+k');
    await page.locator('[data-testid="global-search-input"]').fill('默认模型');
    await page.locator('[data-testid^="global-search-item-settings-"]').first().click();
    await expect(settingsPage).toBeVisible();
    await expect(overlay).toBeVisible();
    // 被设置页盖住的覆盖层不可聚焦。
    expect(await focusInside(page, 'narrow-bot-detail')).toBe(false);
    await page.keyboard.press('Escape');
    await expect(settingsPage).toHaveCount(0);
    await expect(overlay).toBeVisible();
    // 嵌套 bits-ui 弹层（移除 Bot 确认框）开着时 Esc 先归弹层，覆盖层不动。
    await overlay.locator('#tab-other').click();
    await overlay.locator('[data-testid="bot-remove"]').click();
    const removeDialog = page.locator('[data-testid="bot-remove-dialog"]');
    await expect(removeDialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(removeDialog).toHaveCount(0);
    await expect(overlay).toBeVisible();
    // 无嵌套层时 Esc 关覆盖层。
    await page.keyboard.press('Escape');
    await expect(overlay).toHaveCount(0);

    // --- 审查 #7 / #8：宽窄切换复位设置类浮层；断点滞回 --------------------------
    await page.locator('[data-testid="narrow-back-button"]').click();
    await page.locator('[data-testid="narrow-tab-me"]').click();
    await page.locator('[data-testid="narrow-me-settings"]').click();
    await expect(settingsPage).toBeVisible();
    await resizeWindow(app, 1280, 840); // 拉宽：窄屏设置页必须消失，且不是被「挪」成宽屏弹框。
    await expect(page.locator('[data-testid="narrow-shell"]')).toHaveCount(0);
    await expect(settingsPage).toHaveCount(0);
    await expect(page.locator('[data-testid="settings-dialog"]')).toHaveCount(0);
    await resizeWindow(app, 375, 812); // 再拉窄：设置页不会自己弹出。
    await expect(page.locator('[data-testid="narrow-shell"]')).toBeVisible();
    await expect(settingsPage).toHaveCount(0);
    // 宽屏设置弹框开着时拉窄：弹框不留在窄屏里。
    await resizeWindow(app, 1280, 840);
    await expect(page.locator('[data-testid="sidebar-search-button"]')).toBeVisible();
    await page.keyboard.press('ControlOrMeta+k');
    await page.locator('[data-testid="global-search-input"]').fill('默认模型');
    await page.locator('[data-testid^="global-search-item-settings-"]').first().click();
    await expect(page.locator('[data-testid="settings-dialog"]')).toBeVisible();
    await page.locator('[data-testid="settings-nav-hardware"]').click();
    await resizeWindow(app, 375, 812);
    await expect(page.locator('[data-testid="settings-dialog"]')).toHaveCount(0);
    await expect(settingsPage).toHaveCount(0);
    // 滞回：窄屏下拉到 660（>640、<680）仍是窄屏；到 700 才回宽屏；宽屏下 660 仍是宽屏。
    await resizeWindow(app, 660, 812);
    await expect(page.locator('[data-testid="narrow-shell"]')).toBeVisible();
    await resizeWindow(app, 700, 812);
    await expect(page.locator('[data-testid="narrow-shell"]')).toHaveCount(0);
    await resizeWindow(app, 660, 812);
    await expect(page.locator('[data-testid="sidebar-resize-handle"]')).toBeVisible();
    await expect(page.locator('[data-testid="narrow-shell"]')).toHaveCount(0);

    // --- 审查 #9：窄宽屏区间聊天区保持可用宽度；放不下并排右栏时改走覆盖层 ------------
    await resizeWindow(app, 700, 812);
    await expect(page.locator('[data-testid="chat-view"]')).toBeVisible();
    // 侧栏偏好宽度 420（localStorage 持久化）+ 700 窗口：渲染宽被夹取，聊天区 ≥ 360。
    await page.evaluate(() => localStorage.setItem('kepcup.sidebar.width', '420'));
    await page.reload();
    await expect(page.locator('[data-testid="chat-view"]')).toBeVisible({ timeout: 30_000 });
    const chatBox = (await page.locator('[data-testid="chat-view"]').boundingBox())!;
    // 底线 360（WIDE_CHAT_MIN_WIDTH），留几 px 给分隔线 / 取整。
    expect(chatBox.width).toBeGreaterThanOrEqual(355);
    // 右栏放不下：药丸开全屏覆盖层而不是并排右栏；✕ 关闭。
    await page.locator('[data-testid="right-panel-toggle"]').click();
    await expect(overlay).toBeVisible();
    await overlay.locator('[data-testid="right-panel-hide"]').click();
    await expect(overlay).toHaveCount(0);
    // 窗口拉到足够宽：药丸切换并排右栏，覆盖层不出现。
    await resizeWindow(app, 1280, 840);
    await page.locator('[data-testid="right-panel-toggle"]').click();
    await expect(page.locator('[data-testid="right-panel"]')).toBeVisible();
    await expect(overlay).toHaveCount(0);
    await page.locator('[data-testid="right-panel-toggle"]').click();
    await expect(page.locator('[data-testid="right-panel"]')).toHaveCount(0);
    await page.evaluate(() => localStorage.removeItem('kepcup.sidebar.width'));

    // --- 审查 #6：在覆盖层里移除 Bot → 覆盖层收起，不留空壳 -------------------------
    await resizeWindow(app, 375, 812);
    await expect(page.locator('[data-testid="narrow-shell"]')).toBeVisible();
    await expect(page.locator('[data-testid="chat-view"]')).toBeVisible();
    await page.locator('[data-testid="right-panel-toggle"]').click();
    await expect(overlay).toBeVisible();
    await overlay.locator('#tab-other').click();
    await overlay.locator('[data-testid="bot-remove"]').click();
    await page.locator('[data-testid="bot-remove-confirm"]').click();
    // 移除是重 RPC 链（删对话/工作区目录 + 资料分区清场），windows 上
    // 整条链（含 fs 重试）能拖过 30s：给足 90s。
    await expect(overlay).toHaveCount(0, { timeout: 90_000 });
    await expect(page.locator('[data-testid="narrow-tab-bar"]')).toBeVisible();
    await expect(page.locator('[data-testid="chat-view"]')).toHaveCount(0);

    expect(pageErrors).toEqual([]);
  } finally {
    await app.close();
    await rmHomeTolerant(home);
    await llm.stop();
  }
});
