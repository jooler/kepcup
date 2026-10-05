import { mkdtemp, rm } from 'node:fs/promises';
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
      // P13-B e2e seam: 非引导用例不出现首启向导（packaged 产物恒为 on）。
      KEPCUP_ONBOARDING: 'off',
    },
  });
  const page = await app.firstWindow();
  return { app, page, home };
}

test('renders the three-column skeleton and reaches the core service', async () => {
  const { app, page, home } = await launchApp();
  test.setTimeout(120_000);

  await expect(page.locator('[data-testid="app-shell"]')).toBeVisible();
  await expect(page.locator('[data-testid="sidebar"]')).toBeVisible();
  await expect(page.locator('[data-testid="chat-empty"]')).toBeVisible();
  // 没有任何 Bot（跳过向导的空态）：右栏自动收起，保持中间空态干净；
  // 「+」面板自动下拉展开引导新建，点背景收起后继续。
  await expect(page.locator('[data-testid="start-chat-panel"]')).toBeVisible();
  await expect(page.locator('[data-testid="right-panel"]')).toBeHidden();
  await page.locator('[data-testid="start-chat-backdrop"]').click();

  // Port A works: system.ping succeeded and system.info is displayed.
  await expect(page.locator('[data-testid="ping-result"]')).toContainText('ping ✓', {
    timeout: 60_000,
  });
  const statusText = await page.locator('[data-testid="ping-result"]').innerText();
  expect(statusText).toMatch(/Node \d+\.\d+\.\d+/);

  // 设置与通讯录是全局设置弹框（主区域常驻对话）：左栏菜单打开，分组定位。
  await page.locator('[data-testid="user-menu-trigger"]').click();
  await page.locator('[data-testid="menu-settings"]').click();
  await expect(page.locator('[data-testid="settings-page-content"]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-testid="settings-dialog"]')).toBeHidden();
  await page.locator('[data-testid="user-menu-trigger"]').click();
  await page.locator('[data-testid="menu-contacts"]').click();
  await expect(page.locator('[data-testid="contacts-page-content"]')).toBeVisible();
  await page.keyboard.press('Escape');

  // Bot 药丸在对话存在时才渲染：建一个 Bot 后检查右栏经药丸收合。
  await page.locator('[data-testid="new-chat-button"]').click();
  await page.locator('[data-testid="bot-create-form"]').click();
  await page
    .locator('[data-testid="bot-create-dialog"] [data-testid="bot-name-input"]')
    .fill('小架');
  await page.locator('[data-testid="bot-create-save"]').click();
  await expect(page.locator('[data-testid="chat-view"]')).toBeVisible({ timeout: 15_000 });
  // 右栏（Bot 详情）默认收起，保持界面简单：经顶部药丸展开、再收合。
  await expect(page.locator('[data-testid="right-panel"]')).toBeHidden();
  await expect(page.locator('[data-testid="panel-expand-hint"]')).toBeVisible();
  await page.locator('[data-testid="right-panel-toggle"]').click();
  await expect(page.locator('[data-testid="right-panel"]')).toBeVisible();
  await page.locator('[data-testid="right-panel-hide"]').click();
  await expect(page.locator('[data-testid="right-panel"]')).toBeHidden();

  await app.close();
  await rm(home, { recursive: true, force: true });
});

test('input echo is instantaneous (P13 验收标准「按键到字符显示无可感知延迟」)', async () => {
  const { app, page, home } = await launchApp();
  test.setTimeout(120_000);

  await expect(page.locator('[data-testid="app-shell"]')).toBeVisible();
  await expect(page.locator('[data-testid="ping-result"]')).toContainText('ping ✓', {
    timeout: 60_000,
  });

  // 建一个 Bot 进入对话（空态没有输入框）。
  await page.locator('[data-testid="new-chat-button"]').click();
  await page.locator('[data-testid="bot-create-form"]').click();
  await page
    .locator('[data-testid="bot-create-dialog"] [data-testid="bot-name-input"]')
    .fill('小延迟');
  await page.locator('[data-testid="bot-create-save"]').click();
  await expect(page.locator('[data-testid="chat-view"]')).toBeVisible({ timeout: 15_000 });

  // 「+」面板的空态引导可能与建 Bot 竞态（bootstrap 尾巴把面板拉起来）：
  // 与上一个用例相同，进对话前确保全屏 backdrop 已收起。
  const startBackdrop = page.locator('[data-testid="start-chat-backdrop"]');
  if (await startBackdrop.isVisible().catch(() => false)) await startBackdrop.click();
  await expect(startBackdrop).toHaveCount(0);

  const composer = page.locator('[data-testid="composer-input"]');
  await composer.click();

  // 页面内测量：keydown 到 input 事件（字符已进入输入框）的间隔。阈值 50ms
  // 是「无可感知」的工程化上界。文档级捕获监听记录两个时间戳；evaluate 均
  // 为短生命往返（不做跨 await 的挂起 Promise），每键测量一次。
  await page.evaluate(() => {
    (globalThis as Record<string, unknown>).__ECHO__ = { keydownAt: 0, delta: -1, count: 0 };
    document.addEventListener(
      'keydown',
      () => {
        (globalThis as Record<string, unknown>).__ECHO__ = {
          keydownAt: performance.now(),
          delta: -1,
          count: 0,
        };
      },
      { capture: true },
    );
    document.addEventListener(
      'input',
      () => {
        const state = (globalThis as Record<string, unknown>).__ECHO__ as {
          keydownAt: number;
          delta: number;
          count: number;
        };
        if (state.keydownAt > 0 && state.delta < 0) {
          state.delta = performance.now() - state.keydownAt;
          state.count += 1;
        }
      },
      { capture: true },
    );
  });

  for (let i = 0; i < 5; i++) {
    await page.keyboard.type('a');
    const state = await page.evaluate(
      () => (globalThis as Record<string, unknown>).__ECHO__ as { delta: number; count: number },
    );
    // count 在每次 keydown 时清零、对应 input 时置 1：读到 1 即「本键的字符
    // 回显事件已发生」。
    expect(state.count, `iteration ${i}: input event must have fired`).toBe(1);
    expect(state.delta, `iteration ${i}: echo interval`).toBeGreaterThanOrEqual(0);
    expect(state.delta, `iteration ${i}: echo interval under 50ms`).toBeLessThan(50);
    await page.keyboard.press('Backspace');
  }

  await app.close();
  await rm(home, { recursive: true, force: true });
});
