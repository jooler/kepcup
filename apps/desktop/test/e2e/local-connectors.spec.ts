import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page, _electron } from '@playwright/test';
import { startFakeOAuthMcpServer, startMockLlm, step } from '@kepcup/testkit';

/**
 * 本机连接（设计 29 §17，todo/local-connector-authoring.md L4）端到端——真实 Electron + 真实 core +
 * mock LLM + testkit 假授权 / MCP 服务器（回环 http，经测试钩子 `KEPCUP_TEST_OAUTH_LOOPBACK` 放行；
 * 生产里 `mcpUrl` 必须是 https 公网域名）：
 *
 * 开发者模式关闭：扩展中心「连接」里没有「本机自建」区 → 在设置里打开 → 区块出现（空态）→ Bot
 * 调 `app_propose_local_connector`（mock LLM 脚本）→ 对话里出确认卡（域名大字、完整地址、认证方式、
 * 范围、风险说明，文档链接是纯文本）→ 「添加」→ 卡片接上连接步骤 → 条目出现在「本机自建」区（带
 * 「未审核」，且**不**在预置网格里）→ 删除（确认框）→ 消失。另一条提案点「取消」→ 卡片收起、提案作废。
 * 真实 OAuth 授权页无法在 e2e 里走通（会打开系统浏览器），所以不点「连接」。
 */

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

async function createBotAndOpenChat(page: Page, name: string): Promise<void> {
  await page.locator('[data-testid="new-chat-button"]').click();
  await page.locator('[data-testid="bot-create-form"]').click();
  await expect(page.locator('[data-testid="bot-create-dialog"]')).toBeVisible();
  await page.locator('[data-testid="bot-create-dialog"] [data-testid="bot-name-input"]').fill(name);
  await page.locator('[data-testid="bot-create-save"]').click();
  await expect(page.locator('[data-testid="chat-view"]')).toBeVisible({ timeout: 15_000 });
  const backdrop = page.locator('[data-testid="start-chat-backdrop"]');
  if (await backdrop.isVisible()) await backdrop.click();
  await expect(backdrop).toHaveCount(0);
}

async function openSettings(page: Page, section: string): Promise<void> {
  await page.locator('[data-testid="user-menu-trigger"]').click();
  await page.locator('[data-testid="menu-settings"]').click();
  await expect(page.locator('[data-testid="settings-page-content"]')).toBeVisible();
  await page.locator(`[data-testid="settings-nav-${section}"]`).click();
}

declare global {
  interface Window {
    __kepcupRpc: (method: string, input?: unknown) => Promise<unknown>;
  }
}

