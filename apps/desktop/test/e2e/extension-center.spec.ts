import { mkdtemp } from 'node:fs/promises';
import { rmHomeTolerant } from './helpers/home-cleanup';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page, _electron } from '@playwright/test';
import { buildPluginFixture, startMockLlm } from '@kepcup/testkit';
import { rpc } from './helpers/create-bot';
import { copyShippedPlugins } from './helpers/builtin-plugins';

/**
 * 扩展中心分组 e2e（197db376 起为插件卡模型）：
 * - 三个分组页签：市场 / 已安装（插件）/ 本机应用协作；「技能 / 连接 / MCP / 邮件」是
 *   「已安装」顶部的内容筛选 chips，只过滤插件卡网格，不再是独立分组视图；
 * - 「连接」筛选视图 = 插件卡网格 + 本机自建独立区，没有「填 URL」入口；
 *   连接应用的目录 / 账号管理从插件卡「管理 · 连接应用」进入（多连接插件进目录网格，
 *   单连接直达账号管理流）；
 * - MCP 完整管理（新建 server / BYO 客户端）从插件卡「管理 · 工具」进入
 *   plugins-content-mcp 内容视图，不依赖开发者模式；
 * - 设置「应用」只管已连接账号，并能跳到扩展中心；设置里不再有「开发者模式」分区。
 *
 * 目录来源说明：测试构建下 core 默认用**空目录**（start.ts 在 test hooks + NODE_ENV=test 且没设
 * `KEPCUP_BUILTIN_PLUGINS` 时强制空源），发行门禁的 define 只在 `scripts/dist.mjs` 打包时注入，
 * 所以这里的空态**不**证明发行门禁；门禁语义由 core `connector-catalog.test.ts` 覆盖。
 * 第二个用例把 `KEPCUP_BUILTIN_PLUGINS` 指向临时目录（copyShippedPlugins 从 plugins/ 开发目录组装夹具、
 * 只保留 Notion 条目）来验证非空目录的渲染。两个用例都经测试缝补装一个只带 MCP 贡献的
 * 插件，MCP 管理入口挂在它的插件卡上。
 */

