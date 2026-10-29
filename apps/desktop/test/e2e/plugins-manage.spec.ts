import { mkdir, mkdtemp } from 'node:fs/promises';
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
import { buildPluginFixture, startMockLlm } from '@kepcup/testkit';
import { createBotAndOpenChat, rpc } from './helpers/create-bot';
import { rmHomeTolerant } from './helpers/home-cleanup';

/**
 * 插件卡管理 e2e（D105 P4）：
 * - 卡片「设置」：声明 `config.fields` 的插件 ⋮ 菜单出现「设置…」，卡内就地展开
 *   PluginFieldForm；保存 `plugins.config.set`（非敏感落 config_json、敏感入 secrets，
 *   表单只见「已保存」占位）；重开回显非敏感值；
 * - 安装成功接入引导弹框：UI 安装路径成功后出现（标题含插件名），「立即添加到 Bot…」
 *   多选写入各 Bot 的 plugin_ids；勾「以后不再提醒」落 localStorage，之后的安装不再弹；
 * - 两页签收敛：market / installed 两个页签；已安装页网格末尾的系统卡
 *   （本机应用协作 / 本机自建连接，badge「系统」、无插件菜单）可展开。
 *
 * 安装全走路径输入框（e2e 环境无原生对话框）；config 夹具不含 mcpb。
 */

const CONFIG_PLUGIN_ID = 'io.github.tester/configured';
const SECOND_PLUGIN_ID = 'io.github.tester/second';

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
): Promise<{ app: ElectronApplication; page: Page }> {
  const emptyBuiltin = path.join(home, '.empty-builtin-plugins');
  await mkdir(emptyBuiltin, { recursive: true });
  const app = await _electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      TZ: 'Asia/Shanghai',
      KEPCUP_HOME: home,
      NODE_ENV: 'test',
      KEPCUP_KEYSTORE: 'file',
      KEPCUP_ONBOARDING: 'off',
      KEPCUP_FILE_KEYSTORE_PATH: path.join(home, '.test-master-key'),
      KEPCUP_MOCK_LLM_URL: llmUrl,
      KEPCUP_BUILTIN_PLUGINS: emptyBuiltin,
    },
  });
  const page = await app.firstWindow();
  await waitReady(page);
  return { app, page };
}

async function makeConfigFixture(dir: string): Promise<{ path: string; sha256: string }> {
  const built = await buildPluginFixture({
    dir,
    manifest: {
      id: CONFIG_PLUGIN_ID,
      name: '配置插件',
      config: {
        fields: [
          {
            key: 'endpoint',
            type: 'string',
            title: '服务地址',
            description: '插件后端地址',
            required: true,
            sensitive: false,
            multiple: false,
          },
          {
            key: 'apikey',
            type: 'string',
            title: '接口密钥',
            description: '',
            required: true,
            sensitive: true,
            multiple: false,
          },
        ],
      },
    },
    skills: [{ name: 'plg-cfg-skill' }],
  });
  return { path: built.path, sha256: built.sha256 };
}

async function makePlainFixture(
  dir: string,
  id: string,
  name: string,
): Promise<{ path: string; sha256: string }> {
  const built = await buildPluginFixture({
    dir,
    manifest: { id, name },
    skills: [{ name: `plg-${id.split('/')[1]!}-skill` }],
  });
  return { path: built.path, sha256: built.sha256 };
}

async function openInstalledTab(page: Page): Promise<Locator> {
  const dialog = page.locator('[data-testid="extension-center-dialog"]');
  await page.locator('[data-testid="extension-center-button"]').click();
  await expect(dialog).toBeVisible();
  await dialog.locator('[data-testid="extension-center-tab-installed"]').click();
  await expect(dialog.locator('[data-testid="extension-installed"]')).toBeVisible();
  return dialog;
}

/** 经路径输入框走完整 UI 安装流（检视 → 同意 → 确认），返回安装对话框定位器。 */
async function installViaUi(
  page: Page,
  dialog: Locator,
  fixture: { path: string; sha256: string },
): Promise<Locator> {
  await dialog.locator('[data-testid="plugins-install-file"]').click();
  const installDialog = page.locator('[data-testid="plugins-install-dialog"]');
  await expect(installDialog).toBeVisible();
  await installDialog.locator('[data-testid="plugins-install-path"]').fill(fixture.path);
  await installDialog.locator('[data-testid="plugins-install-inspect"]').click();
  await expect(
    installDialog.locator('[data-testid="plugins-install-confirm"]'),
  ).toBeEnabled({ timeout: 30_000 });
  await installDialog.locator('[data-testid="plugins-install-confirm"]').click();
  await expect(installDialog).toBeHidden({ timeout: 30_000 });
  return installDialog;
}