test('local connectors: hidden until developer mode; Bot proposal → card → add → listed (未审核, once) → delete; cancel discards', async () => {
  test.setTimeout(300_000);
  const llm = await startMockLlm();
  const fake = await startFakeOAuthMcpServer({ dcrEnabled: true });
  const home = await mkdtemp(path.join(tmpdir(), 'kepcup-e2e-local-connectors-'));
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
        // 测试钩子：假授权 / MCP 服务器在回环 http 上（生产恒为空，必须是 https 公网域名）。
        KEPCUP_TEST_OAUTH_LOOPBACK: '127.0.0.1',
      },
    });
    const page = await app.firstWindow();
    await waitReady(page);
    const dialog = page.locator('[data-testid="extension-center-dialog"]');
    const rpc = (method: string, input?: unknown) =>
      page.evaluate(([m, i]) => window.__kepcupRpc(m as string, i), [method, input] as const);

    // --- 开发者模式关闭：没有「本机自建」区 ------------------------------------------------
    await page.locator('[data-testid="extension-center-button"]').click();
    await dialog.locator('[data-testid="extension-center-tab-connections"]').click();
    await expect(dialog.locator('[data-testid="apps-catalog"]')).toBeVisible({ timeout: 30_000 });
    await expect(dialog.locator('[data-testid="local-connectors-section"]')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden({ timeout: 15_000 });

    // --- 打开开发者模式：区块出现（空态）--------------------------------------------------
    await openSettings(page, 'developer');
    await page.locator('[data-testid="mcp-dev-mode"]').click();
    await expect(page.locator('[data-testid="mcp-add"]')).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="settings-dialog"]')).toHaveCount(0);
    await page.locator('[data-testid="extension-center-button"]').click();
    await dialog.locator('[data-testid="extension-center-tab-connections"]').click();
    await expect(dialog.locator('[data-testid="local-connectors-section"]')).toBeVisible({
      timeout: 15_000,
    });
    await expect(dialog.locator('[data-testid="local-connectors-empty"]')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden({ timeout: 15_000 });

    // --- Bot 提案 → 确认卡 ---------------------------------------------------------------
    await createBotAndOpenChat(page, '小接');
    llm.script('mock-main', [
      step().inTurn().replyToolCall('app_local_connector_guide', {}),
      step().inTurn().replyToolCall('app_propose_local_connector', {
        mcpUrl: fake.mcpUrl,
        title: 'E2E 笔记',
        description: '端到端测试用的笔记服务',
        docUrl: 'https://docs.example.com/e2e-notes',
      }),
    ]);
    const composer = page.locator('[data-testid="composer-input"]');
    await composer.fill('帮我接入 E2E 笔记，文档在 https://docs.example.com/e2e-notes');
    await composer.press('ControlOrMeta+Enter');

    const card = page.locator('[data-testid="local-connector-card"]');
    await expect(card).toBeVisible({ timeout: 60_000 });
    await expect(card.locator('[data-testid="setup-card-title"]')).toContainText(
      'Bot 想添加一个本机连接',
    );
    // 域名（含端口）大字 + 完整地址：来自 core 的探测，与假服务器一致。
    await expect(card.locator('[data-testid="local-connector-host"]')).toHaveText(
      `127.0.0.1:${fake.port}`,
    );
    await expect(card.locator('[data-testid="local-connector-url"]')).toHaveText(fake.mcpUrl);
    await expect(card.locator('[data-testid="local-connector-auth"]')).toContainText('OAuth');
    await expect(card.locator('[data-testid="local-connector-issuer"]')).toHaveText(
      `127.0.0.1:${fake.port}`,
    );
    await expect(card.locator('[data-testid="local-connector-warnings"] li').first()).toBeVisible();
    await expect(card.locator('[data-testid="local-connector-warnings"]')).toContainText(
      '每一次工具调用都需要你确认',
    );
    // 文档链接只是纯文本：不是 <a>，卡片里没有任何链接。
    await expect(card.locator('[data-testid="local-connector-doc"]')).toHaveText(
      'https://docs.example.com/e2e-notes',
    );
    await expect(card.locator('a')).toHaveCount(0);
    await expect(page.locator('[data-testid="local-connector-add"]')).toBeEnabled();
    // Bot 自己没有保存任何东西。
    expect(
      ((await rpc('apps.localConnectors.list')) as { connectors: unknown[] }).connectors,
    ).toEqual([]);

    // --- 添加 → 接上连接步骤；条目进「本机自建」区，不进预置网格 ---------------------------
    await page.locator('[data-testid="local-connector-add"]').click();
    await expect(page.locator('[data-testid="local-connector-added"]')).toBeVisible({
      timeout: 30_000,
    });
    await expect(card).toHaveCount(0);
    await expect(page.locator('[data-testid="setup-card-connect"]')).toBeVisible({
      timeout: 15_000,
    });
    const listed = (await rpc('apps.localConnectors.list')) as {
      connectors: Array<{ connectorId: string; mcpHost: string }>;
    };
    expect(listed.connectors).toHaveLength(1);
    const connectorId = listed.connectors[0]!.connectorId;
    expect(listed.connectors[0]!.mcpHost).toBe(`127.0.0.1:${fake.port}`);

    await page.locator('[data-testid="extension-center-button"]').click();
    await dialog.locator('[data-testid="extension-center-tab-connections"]').click();
    const entry = dialog.locator(`[data-testid="local-connector-${connectorId}"]`);
    await expect(entry).toBeVisible({ timeout: 30_000 });
    await expect(entry.locator('[data-testid="local-connector-badge"]')).toHaveText('未审核');
    await expect(entry.locator('[data-testid="local-connector-title"]')).toHaveText('E2E 笔记');
    await expect(entry.locator('[data-testid="local-connector-host-label"]')).toHaveText(
      `127.0.0.1:${fake.port}`,
    );
    // 只出现一次：预置网格里没有它。
    await expect(dialog.locator(`[data-testid="apps-catalog-card-${connectorId}"]`)).toHaveCount(0);
    await expect(dialog.locator('[data-origin="local"]')).toHaveCount(1);
    // 连接面板沿用同一套：未审核徽标、不显示隐私政策。
    await dialog.locator(`[data-testid="local-connector-connect-${connectorId}"]`).click();
    const panel = dialog.locator(`[data-testid="local-connector-panel-${connectorId}"]`);
    await expect(panel).toBeVisible();
    await expect(panel.locator('[data-testid$="-local-badge"]')).toBeVisible();
    await expect(panel.locator('[data-testid$="-privacy"]')).toHaveCount(0);

    // --- 删除：确认框说明会断开全部账号 → 条目消失 -----------------------------------------
    await dialog.locator(`[data-testid="local-connector-delete-${connectorId}"]`).click();
    const removeDialog = page.locator('[data-testid="local-connector-remove-dialog"]');
    await expect(removeDialog).toBeVisible();
    await expect(removeDialog.locator('[data-testid="local-connector-remove-body"]')).toContainText(
      '此操作不可撤销',
    );
    await removeDialog.locator('[data-testid="local-connector-remove-confirm"]').click();
    await expect(entry).toHaveCount(0, { timeout: 30_000 });
    await expect(dialog.locator('[data-testid="local-connectors-empty"]')).toBeVisible();
    expect(
      ((await rpc('apps.localConnectors.list')) as { connectors: unknown[] }).connectors,
    ).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden({ timeout: 15_000 });

    // --- 另一条提案点「取消」：卡片收起，提案作废 ------------------------------------------
    llm.script('mock-main', [
      step().inTurn().replyToolCall('app_propose_local_connector', {
        mcpUrl: fake.mcpUrl,
        title: 'E2E 笔记',
      }),
    ]);
    // 先收起上一次留下的失败卡（添加后对话仍停在连接步骤）。
    await page.locator('[data-testid="setup-card-dismiss"]').click();
    await composer.fill('再来一次');
    await composer.press('ControlOrMeta+Enter');
    await expect(card).toBeVisible({ timeout: 60_000 });
    const proposalId = await card.getAttribute('data-proposal-id');
    await page.locator('[data-testid="local-connector-cancel"]').click();
    await expect(card).toHaveCount(0, { timeout: 15_000 });
    await expect(rpc('apps.localConnectors.confirm', { proposalId })).rejects.toThrow();
    expect(
      ((await rpc('apps.localConnectors.list')) as { connectors: unknown[] }).connectors,
    ).toEqual([]);
  } finally {
    await app?.close();
    await fake.stop();
    await llm.stop();
    await rm(home, { recursive: true, force: true });
  }
});

