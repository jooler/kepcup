import { mkdtemp } from 'node:fs/promises';
import { rmHomeTolerant } from './helpers/home-cleanup';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page, _electron } from '@playwright/test';
import { startMockLlm } from '@kepcup/testkit';
import { copyShippedPlugins } from './helpers/builtin-plugins';

/**
 * 扩展中心分组 e2e：
 * - 六个分组：已安装（插件）/ Skills / 连接 / MCP / 邮件 / 本机应用协作；
 * - 「连接」只有目录卡片，没有「填 URL」入口；
 * - 「MCP」可新建 server、管理已安装项、配置 BYO OAuth 客户端（不再挂开发者模式）；
 * - 设置「应用」只管已连接账号，并能跳到扩展中心「连接」；设置里不再有「开发者模式」分区。
 *
 * 目录来源说明：测试构建下 core 默认用**空目录**（start.ts 在 test hooks + NODE_ENV=test 且没设
 * `KEPCUP_BUILTIN_PLUGINS` 时强制空源），发行门禁的 define 只在 `scripts/dist.mjs` 打包时注入，
 * 所以这里的空态**不**证明发行门禁；门禁语义由 core `connector-catalog.test.ts` 覆盖。
 * 第二个用例把 `KEPCUP_BUILTIN_PLUGINS` 指向临时目录（copyShippedPlugins 拷随包内置插件、
 * 只保留 Notion 条目）来验证非空目录的渲染。
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
    await expect(dialog.locator('[data-testid="extension-center-tab-skills"]')).toHaveAttribute(
      'aria-selected',
      'true',
    );

    // 连接：测试构建默认空目录 → 空态；没有填 URL 的入口。
    await dialog.locator('[data-testid="extension-center-tab-connections"]').click();
    await expect(dialog.locator('[data-testid="apps-catalog-none"]')).toHaveText(
      '暂无已适配的应用',
      {
        timeout: 30_000,
      },
    );
    await expect(dialog.locator('[data-testid^="apps-catalog-card-"]')).toHaveCount(0);
    await expect(dialog.locator('[data-testid="mcp-add"]')).toHaveCount(0);
    await expect(dialog.locator('[data-testid="mcp-new-kind"]')).toHaveCount(0);

    // MCP：完整管理（可新建 server / BYO 客户端 / .mcpb），不依赖开发者模式。
    await dialog.locator('[data-testid="extension-center-tab-mcp"]').click();
    await expect(dialog.locator('[data-testid="mcp-section"]')).toBeVisible();
    await expect(dialog.locator('[data-testid="mcp-add"]')).toBeVisible();
    await expect(dialog.locator('[data-testid="mcp-new-kind"]')).toBeVisible();

    // 键盘：方向键切换分组（tabs: installed → skills → connections → mcp → mail → localCollab）。
    await dialog.locator('[data-testid="extension-center-tab-mcp"]').press('ArrowRight');
    await expect(dialog.locator('[data-testid="extension-center-tab-mail"]')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await dialog.locator('[data-testid="extension-center-tab-mail"]').press('ArrowRight');
    await expect(
      dialog.locator('[data-testid="extension-center-tab-localCollab"]'),
    ).toHaveAttribute('aria-selected', 'true');
    // 末项再往右循环回第一项（installed）。
    await dialog.locator('[data-testid="extension-center-tab-localCollab"]').press('ArrowRight');
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
    const dialog = page.locator('[data-testid="extension-center-dialog"]');
    await page.locator('[data-testid="extension-center-button"]').click();

    // 连接：非空目录 → 卡片、连接按钮；未连接 → 没有「管理」、没有账号数；没有填 URL 的入口。
    await dialog.locator('[data-testid="extension-center-tab-connections"]').click();
    const card = dialog.locator('[data-testid="apps-catalog-card-notion"]');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toContainText('Notion');
    await expect(dialog.locator('[data-testid="apps-catalog-none"]')).toHaveCount(0);
    await expect(card.locator('[data-testid="apps-catalog-accounts"]')).toHaveCount(0);
    await expect(dialog.locator('[data-testid="apps-catalog-manage-notion"]')).toHaveCount(0);
    await expect(dialog.locator('[data-testid="mcp-add"]')).toHaveCount(0);
    // 点「连接」在卡片内展开连接面板（授权本身要真实浏览器，这里不发起）。
    await dialog.locator('[data-testid="apps-catalog-connect-notion"]').click();
    await expect(dialog.locator('[data-testid="apps-catalog-panel-notion"]')).toBeVisible();

    // 一个已有的 HTTP MCP server（直接经 core RPC 写入；渲染端设置快照不监听该变更，重载页面后可见）：
    // 编辑表单里地址可改（不再挂开发者模式门禁）。
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden({ timeout: 15_000 });
    await page.evaluate(() =>
      window.__kepcupRpc('settings.update', {
        mcpServers: [
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
      }),
    );
    await page.reload();
    await waitReady(page);
    await page.locator('[data-testid="extension-center-button"]').click();
    await dialog.locator('[data-testid="extension-center-tab-mcp"]').click();
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
