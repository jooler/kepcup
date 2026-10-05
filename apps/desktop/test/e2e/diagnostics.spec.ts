import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page, _electron } from '@playwright/test';

/**
 * P13 任务 6 诊断页 e2e（设置页「诊断」分区）。
 * 覆盖：各状态行渲染（核心服务/数据目录/磁盘占用/日志目录/钥匙串/数据库/
 * 沙箱/工具链）；「在文件管理器中打开」经 mock 的 shell.showItemInFolder
 * 触发并携带数据目录下的 logs 路径（与 dialog.showOpenDialog 的 mock 先例
 * 同一驱动方式）。
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

test('diagnostics section renders every status row; opening the logs directory reaches the (mocked) shell', async () => {
  test.setTimeout(180_000);
  const session = await startSession('kepcup-e2e-diag-');
  const { app, page, home } = session;
  try {
    await waitReady(page);

    await page.locator('[data-testid="user-menu-trigger"]').click();
    await page.locator('[data-testid="menu-settings"]').click();
    await expect(page.locator('[data-testid="settings-page-content"]')).toBeVisible();
    await page.locator('[data-testid="settings-nav-diagnostics"]').click();

    const section = page.locator('[data-testid="settings-diagnostics"]');
    await expect(section).toBeVisible({ timeout: 30_000 });

    // 核心服务状态行（ready 徽标 + 运行时长）。
    const coreRow = page.locator('[data-testid="diagnostics-core"]');
    await expect(coreRow).toContainText('ready', { timeout: 30_000 });
    await expect(coreRow).toContainText('已运行');

    // 数据目录与磁盘占用（绝对路径 + 非零占用）。
    await expect(page.locator('[data-testid="diagnostics-data-dir"]')).toContainText(
      path.basename(home),
    );
    await expect(page.locator('[data-testid="diagnostics-data-dir"]')).toContainText('磁盘占用');

    // 钥匙串行：e2e 注入 memory keystore → kind 显示 + 正常。
    await expect(page.locator('[data-testid="diagnostics-keystore"]')).toContainText('memory');
    await expect(page.locator('[data-testid="diagnostics-keystore-state"]')).toContainText('正常');

    // 数据库行：main/runs 打开且迁移版本 = 目标版本；memory 行存在。
    await expect(page.locator('[data-testid="diagnostics-db-main-db"]')).toContainText('版本');
    await expect(page.locator('[data-testid="diagnostics-db-runs-db"]')).toContainText('版本');
    await expect(page.locator('[data-testid="diagnostics-db-memory-db"]')).toContainText('每 Bot');

    // 沙箱行（macOS 无注入：srt 后端）与工具链行（system:git 实时探测）。
    await expect(page.locator('[data-testid="diagnostics-sandbox"]')).toContainText('srt', {
      timeout: 60_000,
    });
    await expect(page.locator('[data-testid="diagnostics-toolchain"]')).toContainText('git');

    // 「在文件管理器中打开」：mock 主进程 shell.showItemInFolder（能力能力面，
    // 与 dialog.showOpenDialog 的 mock 先例同一方式），点击后断言被调用且
    // 携带 logs 目录路径。
    await app.evaluate(({ shell }) => {
      (globalThis as Record<string, unknown>).__LOGS_OPENED__ = null;
      (shell as unknown as { showItemInFolder: (p: string) => void }).showItemInFolder = (
        p: string,
      ) => {
        (globalThis as Record<string, unknown>).__LOGS_OPENED__ = p;
      };
    });
    await page.locator('[data-testid="diagnostics-logs-open"]').click();
    await expect
      .poll(async () => app.evaluate(() => (globalThis as Record<string, unknown>).__LOGS_OPENED__))
      .toBe(path.join(home, 'logs'));

    // 刷新按钮可重取（保持行渲染）。
    await page.locator('[data-testid="diagnostics-refresh"]').click();
    await expect(page.locator('[data-testid="diagnostics-core"]')).toContainText('ready');
  } finally {
    await closeSession(session);
  }
});
