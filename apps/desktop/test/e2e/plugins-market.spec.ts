import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page,
  _electron,
} from '@playwright/test';
import type { PluginIndexEntry } from '@kepcup/shared';
import {
  buildPluginFixture,
  buildPluginIndex,
  makeMarketKey,
  pluginIndexEntryFor,
  startFileServer,
  startMockLlm,
  type PluginFixture,
  type PluginMarketKey,
  type TestFileServer,
} from '@kepcup/testkit';
import { rpc } from './helpers/create-bot';
import { rmHomeTolerant } from './helpers/home-cleanup';

/**
 * 插件市场 e2e（D104 P1-3 步骤 6.1）：本地 HTTP 服务托管用测试密钥签名的
 * `index.json` / `.sig` 与 `.kepcup` 包，环境变量 `KEPCUP_TEST_PLUGIN_MARKET`
 * 把官方市场指到它（仅测试钩子构建读取）。
 *
 * 覆盖：未配置市场（no_keys，无卡片）、浏览与筛选（认证 / 社区折叠、搜索、类别）、
 * 从市场安装（同意面板无 developer 警示）、检查更新 → 权限扩大差异勾选 → 更新
 * （更新入口在插件卡 ⋮ 菜单，卡面带「可更新」徽标）、撤销（页顶提示 + 卡面
 * 「已停用」态 + 菜单项换向「启用」）、自建市场缺公钥（no_custom_key）。
 *
 * Bot 确认卡不在这里脚本化：core 集成测试 `packages/core/test/integration/plugins-bot.test.ts`
 * 已覆盖「plugin_search → plugin_request_install → setup 失败 → 安装 → 重试续跑」全流程
 * （任务书允许的替代路径）。
 */

const VERIFIED_ID = 'io.e2e/market-alpha';
const COMMUNITY_ID = 'io.e2e/market-beta';

interface MarketEntryExtra {
  tier?: 'verified' | 'community';
  categories?: PluginIndexEntry['categories'];
}

interface Market {
  server: TestFileServer;
  baseUrl: string;
  key: PluginMarketKey;
  /** `KEPCUP_TEST_PLUGIN_MARKET` 的值。 */
  env: string;
  publish(input: {
    entries: Array<Record<string, unknown>>;
    revoked?: Array<Record<string, unknown>>;
  }): void;
  /** Serves the package bytes and returns an index entry bound to them. */
  serve(fixture: PluginFixture, extra?: MarketEntryExtra): Promise<PluginIndexEntry>;
  stop(): Promise<void>;
}

async function startMarket(): Promise<Market> {
  const server = await startFileServer({});
  const key = makeMarketKey('e2e-market');
  const baseUrl = `${server.url}/plugins/v1`;
  let generatedAt = Date.now();
  return {
    server,
    baseUrl,
    key,
    env: JSON.stringify({ baseUrl, keys: [key.publicEntry] }),
    publish({ entries, revoked }) {
      generatedAt += 1_000;
      const signed = buildPluginIndex({
        key,
        generatedAt,
        entries,
        ...(revoked !== undefined ? { revoked } : {}),
      });
      server.setFile('plugins/v1/index.json', signed.indexBytes);
      server.setFile('plugins/v1/index.json.sig', `${signed.sig}\n`);
    },
    async serve(fixture, extra = {}) {
      server.setFile(`plugins/v1/${fixture.sha256}.kepcup`, await readFile(fixture.path));
      return pluginIndexEntryFor(fixture, {
        downloadUrl: `${baseUrl}/${fixture.sha256}.kepcup`,
        ...extra,
      });
    },
    stop: () => server.stop(),
  };
}

