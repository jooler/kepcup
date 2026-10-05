import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page, _electron } from '@playwright/test';

/**
 * P13-B 任务 2/3 UI e2e：更新提示横幅（消费 P13-A 的 update:status 推送与
 * preload 契约）+ 设置页自启开关（写 settings.launchAtLogin，platform.autostart
 * 事件链在 P13-A 已单测覆盖；dev/e2e 下主进程不触 OS 登录项——isPackaged
 * 守卫，跨系统真机项见清单）。
 *
 * 更新横幅的驱动方式如实说明：NODE_ENV=test 下 updater 不调度、不触网
 * （P13-A 语义）。渲染层各相位的显示断言经主进程 webContents 推送
 * updateStatusPayload 形状载荷驱动；「点重启安装走门控」则经 dev/e2e 专用
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

test('update banner renders download/waiting phases; restart-install goes through the gate', async () => {
  test.setTimeout(180_000);
  const session = await startSession('kepcup-e2e-update-');
  const { app, page } = session;
  try {
    await waitReady(page);

    // 下载中：横幅出现，显示版本号。
    await pushUpdate(app, { phase: 'downloading', version: '9.9.9' });
    const banner = page.locator('[data-testid="update-banner"]');
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(banner).toContainText('9.9.9');

    // 在途执行等待中：不中断语义的文案 + 计数。
    await pushUpdate(app, { phase: 'waiting-runs', version: '9.9.9', activeRuns: 2 });
    await expect(banner).toHaveAttribute('data-phase', 'waiting-runs');
    await expect(banner).toContainText('2 个执行正在进行');

    // 超时转 awaiting-user：绝不自动中断——用户可选择继续等待或确认中断。
    await pushUpdate(app, { phase: 'awaiting-user', version: '9.9.9', activeRuns: 1 });
    await expect(banner).toHaveAttribute('data-phase', 'awaiting-user');
    await page.locator('[data-testid="update-keep-waiting"]').click();
    await expect(banner).not.toContainText('中断执行并更新');

    // 回到 ready-to-install：经 dev/e2e 专用 seam 驱动【真实门控】走 evaluate()
    // （无在途执行 → ready-to-install，生产转移路径；seam 经
    // __KEPCUP_TEST_HOOKS__ 守卫，打包产物 DCE 剔除）。「立即重启并更新」
    // → preload update:installNow → 主进程门控 installNow()——相位守卫
    // （BR-P13-005）下仅 awaiting-user/ready-to-install 可安装，ready 相位会
    // 复探在途执行。门控在调用 quitAndInstall 之前广播 installing 相位——
    // e2e（dev 应用，无真实更新包）断言这一相位翻转，证明点击确实走到了门控
    // 的安装决策；「确认后才 cancel+install」「ready 相位出现新执行先转
    // awaiting-user」「idle 相位调用 no-op」的门控语义由 update-gate 单测覆盖
    // （quitAndInstall 本身；dev 无更新包不真的退出）。
    await page.evaluate(
      (version) => (window as unknown as SeamWindow).kepcup.testGateEvaluate!(version),
      '9.9.9',
    );
    await expect(banner).toHaveAttribute('data-phase', 'ready-to-install', { timeout: 15_000 });
    await expect(banner).toContainText('立即重启并更新');
    await page.locator('[data-testid="update-restart"]').click();
    // 门控已进入 installing 相位（dev 无更新包，quitAndInstall 不真的退出）。
    await expect(banner).toHaveAttribute('data-phase', 'installing', { timeout: 15_000 });
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
