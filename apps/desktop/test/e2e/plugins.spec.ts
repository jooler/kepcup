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
import {
  createBotAndOpenChat,
  dismissStartPanel,
  openConversationByName,
} from './helpers/create-bot';
import { rmHomeTolerant } from './helpers/home-cleanup';

/**
 * 插件系统「已安装」页签 e2e（D104 P0a-3）：
 * - 页签顺序（market 最前、方向键循环回它）与默认选中不变（skills）；
 * - 本地安装全流程（路径输入框 → 检视 → 同意面板 → 确认安装）；
 * - 技能 / MCP / 连接三处来源徽标与管理项锁定；core 层 PLUGIN_MANAGED 守卫；
 * - 启停 / 卸载的投影摘除与恢复；同 id 重装的冲突阻塞；窄屏页签条。
 *
 * 界面里打不开原生文件对话框，安装全程用路径输入框。夹具不含 mcpb（e2e 环境没有
 * 受管 Node 运行时）：2 个技能 + 1 个连接器 + 1 个 http MCP。
 */

const PLUGIN_ID = 'io.github.tester/fixture';
const SKILL_A = 'plg-alpha';
const SKILL_B = 'plg-beta';
const CONNECTOR_SLUG = 'plgconn';
const HTTP_KEY = 'docs';

