import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page, _electron } from '@playwright/test';

/**
 * 传感器 / 硬件分区（docs/design/31-sensors.md，D76）：用 Chromium 伪设备启动
 * （--use-fake-device-for-media-stream 提供合成麦克风 / 摄像头，--use-fake-ui-for-media-stream
 * 跳过权限弹框），覆盖设置页数据驱动的两张卡片：
 * ① 麦克风默认启用 → 点测试 → 电平条起伏 → 再点停止；
 * ② 摄像头默认关闭（预览按钮禁用）→ 启用 → 预览出现且 videoWidth > 0 →
 *    停止预览后轨道已 stop；预览中取消启用同样立即释放。
 */

async function launch(): Promise<{ app: ElectronApplication; page: Page; home: string }> {
  const home = await mkdtemp(path.join(tmpdir(), 'kepcup-e2e-sensors-'));
  const app = await _electron.launch({
    // 刻意不传 --use-fake-ui-for-media-stream：它会绕过 Electron 的权限处理器，
    // 去掉后 media 授权必须真正经过 app-permissions 白名单，白名单回归会让用例失败。
    args: ['.', '--use-fake-device-for-media-stream'],
    env: {
      ...process.env,
      KEPCUP_HOME: home,
      NODE_ENV: 'test',
      KEPCUP_KEYSTORE: 'memory',
      KEPCUP_ONBOARDING: 'off',
    },
  });
  const page = await app.firstWindow();
  await expect(page.locator('[data-testid="app-shell"]')).toBeVisible({ timeout: 60_000 });
  // 管家补建后「+」面板可能异步弹出，全屏 backdrop 会挡住设置入口。
  const startBackdrop = page.locator('[data-testid="start-chat-backdrop"]');
  if (await startBackdrop.isVisible()) {
    await startBackdrop.click({ timeout: 2_000 }).catch(() => {});
  }
  await expect(startBackdrop).toHaveCount(0);
  await page.locator('[data-testid="user-menu-trigger"]').click();
  await page.locator('[data-testid="menu-settings"]').click();
  await expect(page.locator('[data-testid="settings-page-content"]')).toBeVisible();
  await page.locator('[data-testid="settings-nav-hardware"]').click();
  await expect(page.locator('[data-testid="settings-hardware"]')).toBeVisible();
  return { app, page, home };
}

test('microphone card: enabled by default, test shows a live level meter', async () => {
  test.setTimeout(120_000);
  const { app, page, home } = await launch();
  try {
    const checkbox = page.locator('[data-testid="sensor-enabled-microphone"]');
    await expect(checkbox).toHaveAttribute('data-state', 'checked');
    // 伪设备枚举得到至少一个输入设备。
    await expect(page.locator('[data-testid="sensor-device-microphone"] option')).not.toHaveCount(
      1,
    );

    const toggle = page.locator('[data-testid="sensor-test-toggle-microphone"]');
    await toggle.click();
    await expect(toggle).toHaveText('停止测试');
    // 伪麦克风持续发出蜂鸣：电平条宽度应 > 0。
    await expect
      .poll(
        async () =>
          page
            .locator('[data-testid="sensor-level-microphone"]')
            .evaluate((el) => parseFloat((el as HTMLElement).style.width) || 0),
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0);
    await expect(page.locator('[data-testid="sensor-permission-microphone"]')).toHaveAttribute(
      'data-status',
      'granted',
    );

    await toggle.click();
    await expect(toggle).toHaveText('测试麦克风');
    await expect(page.locator('[data-testid="sensor-level-microphone"]')).toHaveCSS('width', '0px');
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('camera card: off by default, preview works once enabled and releases the device', async () => {
  test.setTimeout(120_000);
  const { app, page, home } = await launch();
  try {
    const checkbox = page.locator('[data-testid="sensor-enabled-camera"]');
    const toggle = page.locator('[data-testid="sensor-test-toggle-camera"]');
    await expect(checkbox).toHaveAttribute('data-state', 'unchecked');
    await expect(toggle).toBeDisabled();

    await checkbox.click();
    await expect(checkbox).toHaveAttribute('data-state', 'checked');
    await expect(toggle).toBeEnabled();

    await toggle.click();
    const video = page.locator('[data-testid="sensor-preview-camera"]');
    await expect(video).toBeVisible();
    await expect
      .poll(async () => video.evaluate((el) => (el as HTMLVideoElement).videoWidth), {
        timeout: 15_000,
      })
      .toBeGreaterThan(0);

    // 记下流，停止预览后轨道应已结束。
    await video.evaluate((el) => {
      (window as unknown as { __camStream: MediaStream }).__camStream = (el as HTMLVideoElement)
        .srcObject as MediaStream;
    });
    await toggle.click();
    await expect(video).toBeHidden();
    expect(
      await page.evaluate(() =>
        (window as unknown as { __camStream: MediaStream }).__camStream
          .getTracks()
          .every((track) => track.readyState === 'ended'),
      ),
    ).toBe(true);

    // 预览中取消启用 → 立即释放。
    await toggle.click();
    await expect(video).toBeVisible();
    await page.evaluate(() => {
      (window as unknown as { __camStream: MediaStream }).__camStream = (
        document.querySelector('[data-testid="sensor-preview-camera"]') as HTMLVideoElement
      ).srcObject as MediaStream;
    });
    await checkbox.click();
    await expect(video).toBeHidden();
    expect(
      await page.evaluate(() =>
        (window as unknown as { __camStream: MediaStream }).__camStream
          .getTracks()
          .every((track) => track.readyState === 'ended'),
      ),
    ).toBe(true);
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});
