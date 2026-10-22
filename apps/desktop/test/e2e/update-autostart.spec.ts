import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page, _electron } from '@playwright/test';
import { rmHomeTolerant } from './helpers/home-cleanup';

/**
 * P13-B 任务 2/3 UI e2e：静默更新（设置页下载进度/应用按钮 + 左栏圆形更新
 * 按钮，消费 P13-A 的 update:status 推送与 preload 契约）+ 设置页自启开关
 * （写 settings.launchAtLogin，platform.autostart 事件链在 P13-A 已单测覆盖；
 * dev/e2e 下主进程不触 OS 登录项——isPackaged 守卫，跨系统真机项见清单）。
 *
 * 更新状态的驱动方式如实说明：NODE_ENV=test 下 updater 不调度、不触网
 * （P13-A 语义）。渲染层各相位的显示断言经主进程 webContents 推送
 * updateStatusPayload 形状载荷驱动；「点应用更新走门控」则经 dev/e2e 专用
 * seam（update:testEvaluate，__KEPCUP_TEST_HOOKS__ 守卫、打包 DCE 剔除）
 * 驱动【真实门控】的 evaluate() 生产转移路径后再点击——installNow 的相位
 * 守卫（BR-P13-005）要求门控真实处于可安装相位。
 */

interface Session {
  app: ElectronApplication;
  page: Page;
  home: string;
}

async function startSession(prefix: string): Promise<Session> {
  const home = await mkdtemp(path.join(tmpdir(), prefix));
  const app = await _electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      KEPCUP_HOME: home,
      NODE_ENV: 'test',
      KEPCUP_KEYSTORE: 'memory',
      // P13-B e2e seam: 非引导用例不出现首启向导（packaged 产物恒为 on）。
      KEPCUP_ONBOARDING: 'off',
    },
  });
  const page = await app.firstWindow();
  return { app, page, home };
}

async function closeSession(session: Session): Promise<void> {
  await session.app.close();
  await rmHomeTolerant(session.home);
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

/** Pushes an updateStatusPayload-shaped snapshot to the renderer (main → renderer). */
async function pushUpdate(
  app: ElectronApplication,
  payload: Record<string, unknown>,
): Promise<void> {
  await app.evaluate(({ BrowserWindow }, payloadArg) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('update:status', payloadArg);
    }
  }, payload);
}

/** dev/e2e seam（打包 DCE 剔除）；本 spec 的 tsconfig 不含 renderer shim，局部类型。 */
type SeamWindow = Window & {
  kepcup: { testGateEvaluate?: (version: string) => Promise<void> };
};

/** 打开设置弹框并停在「通用」页（用户菜单入口）。 */
async function openGeneralSettings(page: Page): Promise<void> {
  await page.locator('[data-testid="user-menu-trigger"]').click();
  await page.locator('[data-testid="menu-settings"]').click();
  await expect(page.locator('[data-testid="settings-general"]')).toBeVisible({ timeout: 15_000 });
}

test('update downloads silently; settings and sidebar expose progress and apply', async () => {
  test.setTimeout(180_000);
  const session = await startSession('kepcup-e2e-update-');
  const { app, page } = session;
  try {
    await waitReady(page);

    // 下载中：不出现顶部横幅；设置页显示绿色进度文字，检查更新按钮已移除。
    await pushUpdate(app, { phase: 'downloading', version: '9.9.9', percent: 42 });
    await expect(page.locator('[data-testid="update-banner"]')).toHaveCount(0);

    await openGeneralSettings(page);
    const updateRow = page.locator('[data-testid="settings-update-row"]');
    await expect(updateRow).toContainText('正在下载 v9.9.9 - 42%', { timeout: 15_000 });
    await expect(page.locator('[data-testid="settings-check-update"]')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="settings-dialog"]')).toBeHidden();

    // 经 dev/e2e seam 驱动【真实门控】走 evaluate()（无在途执行 → ready），
    // 下载完成后不弹横幅，只在设置页出现绿色按钮、左栏底部出现圆形更新按钮。
    await page.evaluate(
      (version) => (window as unknown as SeamWindow).kepcup.testGateEvaluate!(version),
      '9.9.9',
    );
    await expect(page.locator('[data-testid="update-banner"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="sidebar-update-button"]')).toBeVisible({
      timeout: 15_000,
    });

    await openGeneralSettings(page);
    await expect(page.locator('[data-testid="settings-update-apply"]')).toContainText(
      '点击应用更新',
      { timeout: 15_000 },
    );
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="settings-dialog"]')).toBeHidden();

    // 点击左栏圆形按钮 → preload update:installNow → 主进程门控退出并安装；
    // 门控先广播 installing，按钮随之消失，证明点击确实走到了安装决策。
    await page.locator('[data-testid="sidebar-update-button"]').click();
    await expect(page.locator('[data-testid="sidebar-update-button"]')).toHaveCount(0, {
      timeout: 15_000,
    });
  } finally {
    await closeSession(session);
  }
});

/**
 * 空态（无任何 Bot）启动时「+」面板自动展开引导新建：点背景收起。
 * 面板未展开（如已配置向导创建的 Bot）时静默跳过。
 */
async function dismissStartPanel(page: Page): Promise<void> {
  try {
    await page.locator('[data-testid="start-chat-backdrop"]').click({ timeout: 2_000 });
  } catch {
    // 面板没有展开，无需处理。
  }
}

test('launch-at-login switch persists in settings; in dev the OS login item is never touched', async () => {
  test.setTimeout(180_000);
  const session = await startSession('kepcup-e2e-autostart-');
  const { page } = session;
  try {
    await waitReady(page);
    await dismissStartPanel(page);

    await page.locator('[data-testid="user-menu-trigger"]').click();
    await page.locator('[data-testid="menu-settings"]').click();
    await expect(page.locator('[data-testid="settings-page-content"]')).toBeVisible();

    const section = page.locator('[data-testid="settings-general"]');
    await expect(section).toBeVisible();
    const toggle = page.locator('[data-testid="settings-launch-at-login"]');

    // 默认开（settings.launchAtLogin default=true）。
    await expect(toggle).toHaveAttribute('aria-checked', /true|mixed/, { timeout: 15_000 });

    // 关闭 → settings.update 持久化（platform.autostart 事件链 P13-A 已验；
    // dev 下主进程 isPackaged 守卫不触 OS——真机项列跨系统清单）。
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false', { timeout: 15_000 });

    // 离开设置页再回来：开关状态从 settings 读回（持久化证据）。
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="settings-dialog"]')).toBeHidden();
    await page.locator('[data-testid="user-menu-trigger"]').click();
    await page.locator('[data-testid="menu-contacts"]').click();
    await expect(page.locator('[data-testid="contacts-page-content"]')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="settings-dialog"]')).toBeHidden();
    await page.locator('[data-testid="user-menu-trigger"]').click();
    await page.locator('[data-testid="menu-settings"]').click();
    await expect(page.locator('[data-testid="settings-launch-at-login"]')).toHaveAttribute(
      'aria-checked',
      'false',
      { timeout: 15_000 },
    );

    // 打回默认开（回归到默认语义）。
    await page.locator('[data-testid="settings-launch-at-login"]').click();
    await expect(page.locator('[data-testid="settings-launch-at-login"]')).toHaveAttribute(
      'aria-checked',
      'true',
      { timeout: 15_000 },
    );
  } finally {
    await closeSession(session);
  }
});
