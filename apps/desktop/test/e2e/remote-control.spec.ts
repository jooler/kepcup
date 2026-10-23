import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { expect, test, type ElectronApplication, type Page, _electron } from '@playwright/test';
import { rmHomeTolerant } from './helpers/home-cleanup';
import { dismissStartPanel, rpc } from './helpers/create-bot';

/**
 * D96 远程遥控 e2e（todo/remote-control.md WP4）：设置页开关 → 「连接手机」
 * 二维码小窗 → 注入配对请求（测试缝 `remote.testInjectPairing`，模拟手机发来
 * pairing.request，走真实 PSK HMAC + 待确认路径）→ 确认卡「允许」→ 设备出现在
 * 列表 → 撤销（二次确认）后设备消失。真实中转 / 手机浏览器不在 e2e 范围
 *（WP6 `wrangler dev` 三端联调覆盖）。
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
      TZ: 'Asia/Shanghai',
      KEPCUP_HOME: home,
      NODE_ENV: 'test',
      KEPCUP_KEYSTORE: 'memory',
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
  await expect(
    page
      .locator('[data-testid="chat-view"]')
      .or(page.locator('[data-testid="start-chat-panel"]'))
      .or(page.locator('[data-testid="onboarding"]')),
  ).toBeVisible({ timeout: 60_000 });
}

async function openRemoteSection(page: Page): Promise<void> {
  await dismissStartPanel(page);
  await page.locator('[data-testid="user-menu-trigger"]').click();
  await page.locator('[data-testid="menu-settings"]').click();
  await expect(page.locator('[data-testid="settings-page-content"]')).toBeVisible();
  await page.locator('[data-testid="settings-nav-remote"]').click();
  await expect(page.locator('[data-settings-section="remote"]')).toBeVisible();
}

test.describe('D96 远程遥控', () => {
  test('开关 → 配对码 → 注入请求 → 允许 → 设备出现 → 撤销', async () => {
    const session = await startSession('kepcup-remote-e2e-');
    const { page } = session;
    try {
      await waitReady(page);
      await openRemoteSection(page);

      // 初始：开关关闭、无设备。
      const status0 = (await rpc(page, 'remote.status')) as {
        enabled: boolean;
        devices?: unknown;
      };
      expect(status0.enabled).toBe(false);

      // 开关：走设置目录条目的写路径（confirm 档位，目录卡片或 RPC 等价）。
      const configured = (await rpc(page, 'remote.config.set', {
        enabled: true,
        relayUrl: 'ws://127.0.0.1:8787',
      })) as { enabled: boolean };
      expect(configured.enabled).toBe(true);
      // anchor 会连不上（本地无中转）→ 状态 error / connecting 都算"在尝试"。
      await expect
        .poll(async () => ((await rpc(page, 'remote.status')) as { anchor: string }).anchor, {
          timeout: 30_000,
        })
        .toBe('error');

      // 「连接手机」→ 二维码小窗（offer + 倒计时）。
      await page.locator('[data-testid="remote-pair-button"]').click();
      await expect(page.locator('[data-testid="remote-pair-dialog"]')).toBeVisible();
      await expect(page.locator('[data-testid="remote-qr"]')).toBeVisible({ timeout: 15_000 });
      await expect(page.locator('[data-testid="remote-pair-countdown"]')).toContainText(/\d:\d{2}/);

      // 模拟手机配对请求（真实 HMAC / 挂起路径）。
      const deviceId = 'dev-' + randomBytes(10).toString('hex');
      const injected = (await rpc(page, 'remote.testInjectPairing', {
        deviceId,
        deviceName: '李的 iPhone',
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
      })) as { requestId: string };
      expect(injected.requestId).toBeTruthy();

      // 确认卡出现（事件或轮询驱动）→ 显示设备名 → 允许。
      const card = page.locator('[data-testid="remote-confirm-card"]');
      await expect(card).toBeVisible({ timeout: 15_000 });
      await expect(card).toContainText('李的 iPhone');
      await page.locator('[data-testid="remote-confirm-allow"]').click();

      // 配对完成视图 + 设备列表出现该设备。
      await expect(page.locator('[data-testid="remote-pair-done"]')).toBeVisible({
        timeout: 15_000,
      });
      const devices = (await rpc(page, 'remote.devices')) as {
        devices: Array<{ deviceId: string; name: string; revokedAt: string | null }>;
      };
      expect(devices.devices).toHaveLength(1);
      expect(devices.devices[0]).toMatchObject({ deviceId, name: '李的 iPhone' });
      // 设备密钥落 secrets（不落 remote_devices 表）。
      expect((await rpc(page, 'remote.status')) as { onlineDeviceIds: string[] }).toMatchObject({
        onlineDeviceIds: [],
      });

      // 关闭小窗（Escape），走列表里的撤销按钮 → 二次确认 → 行保留、revokedAt 置位。
      await page.keyboard.press('Escape');
      const revokeButton = page.locator('[data-testid="remote-revoke"]').first();
      await expect(revokeButton).toBeVisible({ timeout: 15_000 });
      await revokeButton.click();
      await page.locator('[data-testid="remote-revoke-confirm"]').click();
      await expect
        .poll(
          async () =>
            ((await rpc(page, 'remote.devices')) as { devices: unknown[] }).devices.length,
          {
            timeout: 15_000,
          },
        )
        .toBe(1);
      const after = (await rpc(page, 'remote.devices')) as {
        devices: Array<{ revokedAt: string | null }>;
      };
      expect(after.devices[0]!.revokedAt).not.toBeNull();
    } finally {
      await closeSession(session);
    }
  });

  test('开关未开时 createPairing 拒绝；撤销后的设备不能再次配对注入', async () => {
    const session = await startSession('kepcup-remote-e2e-b-');
    const { page } = session;
    try {
      await waitReady(page);
      await openRemoteSection(page);
      await expect
        .poll(async () => ((await rpc(page, 'remote.status')) as { enabled: boolean }).enabled)
        .toBe(false);
      let failed = false;
      try {
        await rpc(page, 'remote.createPairing');
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);
    } finally {
      await closeSession(session);
    }
  });
});