type Rpc = (method: string, input?: unknown) => Promise<unknown>;

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
): Promise<{
  app: ElectronApplication;
  page: Page;
}> {
  // D104 P0b：本规格只管本地插件的生命周期，把内置插件指向空目录，
  // 「plugins-empty」空态断言不随随包内置插件（starter-skills / connections）出现而改变。
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

async function makeFixture(
  options: { id?: string; version?: string; skillADescription?: string } = {},
): Promise<{ path: string; sha256: string }> {
  const built = await buildPluginFixture({
    dir: await mkdtemp(path.join(tmpdir(), 'kepcup-e2e-plugin-fx-')),
    manifest: {
      ...(options.id !== undefined ? { id: options.id } : {}),
      ...(options.version !== undefined ? { version: options.version } : {}),
    },
    skills: [
      { name: SKILL_A, description: options.skillADescription ?? '插件技能 A' },
      { name: SKILL_B },
    ],
    connectors: [{ slug: CONNECTOR_SLUG }],
    http: [{ id: HTTP_KEY, url: 'https://mcp.docs.test/mcp' }],
  });
  return { path: built.path, sha256: built.sha256 };
}

/** 经测试缝安装夹具（sha256 与 inspect 一致，等价 UI 全流程的落库结果）。 */
async function installViaRpc(page: Page, fixture: { path: string; sha256: string }): Promise<void> {
  await page.evaluate(
    ([method, input]) => {
      const rpc = (window as unknown as { __kepcupRpc: Rpc }).__kepcupRpc;
      return rpc(method, input);
    },
    [
      'plugins.install',
      { source: { kind: 'file', path: fixture.path }, sha256: fixture.sha256, userConfig: {} },
    ] as const,
  );
}

async function openExtensionCenter(page: Page): Promise<Locator> {
  const dialog = page.locator('[data-testid="extension-center-dialog"]');
  await page.locator('[data-testid="extension-center-button"]').click();
  await expect(dialog).toBeVisible();
  return dialog;
}

async function openInstalledTab(page: Page): Promise<Locator> {
  const dialog = await openExtensionCenter(page);
  await dialog.locator('[data-testid="extension-center-tab-installed"]').click();
  await expect(dialog.locator('[data-testid="extension-installed"]')).toBeVisible();
  return dialog;
}

async function openSkillsPanel(page: Page): Promise<Page> {
  if (!(await page.locator('[data-testid="right-panel"]').isVisible())) {
    await page.locator('[data-testid="right-panel-toggle"]').click();
  }
  // 统一二级菜单：已在某个详情里先点返回回菜单（幂等，可重复调用）。
  const back = page.locator('[data-testid="bot-detail-back"]');
  if (await back.isVisible()) await back.click();
  await page.locator('[data-testid="bot-menu-row-skills"]').click();
  await expect(page.locator('[data-testid="skills-tab"]')).toBeVisible();
  return page;
}

/** 受管 MCP server 的 id（`plg_` + 哈希前缀）：从 settings 快照里按来源找。 */
async function pluginServerId(page: Page): Promise<string> {
  const settings = (await page.evaluate(() =>
    (window as unknown as { __kepcupRpc: Rpc }).__kepcupRpc('settings.get', undefined),
  )) as { mcpServers: Array<{ id: string; source?: { kind: string } }> };
  const server = settings.mcpServers.find((item) => item.source?.kind === 'plugin');
  expect(server).toBeDefined();
  return server!.id;
}

test('plugins: tab order, default tab and keyboard cycle land on market', async () => {
  test.setTimeout(240_000);
  const llm = await startMockLlm();
  const home = await mkdtemp(path.join(tmpdir(), 'kepcup-e2e-plugins-tabs-'));
  let app: ElectronApplication | null = null;
  try {
    const launched = await launch(home, llm.url);
    app = launched.app;
    const page = launched.page;
    const dialog = await openExtensionCenter(page);

    // 七个页签、market 在最前；默认选中仍是 skills。
    await expect(dialog.locator('[data-testid^="extension-center-tab-"]')).toHaveCount(7);
    await expect(dialog.locator('[data-testid="extension-center-tab-skills"]')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    // 键盘循环从当前选中项起算：先点中 localCollab，再往右循环回第一项（market）。
    await dialog.locator('[data-testid="extension-center-tab-localCollab"]').click();
    await dialog.locator('[data-testid="extension-center-tab-localCollab"]').press('ArrowRight');
    await expect(dialog.locator('[data-testid="extension-center-tab-market"]')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    // installed 仍可点进「已安装」主体（第一项现在是 market，installed 紧随其后）。
    await dialog.locator('[data-testid="extension-center-tab-installed"]').click();
    await expect(dialog.locator('[data-testid="extension-installed"]')).toBeVisible();
    // installed + ArrowLeft → market；connections + Home → market。
    await dialog.locator('[data-testid="extension-center-tab-installed"]').press('ArrowLeft');
    await expect(dialog.locator('[data-testid="extension-center-tab-market"]')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await dialog.locator('[data-testid="extension-center-tab-connections"]').click();
    await dialog.locator('[data-testid="extension-center-tab-connections"]').press('Home');
    await expect(dialog.locator('[data-testid="extension-center-tab-market"]')).toHaveAttribute(
      'aria-selected',
      'true',
    );
  } finally {
    await app?.close();
    await llm.stop();
    await rmHomeTolerant(home);
  }
});

test('plugins: local file install full flow through the path input', async () => {
  test.setTimeout(240_000);
  const llm = await startMockLlm();
  const home = await mkdtemp(path.join(tmpdir(), 'kepcup-e2e-plugins-install-'));
  let app: ElectronApplication | null = null;
  try {
    const launched = await launch(home, llm.url);
    app = launched.app;
    const page = launched.page;
    const fixture = await makeFixture();

    const dialog = await openInstalledTab(page);
    await expect(dialog.locator('[data-testid="plugins-empty"]')).toBeVisible();
    await dialog.locator('[data-testid="plugins-install-file"]').click();

    const installDialog = page.locator('[data-testid="plugins-install-dialog"]');
    await expect(installDialog).toBeVisible();
    await installDialog.locator('[data-testid="plugins-install-path"]').fill(fixture.path);
    await installDialog.locator('[data-testid="plugins-install-inspect"]').click();

    // 同意面板：developer 警示条 + 技能与连接器都在。
    await expect(
      installDialog.locator('[data-testid="plugins-consent-developer-warn"]'),
    ).toBeVisible({ timeout: 30_000 });
    await expect(installDialog).toContainText(SKILL_A);
    await expect(installDialog).toContainText('Fake plgconn');
    await expect(installDialog).toContainText('mcp.docs.test');

    await installDialog.locator('[data-testid="plugins-install-confirm"]').click();
    await expect(installDialog).toBeHidden({ timeout: 30_000 });

    // 卡片出现：developer 分级徽标（未审核）。
    const card = dialog.locator(`[data-testid="plugins-card-${PLUGIN_ID}"]`);
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.locator(`[data-testid="plugins-tier-${PLUGIN_ID}"]`)).toContainText('未审核');
  } finally {
    await app?.close();
    await llm.stop();
    await rmHomeTolerant(home);
  }
});

test('plugins: managed items carry source badges and lose single-item delete entries', async () => {
  test.setTimeout(240_000);
  const llm = await startMockLlm();
  const home = await mkdtemp(path.join(tmpdir(), 'kepcup-e2e-plugins-managed-'));
  let app: ElectronApplication | null = null;
  try {
    const launched = await launch(home, llm.url);
    app = launched.app;
    const page = launched.page;
    const fixture = await makeFixture();
    await createBotAndOpenChat(page, 'Plugin Bot');
    await installViaRpc(page, fixture);
    await page.reload();
    await waitReady(page);
    await openConversationByName(page, 'Plugin Bot');
    await dismissStartPanel(page);

    // Skills（右栏 Bot 技能面板）：插件技能行有来源徽标，卸载按钮换成「由插件管理」。
    const skills = await openSkillsPanel(page);
    const row = skills.locator(`[data-testid="skill-item-${SKILL_A}"]`);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row.locator(`[data-testid="skill-plugin-badge-${SKILL_A}"]`)).toBeVisible();
    await row.click();
    await expect(skills.locator(`[data-testid="skill-uninstall-${SKILL_A}"]`)).toHaveCount(0);
    await expect(skills.locator(`[data-testid="skill-managed-${SKILL_A}"]`)).toBeVisible();
    // 详情里的来源徽标同样存在。
    await expect(
      skills.locator(
        `[data-testid="skill-detail-name"] [data-testid="skill-plugin-badge-${SKILL_A}"]`,
      ),
    ).toBeVisible();

    // MCP：server 行有来源徽标与「由插件管理」，编辑入口不存在（「测试」「工具」保留）。
    const serverId = await pluginServerId(page);
    const dialog = await openExtensionCenter(page);
    await dialog.locator('[data-testid="extension-center-tab-mcp"]').click();
    const serverRow = dialog.locator(`[data-testid="mcp-server-${serverId}"]`);
    await expect(serverRow).toBeVisible({ timeout: 30_000 });
    await expect(serverRow.locator(`[data-testid="mcp-plugin-badge-${serverId}"]`)).toBeVisible();
    await expect(serverRow.locator(`[data-testid="mcp-managed-${serverId}"]`)).toBeVisible();
    await expect(dialog.locator(`[data-testid="mcp-edit-${serverId}"]`)).toHaveCount(0);
    await expect(serverRow.locator(`[data-testid="mcp-tools-toggle-${serverId}"]`)).toBeVisible();

    // 连接页签：连接器卡带插件徽标。
    await dialog.locator('[data-testid="extension-center-tab-connections"]').click();
    const connectorCard = dialog.locator(`[data-testid="apps-catalog-card-${CONNECTOR_SLUG}"]`);
    await expect(connectorCard).toBeVisible({ timeout: 30_000 });
    await expect(
      connectorCard.locator(`[data-testid="apps-catalog-plugin-badge-${CONNECTOR_SLUG}"]`),
    ).toBeVisible();
  } finally {
    await app?.close();
    await llm.stop();
    await rmHomeTolerant(home);
  }
});

test('plugins: core guard rejects single-item removal of managed MCP servers (PLUGIN_MANAGED)', async () => {
  test.setTimeout(240_000);
  const llm = await startMockLlm();
  const home = await mkdtemp(path.join(tmpdir(), 'kepcup-e2e-plugins-guard-'));
  let app: ElectronApplication | null = null;
  try {
    const launched = await launch(home, llm.url);
    app = launched.app;
    const page = launched.page;
    const fixture = await makeFixture();
    await installViaRpc(page, fixture);
    const serverId = await pluginServerId(page);

    const failure = (await page.evaluate(async (id) => {
      try {
        await (window as unknown as { __kepcupRpc: Rpc }).__kepcupRpc('mcp.removeServer', {
          serverId: id,
        });
        return null;
      } catch (caught) {
        const error = caught as { code?: string; message?: string };
        return { code: error.code ?? '', message: error.message ?? String(caught) };
      }
    }, serverId)) as { code: string; message: string } | null;
    expect(failure).not.toBeNull();
    expect(failure!.code).toBe('PLUGIN_MANAGED');
  } finally {
    await app?.close();
    await llm.stop();
    await rmHomeTolerant(home);
  }
});

test('plugins: disable hides projections, re-enable restores them', async () => {
  test.setTimeout(240_000);
  const llm = await startMockLlm();
  const home = await mkdtemp(path.join(tmpdir(), 'kepcup-e2e-plugins-toggle-'));
  let app: ElectronApplication | null = null;
  try {
    const launched = await launch(home, llm.url);
    app = launched.app;
    const page = launched.page;
    const fixture = await makeFixture();
    await createBotAndOpenChat(page, 'Plugin Bot');
    await installViaRpc(page, fixture);
    await page.reload();
    await waitReady(page);
    await openConversationByName(page, 'Plugin Bot');
    await dismissStartPanel(page);

    const dialog = await openInstalledTab(page);
    const card = dialog.locator(`[data-testid="plugins-card-${PLUGIN_ID}"]`);
    await expect(card).toBeVisible({ timeout: 30_000 });
    await card.locator(`[data-testid="plugins-toggle-${PLUGIN_ID}"]`).click();

    // 停用后：技能与连接器摘除。
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden({ timeout: 15_000 });
    const skills = await openSkillsPanel(page);
    await expect(skills.locator(`[data-testid="skill-item-${SKILL_A}"]`)).toHaveCount(0, {
      timeout: 30_000,
    });
    const dialog2 = await openExtensionCenter(page);
    await dialog2.locator('[data-testid="extension-center-tab-connections"]').click();
    await expect(
      dialog2.locator(`[data-testid="apps-catalog-card-${CONNECTOR_SLUG}"]`),
    ).toHaveCount(0, { timeout: 30_000 });

    // 再启用：技能与连接器恢复。
    await dialog2.locator('[data-testid="extension-center-tab-installed"]').click();
    await dialog2.locator(`[data-testid="plugins-toggle-${PLUGIN_ID}"]`).click();
    await expect(
      dialog2.locator(`[data-testid="plugins-card-${PLUGIN_ID}"]`).first(),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog2).toBeHidden({ timeout: 15_000 });
    const skills2 = await openSkillsPanel(page);
    await expect(skills2.locator(`[data-testid="skill-item-${SKILL_A}"]`)).toBeVisible({
      timeout: 30_000,
    });
  } finally {
    await app?.close();
    await llm.stop();
    await rmHomeTolerant(home);
  }
});

test('plugins: uninstall removes the card and every projection', async () => {
  test.setTimeout(240_000);
  const llm = await startMockLlm();
  const home = await mkdtemp(path.join(tmpdir(), 'kepcup-e2e-plugins-uninstall-'));
  let app: ElectronApplication | null = null;
  try {
    const launched = await launch(home, llm.url);
    app = launched.app;
    const page = launched.page;
    const fixture = await makeFixture();
    await createBotAndOpenChat(page, 'Plugin Bot');
    await installViaRpc(page, fixture);
    await page.reload();
    await waitReady(page);
    await openConversationByName(page, 'Plugin Bot');
    await dismissStartPanel(page);

    const dialog = await openInstalledTab(page);
    const card = dialog.locator(`[data-testid="plugins-card-${PLUGIN_ID}"]`);
    await expect(card).toBeVisible({ timeout: 30_000 });
    await card.locator(`[data-testid="plugins-uninstall-${PLUGIN_ID}"]`).click();

    const confirmDialog = page.locator('[data-testid="plugins-uninstall-dialog"]');
    await expect(confirmDialog).toBeVisible();
    await confirmDialog.locator('[data-testid="plugins-uninstall-confirm"]').click();

    await expect(card).toHaveCount(0, { timeout: 30_000 });
    await expect(dialog.locator('[data-testid="plugins-empty"]')).toBeVisible();

    // 三处投影全部摘除：MCP server 行、公共技能、连接器卡。
    const settings = (await page.evaluate(() =>
      (window as unknown as { __kepcupRpc: Rpc }).__kepcupRpc('settings.get', undefined),
    )) as { mcpServers: Array<{ id: string; source?: { kind: string } }> };
    expect(settings.mcpServers.some((item) => item.source?.kind === 'plugin')).toBe(false);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden({ timeout: 15_000 });
    const skills = await openSkillsPanel(page);
    await expect(skills.locator(`[data-testid="skill-item-${SKILL_A}"]`)).toHaveCount(0, {
      timeout: 30_000,
    });
    const dialog2 = await openExtensionCenter(page);
    await dialog2.locator('[data-testid="extension-center-tab-connections"]').click();
    await expect(
      dialog2.locator(`[data-testid="apps-catalog-card-${CONNECTOR_SLUG}"]`),
    ).toHaveCount(0, { timeout: 30_000 });
  } finally {
    await app?.close();
    await llm.stop();
    await rmHomeTolerant(home);
  }
});

test('plugins: a DIFFERENT plugin claiming an installed skill name is a blocked conflict', async () => {
  test.setTimeout(240_000);
  const llm = await startMockLlm();
  const home = await mkdtemp(path.join(tmpdir(), 'kepcup-e2e-plugins-conflict-'));
  let app: ElectronApplication | null = null;
  try {
    const launched = await launch(home, llm.url);
    app = launched.app;
    const page = launched.page;
    // 插件 A 占住 plg-alpha 公共技能。
    const fixtureA = await makeFixture();
    await installViaRpc(page, fixtureA);
    await page.reload();
    await waitReady(page);

    // 另一个 id 的插件 B 也带同名技能 plg-alpha → 真冲突（P1-2 起，同 id 重装不再是冲突）。
    const fixtureB = await buildPluginFixture({
      dir: await mkdtemp(path.join(tmpdir(), 'kepcup-e2e-plugin-fx-')),
      manifest: { id: 'io.github.tester/other' },
      skills: [{ name: SKILL_A, description: '撞名技能' }],
    });
    const dialog = await openInstalledTab(page);
    await dialog.locator('[data-testid="plugins-install-file"]').click();
    const installDialog = page.locator('[data-testid="plugins-install-dialog"]');
    await installDialog.locator('[data-testid="plugins-install-path"]').fill(fixtureB.path);
    await installDialog.locator('[data-testid="plugins-install-inspect"]').click();

    await expect(installDialog.locator('[data-testid="plugins-consent-blockers"]')).toBeVisible({
      timeout: 30_000,
    });
    await expect(installDialog.locator('[data-testid="plugins-install-confirm"]')).toBeDisabled();
  } finally {
    await app?.close();
    await llm.stop();
    await rmHomeTolerant(home);
  }
});

test('plugins: reinstalling the SAME id from a local file is an update, not a conflict', async () => {
  test.setTimeout(240_000);
  const llm = await startMockLlm();
  const home = await mkdtemp(path.join(tmpdir(), 'kepcup-e2e-plugins-update-'));
  let app: ElectronApplication | null = null;
  try {
    const launched = await launch(home, llm.url);
    app = launched.app;
    const page = launched.page;
    const fixtureV1 = await makeFixture({
      version: '1.0.0',
      skillADescription: '插件技能 A 第一版',
    });
    await installViaRpc(page, fixtureV1);
    const { botId } = await createBotAndOpenChat(page, 'Update Bot');
    await page.reload();
    await waitReady(page);
    await openConversationByName(page, 'Update Bot');
    await dismissStartPanel(page);

    // 同 id 同版本、不同内容（技能描述变化）→ 检视 = 中性更新提示，无红色阻塞。
    const fixtureV1b = await makeFixture({
      version: '1.0.0',
      skillADescription: '插件技能 A 第二版',
    });
    const dialog = await openInstalledTab(page);
    await dialog.locator('[data-testid="plugins-install-file"]').click();
    const installDialog = page.locator('[data-testid="plugins-install-dialog"]');
    await installDialog.locator('[data-testid="plugins-install-path"]').fill(fixtureV1b.path);
    await installDialog.locator('[data-testid="plugins-install-inspect"]').click();

    await expect(installDialog.locator('[data-testid="plugins-consent-update-from"]')).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      installDialog.locator('[data-testid="plugins-consent-update-from"]'),
    ).toContainText('v1.0.0');
    await expect(installDialog.locator('[data-testid="plugins-consent-blockers"]')).toHaveCount(0);
    await expect(installDialog.locator('[data-testid="plugins-install-confirm"]')).toBeEnabled();

    await installDialog.locator('[data-testid="plugins-install-confirm"]').click();
    await expect(installDialog).toBeHidden({ timeout: 30_000 });

    // 插件 id 与版本不变，技能内容已换新。
    const list = (await page.evaluate(() =>
      (window as unknown as { __kepcupRpc: Rpc }).__kepcupRpc('plugins.list', undefined),
    )) as { plugins: Array<{ id: string; version: string }> };
    expect(list.plugins).toHaveLength(1);
    expect(list.plugins[0]).toMatchObject({ id: PLUGIN_ID, version: '1.0.0' });
    const settings = (await page.evaluate(() =>
      (window as unknown as { __kepcupRpc: Rpc }).__kepcupRpc('settings.get', undefined),
    )) as { mcpServers: Array<{ id: string; source?: { kind: string } }> };
    expect(settings.mcpServers.some((item) => item.source?.kind === 'plugin')).toBe(true);
    // 技能内容已换新（公共技能对所有 Bot 可见，任一 botId 都能看到新描述）。
    const skills = (await page.evaluate(
      (id) => (window as unknown as { __kepcupRpc: Rpc }).__kepcupRpc('skills.list', { botId: id }),
      botId,
    )) as { skills: Array<{ name: string; description: string }> };
    expect(skills.skills.find((skill) => skill.name === SKILL_A)?.description).toContain(
      '插件技能 A 第二版',
    );
  } finally {
    await app?.close();
    await llm.stop();
    await rmHomeTolerant(home);
  }
});

test('plugins: narrow viewport shows the tabs scrollable with Installed reachable', async () => {
  test.setTimeout(240_000);
  const llm = await startMockLlm();
  const home = await mkdtemp(path.join(tmpdir(), 'kepcup-e2e-plugins-narrow-'));
  let app: ElectronApplication | null = null;
  try {
    const launched = await launch(home, llm.url);
    app = launched.app;
    const page = launched.page;
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(375, 812);
    });
    await expect(page.locator('[data-testid="narrow-shell"]')).toBeVisible({ timeout: 30_000 });
    await page.locator('[data-testid="narrow-tab-extensions"]').click();
    await expect(page.locator('[data-testid="narrow-extensions-page"]')).toBeVisible();
    await expect(page.locator('[data-testid="extension-center-tabs"]')).toBeVisible();
    // 页签条在 375px 下真的横向溢出（overflow-x-auto 生效），而不是挤压或换行。
    const scrollable = await page
      .locator('[data-testid="extension-center-tabs"]')
      .evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(scrollable).toBe(true);
    // installed 可点进「已安装」主体。
    await expect(page.locator('[data-testid="extension-center-tab-installed"]')).toBeVisible();
    await page.locator('[data-testid="extension-center-tab-installed"]').click();
    await expect(page.locator('[data-testid="extension-installed"]')).toBeVisible();
    await expect(page.locator('[data-testid="plugins-install-file"]')).toBeVisible();
  } finally {
    await app?.close();
    await llm.stop();
    await rmHomeTolerant(home);
  }
});