test('plugins-manage: card settings form round-trips config through config_json + secrets', async () => {
  test.setTimeout(240_000);
  const llm = await startMockLlm();
  const home = await mkdtemp(path.join(tmpdir(), 'kepcup-e2e-plugins-config-'));
  let app: ElectronApplication | null = null;
  try {
    const launched = await launch(home, llm.url);
    app = launched.app;
    const page = launched.page;
    const fixture = await makeConfigFixture(path.join(home, 'fx-config'));

    const dialog = await openInstalledTab(page);
    await installViaUi(page, dialog, fixture);
    const card = dialog.locator(`[data-testid="plugins-card-${CONFIG_PLUGIN_ID}"]`);
    await expect(card).toBeVisible({ timeout: 30_000 });

    // UI 安装成功后引导弹框先弹（无 Bot 也弹）：先「完成」收掉再操作卡片。
    await expect(page.locator('[data-testid="plugins-install-hint"]')).toBeVisible({
      timeout: 15_000,
    });
    await page.locator('[data-testid="plugins-install-hint-done"]').click();
    await expect(page.locator('[data-testid="plugins-install-hint"]')).toBeHidden();

    // ⋮ 菜单出现「设置…」（configFields 非空才出现），点开卡内表单。
    // 菜单内容渲染在 body portal：先点开卡右上角 ⋮ 触发器，再点菜单项。
    await card.locator(`[data-testid="plugins-menu-${CONFIG_PLUGIN_ID}"]`).click();
    await page.locator(`[data-testid="plugins-config-menu-${CONFIG_PLUGIN_ID}"]`).click();
    const panel = dialog.locator(`[data-testid="plugins-config-${CONFIG_PLUGIN_ID}"]`);
    await expect(panel).toBeVisible();
    await panel
      .locator(`[data-testid="plugins-config-${CONFIG_PLUGIN_ID}-field-endpoint"]`)
      .fill('https://cfg.example.com');
    await panel
      .locator(`[data-testid="plugins-config-${CONFIG_PLUGIN_ID}-field-apikey"]`)
      .fill('sk-live-SECRET');
    await panel.locator(`[data-testid="plugins-config-${CONFIG_PLUGIN_ID}-save"]`).click();
    await expect(panel).toBeHidden({ timeout: 15_000 });

    // 落点：非敏感进 config_json，敏感只进 secrets（快照只有键名，永无明文）。
    const config = (await rpc(page, 'plugins.config.get', { id: CONFIG_PLUGIN_ID })) as {
      values: Record<string, unknown>;
      storedSensitiveKeys: string[];
    };
    expect(config.values.endpoint).toBe('https://cfg.example.com');
    expect(config.values.apikey).toBeUndefined();
    expect(config.storedSensitiveKeys).toEqual(['apikey']);

    // 重开回显：非敏感值在表单里；敏感框空、给「已保存」占位（明文不回显）。
    await card.locator(`[data-testid="plugins-menu-${CONFIG_PLUGIN_ID}"]`).click();
    await page.locator(`[data-testid="plugins-config-menu-${CONFIG_PLUGIN_ID}"]`).click();
    await expect(panel).toBeVisible();
    await expect(
      panel.locator(`[data-testid="plugins-config-${CONFIG_PLUGIN_ID}-field-endpoint"]`),
    ).toHaveValue('https://cfg.example.com');
    await expect(
      panel.locator(`[data-testid="plugins-config-${CONFIG_PLUGIN_ID}-field-apikey"]`),
    ).toHaveValue('');
  } finally {
    await app?.close();
    await llm.stop();
    await rmHomeTolerant(home);
  }
});

