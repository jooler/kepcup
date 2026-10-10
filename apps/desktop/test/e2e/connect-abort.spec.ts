import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page, _electron } from '@playwright/test';
import { startMockLlm } from '@kepcup/testkit';

/**
 * 回归（用户实测）：目录应用（Linear）点「连接」→ 授权没走完就「取消」→ 卡片仍写着「已连接 1 个
 * 账号」（要手动刷新才对）→ 点「管理」进到一个已被删除的连接 → 「找不到这个连接」的 toast 无限弹。
 *
 * 这里用一个永远不应答的本机 MCP 端点充当「用户一直没授权」的服务器（流程停在发现 / 等待阶段），
 * 点「取消」，然后断言：卡片没有账号数 / 「管理」，没有 toast，渲染端没有对该连接发过
 * `apps.connections.tools` / `grants`。目录经 `KEPCUP_CONNECTORS` 指向临时目录（取自随包目录的
 * Notion 条目，远端地址改成本机）。真实 OAuth 授权页无法在 e2e 里走通，所以不覆盖「授权成功」。
 */

declare global {
  interface Window {
    __rpcLog: string[];
  }
}

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

test('catalog connect cancelled before authorizing: no ghost account, no detail toast storm', async () => {
  test.setTimeout(240_000);
  const llm = await startMockLlm();
  const home = await mkdtemp(path.join(tmpdir(), 'kepcup-e2e-abort-'));
  // 永不应答的「MCP 端点」：连接进来就挂着（用户一直没授权 / 授权服务器没反应）。
  let hits = 0;
  const hold: Server = createServer(() => {
    hits += 1;
  });
  await new Promise<void>((resolve) => hold.listen(0, '127.0.0.1', resolve));
  const holdUrl = `http://127.0.0.1:${(hold.address() as AddressInfo).port}/mcp`;

  const shipped = path.resolve('resources/connectors');
  const connectorsDir = path.join(home, 'connectors');
  await mkdir(connectorsDir, { recursive: true });
  await cp(path.join(shipped, 'icons'), path.join(connectorsDir, 'icons'), { recursive: true });
  const full = JSON.parse(await readFile(path.join(shipped, 'catalog.json'), 'utf8')) as {
    version: number;
    connectors: Array<{ title: string; remotes: Array<{ url: string }> }>;
  };
  const notion = full.connectors.find((entry) => entry.title === 'Notion')!;
  notion.remotes = [{ ...notion.remotes[0]!, url: holdUrl }];
  await writeFile(
    path.join(connectorsDir, 'catalog.json'),
    JSON.stringify({ version: full.version, connectors: [notion] }),
  );

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
        KEPCUP_CONNECTORS: connectorsDir,
      },
    });
    const page = await app.firstWindow();
    // 记录渲染端发往 core 的 RPC（端口消息里的方法名），用来数 tools / grants 请求。
    await page.addInitScript(() => {
      window.__rpcLog = [];
      const original = MessagePort.prototype.postMessage;
      MessagePort.prototype.postMessage = function (this: MessagePort, ...args: unknown[]) {
        try {
          window.__rpcLog.push(JSON.stringify(args[0]).slice(0, 400));
        } catch {
          // 不可序列化的消息不记。
        }
        return (original as (...a: unknown[]) => void).apply(this, args);
      } as typeof MessagePort.prototype.postMessage;
    });
    await page.reload();
    await waitReady(page);

    const dialog = page.locator('[data-testid="extension-center-dialog"]');
    await page.locator('[data-testid="extension-center-button"]').click();
    await dialog.locator('[data-testid="extension-center-tab-connections"]').click();
    const card = dialog.locator('[data-testid="apps-catalog-card-notion"]');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.locator('[data-testid="apps-catalog-accounts"]')).toHaveCount(0);

    // 点「连接」展开面板 → 面板里「连接」发起授权 → 流程进行中（停在永不应答的端点上）。
    await dialog.locator('[data-testid="apps-catalog-connect-notion"]').click();
    const panel = dialog.locator('[data-testid="apps-catalog-panel-notion"]');
    await panel.locator('[data-testid="apps-catalog-panel-notion-connect"]').click();
    await expect(panel.locator('[data-testid="apps-catalog-panel-notion-progress"]')).toBeVisible({
      timeout: 30_000,
    });
    await expect.poll(() => hits, { timeout: 30_000 }).toBeGreaterThan(0);

    // 进行中：临时行不算账号。
    await expect(card.locator('[data-testid="apps-catalog-accounts"]')).toHaveCount(0);
    await expect(dialog.locator('[data-testid="apps-catalog-manage-notion"]')).toHaveCount(0);

    // 取消：卡片不会留下「已连接 N 个账号」，也没有「管理」。
    await panel.locator('[data-testid="apps-catalog-panel-notion-cancel"]').click();
    await expect(panel.locator('[data-testid="apps-catalog-panel-notion-cancelled"]')).toBeVisible({
      timeout: 30_000,
    });
    await expect(card.locator('[data-testid="apps-catalog-accounts"]')).toHaveCount(0);
    await expect(dialog.locator('[data-testid="apps-catalog-manage-notion"]')).toHaveCount(0);

    // 等几秒：没有任何 toast，渲染端没有对连接发过 tools / grants 请求。
    await page.waitForTimeout(3_500);
    await expect(page.locator('[data-sonner-toast]')).toHaveCount(0);
    const log = await page.evaluate(() => window.__rpcLog);
    expect(log.filter((entry) => entry.includes('apps.connections.tools'))).toHaveLength(0);
    expect(log.filter((entry) => entry.includes('apps.connections.grants'))).toHaveLength(0);
    // 关掉「连接」再进：列表仍然没有账号（不靠手动刷新）。
    await page.keyboard.press('Escape');
    await page.locator('[data-testid="extension-center-button"]').click();
    await dialog.locator('[data-testid="extension-center-tab-connections"]').click();
    await expect(dialog.locator('[data-testid="apps-catalog-card-notion"]')).toBeVisible();
    await expect(dialog.locator('[data-testid="apps-catalog-accounts"]')).toHaveCount(0);
  } finally {
    await app?.close();
    await llm.stop();
    hold.closeAllConnections();
    await new Promise<void>((resolve) => hold.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
});