/** 经测试缝安装一个只带 http MCP 贡献的插件（扩展中心按插件卡组织，MCP 管理入口在卡上）。 */
async function installMcpOnlyPlugin(page: Page): Promise<void> {
  const fixture = await buildPluginFixture({
    dir: await mkdtemp(path.join(tmpdir(), 'kepcup-e2e-extcenter-fx-')),
    manifest: { id: 'io.github.tester/mcp-only', name: 'MCP Only' },
    http: [{ id: 'docs', url: 'https://mcp.docs.test/mcp' }],
  });
  await rpc(page, 'plugins.install', {
    source: { kind: 'file', path: fixture.path },
    sha256: fixture.sha256,
    userConfig: {},
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

async function openSettings(page: Page, section: string): Promise<void> {
  await page.locator('[data-testid="user-menu-trigger"]').click();
  await page.locator('[data-testid="menu-settings"]').click();
  await expect(page.locator('[data-testid="settings-page-content"]')).toBeVisible();
  await page.locator(`[data-testid="settings-nav-${section}"]`).click();
}

test('extension center: groups, no free-form URL in 连接, full MCP management without developer mode', async () => {
  test.setTimeout(240_000);
  const llm = await startMockLlm();
  const home = await mkdtemp(path.join(tmpdir(), 'kepcup-e2e-extcenter-'));
  let app: ElectronApplication | null = null;
  try {
    app = await _electron.launch({
      args: ['.'],
      env: {
        ...process.env,
        TZ: 'Asia/Shanghai',
        KEPCUP_HOME: home,
        NODE_ENV: 'test',
        KEPCUP_KEYSTORE: 'file',
        KEPCUP_ONBOARDING: 'off',
        KEPCUP_FILE_KEYSTORE_PATH: path.join(home, '.test-master-key'),
        KEPCUP_MOCK_LLM_URL: llm.url,
      },
    });
    const page = await app.firstWindow();
    await waitReady(page);
    // 补装一个只带 MCP 贡献的插件：MCP 管理入口挂在插件卡「管理 · 工具」上。
    await installMcpOnlyPlugin(page);

    const dialog = page.locator('[data-testid="extension-center-dialog"]');
    await page.locator('[data-testid="extension-center-button"]').click();
    await expect(dialog).toBeVisible();

    // 全局弹层拖拽带（window-drag-band.ts）：弹框开着时激活，且必须是 body
    // 最后一个子节点（app-region 矩形按 DOM 顺序后者胜出，沉不了底就压不过
    // 浮层的 no-drag，窗口拖不动的问题会复发）。
    const dragBand = page.locator('[data-testid="window-drag-band"]');
    await expect(dragBand).toHaveAttribute('data-active', 'true');
    await expect
      .poll(() => page.evaluate(() => document.body.lastElementChild?.getAttribute('data-testid')))
      .toBe('window-drag-band');
    await expect(dialog.locator('[data-testid="extension-center-tab-installed"]')).toHaveAttribute(
      'aria-selected',
      'true',
    );

    // 连接筛选只作用于插件卡网格：装的是纯 MCP 插件 → 该类别空态；
    // 本机自建是网格下方的独立区（空态引导 Bot 提案）；没有填 URL 的入口
    // （无目录卡、无 mcp-add / mcp-new-kind）。
    await dialog.locator('[data-testid="plugins-filter-connector"]').click();
    await expect(dialog.locator('[data-testid="plugins-filter-empty"]')).toBeVisible({
      timeout: 30_000,
    });
    await expect(dialog.locator('[data-testid^="apps-catalog-card-"]')).toHaveCount(0);
    await expect(dialog.locator('[data-testid="mcp-add"]')).toHaveCount(0);
    await expect(dialog.locator('[data-testid="mcp-new-kind"]')).toHaveCount(0);
    await expect(dialog.locator('[data-testid="local-connectors-section"]')).toBeVisible();
    await expect(dialog.locator('[data-testid="local-connectors-empty"]')).toBeVisible();

    // MCP：筛选里有插件卡 →「管理 · 工具」进内容视图（plugins-content-mcp，内嵌完整
    // 管理：可新建 server / BYO 客户端 / .mcpb），不依赖开发者模式；插件的受管
    // server 行也在其中。
    await dialog.locator('[data-testid="plugins-filter-mcp"]').click();
    const mcpCard = dialog.locator('[data-testid="plugins-card-io.github.tester/mcp-only"]');
    await expect(mcpCard).toBeVisible({ timeout: 30_000 });
    await mcpCard.locator('[data-testid="plugins-manage-mcp-io.github.tester/mcp-only"]').click();
    await expect(dialog.locator('[data-testid="plugins-content-mcp"]')).toBeVisible();
    await expect(dialog.locator('[data-testid="mcp-section"]')).toBeVisible();
    await expect(dialog.locator('[data-testid="mcp-add"]')).toBeVisible();
    await expect(dialog.locator('[data-testid="mcp-new-kind"]')).toBeVisible();
    await expect(dialog.locator('[data-testid^="mcp-server-plg_"]')).toBeVisible();

    // 键盘：方向键切换分组（tabs: market → installed → localCollab）。
    await dialog.locator('[data-testid="extension-center-tab-installed"]').press('ArrowRight');
    await expect(
      dialog.locator('[data-testid="extension-center-tab-localCollab"]'),
    ).toHaveAttribute('aria-selected', 'true');
    await dialog.locator('[data-testid="extension-center-tab-localCollab"]').press('ArrowRight');
    await expect(dialog.locator('[data-testid="extension-center-tab-market"]')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    // 末项再往右循环回第一项（market → installed）。
    await dialog.locator('[data-testid="extension-center-tab-market"]').press('ArrowRight');
    await expect(dialog.locator('[data-testid="extension-center-tab-installed"]')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden({ timeout: 15_000 });
    await expect(dragBand).toHaveAttribute('data-active', 'false');

    // 设置里不再有「应用」分区（已连接账号 / 连接应用 / 邮箱都在扩展中心对应分组），
    // 也不再有「开发者模式」分区。
    await openSettings(page, 'general');
    await expect(page.locator('[data-testid="apps-section"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="settings-nav-apps"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="apps-tabs"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="mcp-section"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="settings-nav-developer"]')).toHaveCount(0);
  } finally {
    await app?.close();
    await llm.stop();
    await rmHomeTolerant(home);
  }
});

test('extension center: non-empty catalog renders cards in 连接; existing MCP server target is editable', async () => {
  test.setTimeout(240_000);
  const llm = await startMockLlm();
  const home = await mkdtemp(path.join(tmpdir(), 'kepcup-e2e-extcenter2-'));
  // 临时目录：拷随包内置插件并只保留 Notion 条目（核心按 KEPCUP_BUILTIN_PLUGINS 读取；测试构建不过滤门禁）。
  const pluginsDir = await copyShippedPlugins(path.join(home, 'builtin-plugins'), {
    connectorSlugs: ['notion'],
  });
  expect(pluginsDir).toBeDefined();
  let app: ElectronApplication | null = null;
  try {
    app = await _electron.launch({
      args: ['.'],
      env: {
        ...process.env,
        TZ: 'Asia/Shanghai',
        KEPCUP_HOME: home,
        NODE_ENV: 'test',
        KEPCUP_KEYSTORE: 'file',
        KEPCUP_ONBOARDING: 'off',
        KEPCUP_FILE_KEYSTORE_PATH: path.join(home, '.test-master-key'),
        KEPCUP_MOCK_LLM_URL: llm.url,
        KEPCUP_BUILTIN_PLUGINS: pluginsDir,
      },
    });
    const page = await app.firstWindow();
    await waitReady(page);
    // 补装一个只带 MCP 贡献的插件：MCP 管理入口挂在插件卡「管理 · 工具」上。
    await installMcpOnlyPlugin(page);
    const dialog = page.locator('[data-testid="extension-center-dialog"]');
    await page.locator('[data-testid="extension-center-button"]').click();

    // 连接筛选：非空目录 → Notion 插件卡；「管理」直达账号管理流（单连接插件，
    // 0 账号 = 首连面板），面板里是目录条目（标题 + 插件徽标）而非账号详情；
    // 未连接 → 没有账号数；没有填 URL 的入口（无 mcp-add，也不再有目录卡 / 连接按钮）。
    await dialog.locator('[data-testid="extension-center-tab-installed"]').click();
    await dialog.locator('[data-testid="plugins-filter-connector"]').click();
    const pluginCard = dialog.locator('[data-testid="plugins-card-app.kepcup/connector-notion"]');
    await expect(pluginCard).toBeVisible({ timeout: 30_000 });
    await expect(pluginCard).toContainText('Notion');
    await pluginCard
      .locator('[data-testid="plugins-manage-connector-app.kepcup/connector-notion"]')
      .click();
    await expect(dialog.locator('[data-testid="plugins-manage-back"]')).toBeVisible();
    const panel = dialog.locator('[data-testid="plugins-manage-connect-panel"]');
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(panel.locator('[data-testid="plugins-manage-connect-panel-title"]')).toContainText(
      'Notion',
    );
    await expect(
      panel.locator('[data-testid="plugins-manage-connect-panel-plugin-badge-notion"]'),
    ).toBeVisible();
    await expect(dialog.locator('[data-testid="apps-catalog-accounts"]')).toHaveCount(0);
    await expect(dialog.locator('[data-testid="mcp-add"]')).toHaveCount(0);
    // 连接视图不再渲染目录卡（目录网格归多连接插件的「管理」视图），也没有「连接」按钮。
    await expect(dialog.locator('[data-testid="apps-catalog-card-notion"]')).toHaveCount(0);
    await expect(dialog.locator('[data-testid="apps-catalog-connect-notion"]')).toHaveCount(0);

    // 一个已有的 HTTP MCP server（直接经 core RPC 写入；渲染端设置快照不监听该变更，重载页面后可见）：
    // 在插件卡的「管理 · 工具」内容视图里，编辑表单地址可改（不再挂开发者模式门禁）。
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden({ timeout: 15_000 });
    // 手动 server 与插件受管 server 并存：settings.update 是整表替换，直接替换会把
    // 插件受管 server 一起删掉（PLUGIN_MANAGED 守卫拒绝）——先读现值再合并追加。
    await page.evaluate(async () => {
      const rpc = window.__kepcupRpc;
      const current = (await rpc('settings.get', undefined)) as {
        mcpServers: Array<Record<string, unknown>>;
      };
      await rpc('settings.update', {
        mcpServers: [
          ...current.mcpServers,
          {
            id: 'ro',
            name: 'RO Server',
            transport: 'http',
            url: 'https://mcp.example.test/mcp',
            auth: 'none',
            enabled: true,
            autoApprove: false,
          },
        ],
      });
    });
    await page.reload();
    await waitReady(page);
    await page.locator('[data-testid="extension-center-button"]').click();
    await dialog.locator('[data-testid="extension-center-tab-installed"]').click();
    const mcpCard = dialog.locator('[data-testid="plugins-card-io.github.tester/mcp-only"]');
    await expect(mcpCard).toBeVisible({ timeout: 30_000 });
    await mcpCard.locator('[data-testid="plugins-manage-mcp-io.github.tester/mcp-only"]').click();
    await expect(dialog.locator('[data-testid="plugins-content-mcp"]')).toBeVisible();
    await expect(dialog.locator('[data-testid="mcp-server-ro"]')).toBeVisible({
      timeout: 30_000,
    });
    await expect(dialog.locator('[data-testid="mcp-add"]')).toBeVisible();
    await dialog.locator('[data-testid="mcp-edit-ro"]').click();
    await expect(dialog.locator('[data-testid="mcp-target-locked"]')).toHaveCount(0);
    await expect(dialog.locator('#mcp-url')).not.toHaveAttribute('readonly', '');
    await expect(dialog.locator('#mcp-name')).not.toHaveAttribute('readonly', '');
  } finally {
    await app?.close();
    await llm.stop();
    await rmHomeTolerant(home);
  }
});