/** 每个用例造的 `.kepcup` 夹具目录；用例结束后删掉，不留在系统临时目录里。 */
const fixtureDirs: string[] = [];
test.afterEach(async () => {
  for (const dir of fixtureDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function makeFixture(options: {
  id: string;
  name: string;
  version?: string;
  description?: string;
  skills?: string[];
  connectors?: string[];
}): Promise<PluginFixture> {
  const dir = await mkdtemp(path.join(tmpdir(), 'kepcup-e2e-market-fx-'));
  fixtureDirs.push(dir);
  return buildPluginFixture({
    dir,
    manifest: {
      id: options.id,
      name: options.name,
      version: options.version ?? '1.0.0',
      ...(options.description !== undefined ? { description: options.description } : {}),
    },
    skills: (options.skills ?? ['market-demo']).map((name) => ({ name })),
    connectors: (options.connectors ?? []).map((slug) => ({ slug })),
  });
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

async function launch(
  home: string,
  llmUrl: string,
  marketEnv?: string,
): Promise<{ app: ElectronApplication; page: Page }> {
  // 市场 e2e 不关心随包内置插件：指向空目录让「已安装」页只出现测试插件。
  const emptyBuiltin = path.join(home, '.empty-builtin-plugins');
  await mkdir(emptyBuiltin, { recursive: true });
  const env = {
    ...process.env,
    TZ: 'Asia/Shanghai',
    KEPCUP_HOME: home,
    NODE_ENV: 'test',
    KEPCUP_KEYSTORE: 'file',
    KEPCUP_ONBOARDING: 'off',
    KEPCUP_FILE_KEYSTORE_PATH: path.join(home, '.test-master-key'),
    KEPCUP_MOCK_LLM_URL: llmUrl,
    KEPCUP_BUILTIN_PLUGINS: emptyBuiltin,
  } as Record<string, string>;
  if (marketEnv === undefined) delete env.KEPCUP_TEST_PLUGIN_MARKET;
  else env.KEPCUP_TEST_PLUGIN_MARKET = marketEnv;
  const app = await _electron.launch({ args: ['.'], env });
  const page = await app.firstWindow();
  await waitReady(page);
  return { app, page };
}

async function openExtensionCenter(page: Page): Promise<Locator> {
  const dialog = page.locator('[data-testid="extension-center-dialog"]');
  await page.locator('[data-testid="extension-center-button"]').click();
  await expect(dialog).toBeVisible();
  return dialog;
}

async function openMarket(page: Page): Promise<Locator> {
  const dialog = await openExtensionCenter(page);
  await dialog.locator('[data-testid="extension-center-tab-market"]').click();
  await expect(dialog.locator('[data-testid="extension-market"]')).toBeVisible();
  return dialog;
}

async function openInstalled(page: Page): Promise<Locator> {
  const dialog = await openExtensionCenter(page);
  await dialog.locator('[data-testid="extension-center-tab-installed"]').click();
  await expect(dialog.locator('[data-testid="extension-installed"]')).toBeVisible();
  return dialog;
}

/** 点「刷新」并等同步结束（按钮回到可点状态）。 */
async function refreshMarket(dialog: Locator): Promise<void> {
  const button = dialog.locator('[data-testid="plugins-market-refresh"]');
  await expect(button).toBeEnabled({ timeout: 30_000 });
  await button.click();
  await expect(button).toBeEnabled({ timeout: 30_000 });
}

function card(dialog: Locator, id: string): Locator {
  return dialog.locator(`[data-testid="plugins-market-card-${id}"]`);
}

test('plugins market: without a published index the market shows a failed-sync banner and no cards', async () => {
  test.setTimeout(240_000);
  const llm = await startMockLlm();
  const home = await mkdtemp(path.join(tmpdir(), 'kepcup-e2e-market-off-'));
  // 官方公钥已内置（市场开启）：起一个测试市场但**不发布索引**，模拟不可达的市场源，
  // 断言降级横幅与空列表（替代公钥登记前的「尚未启用」关闭态）。
  const market = await startMarket();
  let app: ElectronApplication | null = null;
  try {
    const launched = await launch(home, llm.url, market.env);
    app = launched.app;
    const page = launched.page;
    const dialog = await openExtensionCenter(page);

    // 市场是第一个页签（D104 UI 修正：共三个页签）。
    const tabs = dialog.locator('[data-testid^="extension-center-tab-"]');
    await expect(tabs.first()).toHaveAttribute('data-testid', 'extension-center-tab-market');
    // D105 P4：两页签收敛。
    await expect(tabs).toHaveCount(2);
    await dialog.locator('[data-testid="extension-center-tab-market"]').click();

    const status = dialog.locator('[data-testid="plugins-market-status"]');
    await expect(status).toContainText(/同步失败|市场数据已超过 3 天/, { timeout: 30_000 });
    await expect(dialog.locator('[data-testid^="plugins-market-card-"]')).toHaveCount(0);
    // 失败状态不渲染「市场里没有插件」的误导性空态。
    await expect(dialog.locator('[data-testid="plugins-market-empty"]')).toHaveCount(0);
  } finally {
    await app?.close();
    await llm.stop();
    await market.stop();
    await rmHomeTolerant(home);
  }
});

test('plugins market: verified and community groups, search and category filters', async () => {
  test.setTimeout(240_000);
  const llm = await startMockLlm();
  const market = await startMarket();
  const home = await mkdtemp(path.join(tmpdir(), 'kepcup-e2e-market-browse-'));
  let app: ElectronApplication | null = null;
  try {
    const verified = await makeFixture({
      id: VERIFIED_ID,
      name: 'Alpha Tool',
      description: 'Verified alpha plugin',
    });
    const community = await makeFixture({
      id: COMMUNITY_ID,
      name: 'Beta Tool',
      description: 'Community beta plugin',
    });
    const verifiedEntry = await market.serve(verified, { categories: ['skill'] });
    const communityEntry = await market.serve(community, {
      tier: 'community',
      categories: ['mcp'],
    });
    market.publish({ entries: [verifiedEntry, communityEntry] });

    const launched = await launch(home, llm.url, market.env);
    app = launched.app;
    const page = launched.page;
    const dialog = await openMarket(page);
    await refreshMarket(dialog);

    await expect(card(dialog, VERIFIED_ID)).toBeVisible({ timeout: 30_000 });
    await expect(card(dialog, VERIFIED_ID)).toContainText('已认证');
    // 社区分组默认折叠：标题与开关在，卡片不在。
    await expect(dialog.locator('[data-testid="plugins-market-community-toggle"]')).toBeVisible();
    await expect(card(dialog, COMMUNITY_ID)).toHaveCount(0);
    await dialog.locator('[data-testid="plugins-market-community-toggle"]').click();
    await expect(card(dialog, COMMUNITY_ID)).toBeVisible();
    await expect(card(dialog, COMMUNITY_ID)).toContainText('社区');

    // 搜索：命中名称，另一条被过滤掉。
    const search = dialog.locator('[data-testid="plugins-market-search"]');
    await search.fill('alpha');
    await expect(card(dialog, VERIFIED_ID)).toBeVisible();
    await expect(card(dialog, COMMUNITY_ID)).toHaveCount(0);

    // 类别筛选：MCP → 只剩社区条目；技能 → 只剩认证条目。
    await search.fill('');
    await dialog.locator('[data-testid="plugins-market-cat-mcp"]').click();
    await expect(card(dialog, COMMUNITY_ID)).toBeVisible();
    await expect(card(dialog, VERIFIED_ID)).toHaveCount(0);
    await dialog.locator('[data-testid="plugins-market-cat-skill"]').click();
    await expect(card(dialog, VERIFIED_ID)).toBeVisible();
    await expect(card(dialog, COMMUNITY_ID)).toHaveCount(0);
    await dialog.locator('[data-testid="plugins-market-cat-all"]').click();
    await expect(card(dialog, VERIFIED_ID)).toBeVisible();
    await expect(card(dialog, COMMUNITY_ID)).toBeVisible();
  } finally {
    await app?.close();
    await llm.stop();
    await market.stop();
    await rmHomeTolerant(home);
  }
});

test('plugins market: install from the marketplace, then the market card is installed', async () => {
  test.setTimeout(240_000);
  const llm = await startMockLlm();
  const market = await startMarket();
  const home = await mkdtemp(path.join(tmpdir(), 'kepcup-e2e-market-install-'));
  let app: ElectronApplication | null = null;
  try {
    const fixture = await makeFixture({ id: VERIFIED_ID, name: 'Alpha Tool' });
    const entry = await market.serve(fixture, { categories: ['skill'] });
    market.publish({ entries: [entry] });

    const launched = await launch(home, llm.url, market.env);
    app = launched.app;
    const page = launched.page;
    const dialog = await openMarket(page);
    await refreshMarket(dialog);

    await card(dialog, VERIFIED_ID)
      .locator(`[data-testid="plugins-market-install-${VERIFIED_ID}"]`)
      .click();
    const install = page.locator('[data-testid="plugins-install-dialog"]');
    await expect(install).toBeVisible();
    // 市场模式打开即检视；认证来源没有 developer 警示。
    await expect(install.locator('[data-testid="plugins-consent"]')).toBeVisible({
      timeout: 30_000,
    });
    await expect(install.locator('[data-testid="plugins-consent-developer-warn"]')).toHaveCount(0);
    await expect(install.locator('[data-testid="plugins-consent"]')).toContainText('Alpha Tool');
    await install.locator('[data-testid="plugins-install-confirm"]').click();
    await expect(install).toBeHidden({ timeout: 30_000 });
    // D105 P4：安装成功后接入引导弹框（市场路径同样弹）——「完成」收掉再继续。
    const hint = page.locator('[data-testid="plugins-install-hint"]');
    await expect(hint).toBeVisible({ timeout: 15_000 });
    await hint.locator('[data-testid="plugins-install-hint-done"]').click();
    await expect(hint).toBeHidden({ timeout: 15_000 });

    // 市场卡变成「已安装」，按钮禁用。
    const installedButton = card(dialog, VERIFIED_ID).locator(
      `[data-testid="plugins-market-installed-${VERIFIED_ID}"]`,
    );
    await expect(installedButton).toContainText('已安装 · v1.0.0', { timeout: 30_000 });
    await expect(installedButton).toBeDisabled();

    // 「已安装」页签里出现，分级为已认证。
    await dialog.locator('[data-testid="extension-center-tab-installed"]').click();
    const installedCard = dialog.locator(`[data-testid="plugins-card-${VERIFIED_ID}"]`);
    await expect(installedCard).toBeVisible({ timeout: 30_000 });
    await expect(dialog.locator(`[data-testid="plugins-tier-${VERIFIED_ID}"]`)).toContainText(
      '已认证',
    );
  } finally {
    await app?.close();
    await llm.stop();
    await market.stop();
    await rmHomeTolerant(home);
  }
});

test('plugins market: check updates, acknowledge expanded permissions, update to 1.1.0', async () => {
  test.setTimeout(300_000);
  const llm = await startMockLlm();
  const market = await startMarket();
  const home = await mkdtemp(path.join(tmpdir(), 'kepcup-e2e-market-update-'));
  let app: ElectronApplication | null = null;
  try {
    const v1 = await makeFixture({ id: VERIFIED_ID, name: 'Alpha Tool', skills: ['market-alpha'] });
    const entryV1 = await market.serve(v1);
    market.publish({ entries: [entryV1] });

    const launched = await launch(home, llm.url, market.env);
    app = launched.app;
    const page = launched.page;
    const dialog = await openMarket(page);
    await refreshMarket(dialog);
    await rpc(page, 'plugins.install', {
      source: { kind: 'marketplace', id: VERIFIED_ID },
      sha256: entryV1.sha256,
      userConfig: {},
    });
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden({ timeout: 15_000 });

    // 新版本多出一个连接器（新主机 = 新权限）；权限扩大必须勾选差异确认。
    const v2 = await makeFixture({
      id: VERIFIED_ID,
      name: 'Alpha Tool',
      version: '1.1.0',
      skills: ['market-alpha', 'market-beta'],
      connectors: ['newhost'],
    });
    const entryV2 = await market.serve(v2);
    market.publish({ entries: [entryV1, entryV2] });

    const installed = await openInstalled(page);
    await installed.locator('[data-testid="plugins-check-updates"]').click();
    // 卡面出现「可更新」徽标；更新入口收在插件卡 ⋮ 菜单里（内容在 body 下的 portal）。
    await expect(
      installed.locator(`[data-testid="plugins-update-badge-${VERIFIED_ID}"]`),
    ).toBeVisible({ timeout: 30_000 });
    await installed.locator(`[data-testid="plugins-menu-${VERIFIED_ID}"]`).click();
    await page.locator(`[data-testid="plugins-update-${VERIFIED_ID}"]`).click();

    const install = page.locator('[data-testid="plugins-install-dialog"]');
    await expect(install).toBeVisible();
    const updateBlock = install.locator('[data-testid="plugins-install-update-block"]');
    await expect(updateBlock).toBeVisible({ timeout: 30_000 });
    await expect(updateBlock).toContainText('从 v1.0.0 更新到 v1.1.0');
    await expect(install.locator('[data-testid="plugins-consent-update-added"]')).toContainText(
      'market-beta',
    );
    await expect(install.locator('[data-testid="plugins-consent-update-added"]')).toContainText(
      'mcp.newhost.test',
    );
    const ack = install.locator('[data-testid="plugins-install-ack-diff"]');
    await expect(ack).toHaveAttribute('aria-checked', 'false');
    await expect(install.locator('[data-testid="plugins-install-confirm"]')).toBeDisabled();
    await ack.click();
    await expect(ack).toHaveAttribute('aria-checked', 'true');
    await expect(install.locator('[data-testid="plugins-install-confirm"]')).toBeEnabled();
    await install.locator('[data-testid="plugins-install-confirm"]').click();
    await expect(install).toBeHidden({ timeout: 30_000 });

    const installedCard = installed.locator(`[data-testid="plugins-card-${VERIFIED_ID}"]`);
    await expect(installedCard).toContainText('版本 1.1.0', { timeout: 30_000 });
    // 更新完成后卡面不再有「可更新」徽标。
    await expect(
      installed.locator(`[data-testid="plugins-update-badge-${VERIFIED_ID}"]`),
    ).toHaveCount(0, { timeout: 30_000 });
  } finally {
    await app?.close();
    await llm.stop();
    await market.stop();
    await rmHomeTolerant(home);
  }
});

test('plugins market: a revoked version is flagged and the plugin is disabled', async () => {
  test.setTimeout(240_000);
  const llm = await startMockLlm();
  const market = await startMarket();
  const home = await mkdtemp(path.join(tmpdir(), 'kepcup-e2e-market-revoke-'));
  let app: ElectronApplication | null = null;
  try {
    const fixture = await makeFixture({ id: VERIFIED_ID, name: 'Alpha Tool' });
    const entry = await market.serve(fixture);
    market.publish({ entries: [entry] });

    const launched = await launch(home, llm.url, market.env);
    app = launched.app;
    const page = launched.page;
    const dialog = await openMarket(page);
    await refreshMarket(dialog);
    await rpc(page, 'plugins.install', {
      source: { kind: 'marketplace', id: VERIFIED_ID },
      sha256: entry.sha256,
      userConfig: {},
    });
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden({ timeout: 15_000 });

    market.publish({
      entries: [entry],
      revoked: [{ id: VERIFIED_ID, action: 'disable', reason: 'e2e' }],
    });

    const installed = await openInstalled(page);
    await installed.locator('[data-testid="plugins-check-updates"]').click();
    const revoked = installed.locator(`[data-testid="plugins-revoked-${VERIFIED_ID}"]`);
    await expect(revoked).toBeVisible({ timeout: 30_000 });
    await expect(revoked).toContainText('已被撤销并自动停用');
    // 自动停用落在卡面上：「已停用」状态行 + ⋮ 菜单里的启停项换向「启用」。
    await expect(
      installed.locator(`[data-testid="plugins-disabled-${VERIFIED_ID}"]`),
    ).toBeVisible();
    await installed.locator(`[data-testid="plugins-menu-${VERIFIED_ID}"]`).click();
    await expect(page.locator(`[data-testid="plugins-toggle-${VERIFIED_ID}"]`)).toContainText(
      '启用',
    );
    // 关掉 ⋮ 菜单（不关弹框），再去看市场卡。
    await page.keyboard.press('Escape');
    await expect(page.locator(`[data-testid="plugins-toggle-${VERIFIED_ID}"]`)).toHaveCount(0);
    await expect(installed).toBeVisible();

    // 市场卡也带撤销徽标，且安装 / 更新按钮禁用（同版本已装、无更新 → installed 态）。
    await installed.locator('[data-testid="extension-center-tab-market"]').click();
    const marketCard = card(installed, VERIFIED_ID);
    await expect(marketCard).toBeVisible({ timeout: 30_000 });
    await expect(marketCard).toContainText('已被撤销并停用');
    await expect(
      marketCard.locator(`[data-testid="plugins-market-installed-${VERIFIED_ID}"]`),
    ).toBeDisabled();
  } finally {
    await app?.close();
    await llm.stop();
    await market.stop();
    await rmHomeTolerant(home);
  }
});

test('plugins market: a custom marketplace without a signing key shows no_custom_key', async () => {
  test.setTimeout(240_000);
  const llm = await startMockLlm();
  const market = await startMarket();
  const home = await mkdtemp(path.join(tmpdir(), 'kepcup-e2e-market-custom-'));
  let app: ElectronApplication | null = null;
  try {
    const fixture = await makeFixture({ id: VERIFIED_ID, name: 'Alpha Tool' });
    const entry = await market.serve(fixture);
    market.publish({ entries: [entry] });

    const launched = await launch(home, llm.url, market.env);
    app = launched.app;
    const page = launched.page;
    const installed = await openInstalled(page);

    // 市场设置在应用「设置 → 插件」（D104 UI 修正）：填自建市场地址。
    const openMarketSettings = async (): Promise<Locator> => {
      await page.keyboard.press('Escape');
      await expect(page.locator('[data-testid="extension-center-dialog"]')).toBeHidden();
      await page.locator('[data-testid="user-menu-trigger"]').click();
      await page.locator('[data-testid="menu-settings"]').click();
      await expect(page.locator('[data-testid="settings-page-content"]')).toBeVisible();
      await page.locator('[data-testid="settings-nav-plugins"]').click();
      const anchor = page.locator('[data-settings-anchor="plugins-marketplace"]');
      return anchor.locator('[data-testid="setting-card-fields-url"]');
    };
    const backToMarket = async (): Promise<void> => {
      await page.keyboard.press('Escape');
      await expect(page.locator('[data-testid="settings-dialog"]')).toBeHidden();
      await page.locator('[data-testid="extension-center-button"]').click();
      await installed.locator('[data-testid="extension-center-tab-market"]').click();
    };

    const urlInput = await openMarketSettings();
    await urlInput.fill('https://self.test/plugins/v1');
    await urlInput.press('Enter');
    await expect
      .poll(
        async () => {
          const settings = (await rpc(page, 'settings.get')) as { pluginMarketplaceUrl: string };
          return settings.pluginMarketplaceUrl;
        },
        { timeout: 30_000 },
      )
      .toBe('https://self.test/plugins/v1');

    await backToMarket();
    await expect(installed.locator('[data-testid="plugins-market-status"]')).toContainText(
      '已设置自建市场地址但没有填写签名公钥',
      { timeout: 30_000 },
    );
    await expect(installed.locator('[data-testid^="plugins-market-card-"]')).toHaveCount(0);

    // 清空自建地址 → 回到官方市场：重新进入市场页必须重新拉取（不能停在 no_custom_key）。
    const urlInput2 = await openMarketSettings();
    await urlInput2.fill('');
    await urlInput2.press('Enter');
    await expect
      .poll(
        async () => {
          const settings = (await rpc(page, 'settings.get')) as { pluginMarketplaceUrl: string };
          return settings.pluginMarketplaceUrl;
        },
        { timeout: 30_000 },
      )
      .toBe('');
    await backToMarket();
    await expect(card(installed, VERIFIED_ID)).toBeVisible({ timeout: 30_000 });
  } finally {
    await app?.close();
    await llm.stop();
    await market.stop();
    await rmHomeTolerant(home);
  }
});