test('local connectors: a cross-site authorization server gets a red warning and 添加 stays disabled until acknowledged', async () => {
  test.setTimeout(240_000);
  const llm = await startMockLlm();
  // 授权服务器（127.0.0.1）与 MCP 服务（localhost）不是同一个站点。
  const authServer = await startFakeOAuthMcpServer({ dcrEnabled: true });
  const fake = await startFakeOAuthMcpServer({ dcrEnabled: true });
  fake.configure({
    prmAuthorizationServers: [authServer.issuer],
    prmResource: `http://localhost:${fake.port}/mcp`,
  });
  const home = await mkdtemp(path.join(tmpdir(), 'kepcup-e2e-local-crosssite-'));
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
        KEPCUP_TEST_OAUTH_LOOPBACK: '127.0.0.1,localhost',
      },
    });
    const page = await app.firstWindow();
    await waitReady(page);
    await openSettings(page, 'developer');
    await page.locator('[data-testid="mcp-dev-mode"]').click();
    await expect(page.locator('[data-testid="mcp-add"]')).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="settings-dialog"]')).toHaveCount(0);

    await createBotAndOpenChat(page, '小跨');
    llm.script('mock-main', [
      step()
        .inTurn()
        .replyToolCall('app_propose_local_connector', {
          mcpUrl: `http://localhost:${fake.port}/mcp`,
          title: '跨站笔记',
        }),
    ]);
    const composer = page.locator('[data-testid="composer-input"]');
    await composer.fill('接入跨站笔记');
    await composer.press('ControlOrMeta+Enter');

    const card = page.locator('[data-testid="local-connector-card"]');
    await expect(card).toBeVisible({ timeout: 60_000 });
    const warning = card.locator('[data-testid="local-connector-cross-site"]');
    await expect(warning).toBeVisible();
    // 点名两个域名。
    await expect(warning).toContainText(`localhost:${fake.port}`);
    await expect(warning).toContainText(`127.0.0.1:${authServer.port}`);
    // 未勾选：「添加」禁用。
    const add = page.locator('[data-testid="local-connector-add"]');
    await expect(add).toBeDisabled();
    await warning.locator('[data-testid="local-connector-cross-site-ack"]').check();
    await expect(add).toBeEnabled();
    await add.click();
    await expect(page.locator('[data-testid="local-connector-added"]')).toBeVisible({
      timeout: 30_000,
    });
  } finally {
    await app?.close();
    await fake.stop();
    await authServer.stop();
    await llm.stop();
    await rm(home, { recursive: true, force: true });
  }
});