test('plugins-manage: install hint dialog adds the plugin to chosen bots and honours never-remind', async () => {
  test.setTimeout(300_000);
  const llm = await startMockLlm();
  const home = await mkdtemp(path.join(tmpdir(), 'kepcup-e2e-plugins-hint-'));
  let app: ElectronApplication | null = null;
  try {
    const launched = await launch(home, llm.url);
    app = launched.app;
    const page = launched.page;
    const { botId: botA } = await createBotAndOpenChat(page, '引导甲');
    const { botId: botB } = await createBotAndOpenChat(page, '引导乙');
    const first = await makePlainFixture(path.join(home, 'fx-hint-1'), CONFIG_PLUGIN_ID, '引导一');
    const second = await makePlainFixture(
      path.join(home, 'fx-hint-2'),
      SECOND_PLUGIN_ID,
      '引导二',
    );

    const dialog = await openInstalledTab(page);

    // 第一次安装：引导弹框出现，标题带插件名。
    await installViaUi(page, dialog, first);
    const hint = page.locator('[data-testid="plugins-install-hint"]');
    await expect(hint).toBeVisible({ timeout: 15_000 });
    await expect(hint.locator('[data-testid="plugins-install-hint-title"]')).toContainText('引导一');

    // 立即添加到 Bot…：勾两个 Bot → 添加 → 两边 plugin_ids 都含新插件。
    await hint.locator('[data-testid="plugins-install-hint-add"]').click();
    await hint.locator(`[data-testid="plugins-install-hint-bot-${botA}"]`).click();
    await hint.locator(`[data-testid="plugins-install-hint-bot-${botB}"]`).click();
    await hint.locator('[data-testid="plugins-install-hint-confirm"]').click();
    await expect(hint).toBeHidden({ timeout: 15_000 });
    for (const id of [botA, botB]) {
      const bot = (await rpc(page, 'bots.get', { id })) as {
        bot: { profile: { runtime: { plugin_ids: string[] } } };
      };
      expect(bot.bot.profile.runtime.plugin_ids).toContain(CONFIG_PLUGIN_ID);
    }

    // 第二次安装仍弹（还没勾不再提醒）；这次勾上「以后不再提醒」再完成。
    await installViaUi(page, dialog, second);
    await expect(hint).toBeVisible({ timeout: 15_000 });
    await hint.locator('[data-testid="plugins-install-hint-dismiss"]').click();
    await hint.locator('[data-testid="plugins-install-hint-done"]').click();
    await expect(hint).toBeHidden({ timeout: 15_000 });
    const dismissed = await page.evaluate(() =>
      localStorage.getItem('kepcup.plugins.installHint.dismissed'),
    );
    expect(dismissed).toBe('1');

    // 第三个插件（同 id 重装走更新流不弹；换一个全新 id 验证「不再弹」）。
    const third = await makePlainFixture(
      path.join(home, 'fx-hint-3'),
      'io.github.tester/third',
      '引导三',
    );
    await installViaUi(page, dialog, third);
    await expect(hint).toHaveCount(0);
    const card = dialog.locator('[data-testid="plugins-card-io.github.tester/third"]');
    await expect(card).toBeVisible({ timeout: 30_000 });
  } finally {
    await app?.close();
    await llm.stop();
    await rmHomeTolerant(home);
  }
});

test('plugins-manage: two tabs and the system cards at the end of the installed grid', async () => {
  test.setTimeout(240_000);
  const llm = await startMockLlm();
  const home = await mkdtemp(path.join(tmpdir(), 'kepcup-e2e-plugins-system-'));
  let app: ElectronApplication | null = null;
  try {
    const launched = await launch(home, llm.url);
    app = launched.app;
    const page = launched.page;
    const dialog = await openInstalledTab(page);

    // 系统卡在网格末尾：badge「系统」、无插件 ⋮ 菜单；展开出内容。
    const collab = dialog.locator('[data-testid="extension-system-card-local-collab"]');
    const connectors = dialog.locator('[data-testid="extension-system-card-local-connectors"]');
    await expect(collab).toBeVisible();
    await expect(connectors).toBeVisible();
    await expect(collab.locator('[data-testid^="plugins-menu-"]')).toHaveCount(0);
    await expect(connectors.locator('[data-testid^="plugins-menu-"]')).toHaveCount(0);
    await collab.locator('[data-testid="extension-system-card-local-collab-toggle"]').click();
    await expect(collab.locator('[data-testid="local-collab-inkcop-card"]')).toBeVisible();
    await connectors.locator('[data-testid="extension-system-card-local-connectors-toggle"]').click();
    await expect(
      connectors.locator('[data-testid="local-connectors-section"]'),
    ).toBeVisible();

    // 旧 localCollab 页签不复存在（深链由 shell 落到 installed + 系统卡，单测覆盖映射）。
    await expect(dialog.locator('[data-testid="extension-center-tab-localCollab"]')).toHaveCount(0);
  } finally {
    await app?.close();
    await llm.stop();
    await rmHomeTolerant(home);
  }
});
