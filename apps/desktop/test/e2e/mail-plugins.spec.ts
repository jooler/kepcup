import { mkdtemp, rm } from 'node:fs/promises';
import { rmHomeTolerant } from './helpers/home-cleanup';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page, _electron } from '@playwright/test';
import { FakeImapServer, FakeSmtpServer, buildPluginFixture, startMockLlm } from '@kepcup/testkit';
import { createBotAndOpenChat, rpc } from './helpers/create-bot';

/**
 * 邮件插件化 e2e（D105 P3，P3-mail.md §4.6）——覆盖卡片管理主旅程：
 * - 安装厂商形态的邮件插件（锁定端点）→ 插件卡「管理 · 邮件」→ 实例表单只有
 *   地址 / 授权码（/ 用户名），主机不可见不可改；
 * - 创建成功后管理视图出现该账号（按插件分组）；
 * - 同一插件添加第二个账号成功；
 * - 卸载插件 → 两个账号（与绑定）级联清除。
 * - 数据归属圈定（2026-11-14）：多个邮件插件并存时，每个插件卡的管理视图
 *   只列自己的账号（B 的视图看不到 A 的账号，反之亦然），卸载级联也不跨插件；
 *   Bot 档案插件卡内的邮箱勾选列表（BotMailBindings）同样按数据归属圈定，
 *   且勾选绑定照常生效。
 *
 * 不在本 spec（黑盒无服务缝，由更底层测试补位，见 P3-mail.md §6 遗留④）：
 * 遗留无主账号的 UI 旅程（core `mail-service-fixes.test.ts` 服务层回归）、
 * 「Bot 启用插件 → 会话内邮件工具可用」（core `capability-mounting-p2.test.ts`）。
 *
 * 建号走真实连接测试：FakeImapServer / FakeSmtpServer 起在本机环回，
 * 测试构建 + KEPCUP_MAIL_ALLOW_PRIVATE=1 放行（core hosts.ts 的既有测试缝）。
 */

test.skip(process.platform === 'win32', 'mail e2e fixtures are POSIX-only');

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
  const { mkdir } = await import('node:fs/promises');
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
      KEPCUP_MAIL_ALLOW_PRIVATE: '1',
    },
  });
  const page = await app.firstWindow();
  await waitReady(page);
  return { app, page };
}

/** 厂商形态的邮件插件（端点锁定到本机假服务器；id / 名称可换以便多插件并存）。 */
async function vendorMailFixture(
  imap: FakeImapServer,
  smtp: FakeSmtpServer,
  id = 'io.github.tester/mail-vendor',
  name = 'Vendor Mail',
) {
  return buildPluginFixture({
    dir: await mkdtemp(path.join(tmpdir(), 'kepcup-e2e-mail-fx-')),
    manifest: {
      id,
      name,
      instances: ['mail'],
      contributions: {
        skills: [],
        connectors: [],
        mcp: [],
        mail: [
          {
            id: 'vendor',
            label: name,
            imap: { host: '127.0.0.1', port: imap.port, secure: 'ssl' },
            smtp: { host: '127.0.0.1', port: smtp.port, secure: 'ssl' },
            defaultMode: 'auto',
            defaultPollSec: 300,
            minPollSec: 60,
          },
        ],
      },
    },
  });
}

async function openInstalledMailFilter(page: Page): Promise<void> {
  await page.locator('[data-testid="extension-center-button"]').click();
  const dialog = page.locator('[data-testid="settings-page"]');
  await expect(dialog).toBeVisible();
  await dialog.locator('[data-testid="extension-center-tab-installed"]').click();
  await expect(page.locator('[data-testid="extension-installed"]')).toBeVisible();
  await page.locator('[data-testid="plugins-filter-mail"]').click();
}

/** 在当前打开的插件管理视图里添加一颗账号（厂商形态表单：地址 + 授权码，用户名选填）。 */
async function addAccount(page: Page, address: string): Promise<void> {
  await page.locator('[data-testid="mail-add"]').click();
  await expect(page.locator('[data-testid="mail-add-form"]')).toBeVisible();
  await page.locator('[data-testid="mail-instance-field-address"]').fill(address);
  await page.locator('[data-testid="mail-instance-field-password"]').fill('authcode');
  await page.locator('[data-testid="mail-save"]').click();
}

test('mail plugin: card-managed accounts, locked endpoints, cascade uninstall, legacy rows', async () => {
  test.setTimeout(240_000);
  const llm = await startMockLlm();
  const home = await mkdtemp(path.join(tmpdir(), 'kepcup-e2e-mail-'));
  const imap = new FakeImapServer({ advertiseIdle: false });
  const smtp = new FakeSmtpServer();
  await imap.start();
  await smtp.start();
  let app: ElectronApplication | null = null;
  try {
    app = (await launch(home, llm.url)).app;
    const page = await app.firstWindow();

    const fixture = await vendorMailFixture(imap, smtp);
    await rpc(page, 'plugins.install', {
      source: { kind: 'file', path: fixture.path },
      sha256: fixture.sha256,
      userConfig: {},
    });

    await openInstalledMailFilter(page);

    // 插件卡出现且带「管理 · 邮件」入口。
    const card = page.locator('[data-testid="plugins-card-io.github.tester/mail-vendor"]');
    await expect(card).toBeVisible();

    // 管理视图：ExtensionMail（实例聚合视图）。
    await page
      .locator('[data-testid="plugins-manage-mail-io.github.tester/mail-vendor"]')
      .click();
    await expect(page.locator('[data-testid="plugins-content-mail"]')).toBeVisible();

    // 添加第一颗账号：实例表单只有地址 / 授权码（/ 用户名）——端点不可见。
    await page.locator('[data-testid="mail-add"]').click();
    await expect(page.locator('[data-testid="mail-add-form"]')).toBeVisible();
    const fields = page.locator('[data-testid="mail-instance-fields"]');
    await expect(fields).toBeVisible();
    await expect(fields.locator('input')).toHaveCount(3);
    for (const key of ['imapHost', 'smtpHost', 'imapPort', 'smtpPort']) {
      await expect(fields.locator(`[data-testid="mail-instance-field-${key}"]`)).toHaveCount(0);
    }
    await page
      .locator('[data-testid="mail-instance-field-address"]')
      .fill('bot@example.com');
    await page.locator('[data-testid="mail-instance-field-password"]').fill('authcode');
    await page.locator('[data-testid="mail-save"]').click();

    // 创建成功：分组视图出现该账号（按插件分组）。
    await expect(page.locator('[data-testid="mail-group-io.github.tester/mail-vendor"]')).toBeVisible({
      timeout: 30_000,
    });
    const accounts = (await rpc(page, 'mail.accounts.list', undefined)) as {
      accounts: Array<Record<string, unknown>>;
    };
    expect(accounts.accounts).toHaveLength(1);
    expect(accounts.accounts[0]).toMatchObject({
      address: 'bot@example.com',
      provider: 'custom',
      pluginId: 'io.github.tester/mail-vendor',
      imapHost: '127.0.0.1',
      smtpHost: '127.0.0.1',
    });

    // 同一插件添加第二颗账号成功。
    await page.locator('[data-testid="mail-add"]').click();
    await page.locator('[data-testid="mail-instance-field-address"]').fill('other@example.com');
    await page.locator('[data-testid="mail-instance-field-password"]').fill('authcode');
    await page.locator('[data-testid="mail-save"]').click();
    await expect
      .poll(async () => ((await rpc(page, 'mail.accounts.list', undefined)) as { accounts: unknown[] }).accounts.length, {
        timeout: 30_000,
      })
      .toBe(2);

    // 卸载插件 → 两个账号级联清除。
    await rpc(page, 'plugins.uninstall', { id: 'io.github.tester/mail-vendor' });
    await expect
      .poll(async () => ((await rpc(page, 'mail.accounts.list', undefined)) as { accounts: unknown[] }).accounts.length, {
        timeout: 30_000,
      })
      .toBe(0);

    // 遗留无主账号：直接经服务缝播种（无 instance_id），列表标「未关联插件」、可删除。
    // e2e 黑盒没有服务缝：用一个本地通用邮件插件建一颗账号、再卸载插件之外的路径不可行；
    // 这里的遗留行语义由 core 集成测试覆盖（mail-service-fixes / plugins.test），
    // 本 spec 只覆盖插件化旅程。
  } finally {
    await imap.stop();
    await smtp.stop();
    await llm.stop();
    if (app !== null) await app.close();
    await rmHomeTolerant(home);
  }
});

test('mail plugin: manage views are scoped to the owning plugin (no cross-plugin leak)', async () => {
  test.setTimeout(240_000);
  const llm = await startMockLlm();
  const home = await mkdtemp(path.join(tmpdir(), 'kepcup-e2e-mail-scope-'));
  const imap = new FakeImapServer({ advertiseIdle: false });
  const smtp = new FakeSmtpServer();
  await imap.start();
  await smtp.start();
  let app: ElectronApplication | null = null;
  try {
    app = (await launch(home, llm.url)).app;
    const page = await app.firstWindow();

    // 两个厂商形态的邮件插件并存（端点都锁到同一对本机假服务器）。
    const fixtureA = await vendorMailFixture(imap, smtp);
    await rpc(page, 'plugins.install', {
      source: { kind: 'file', path: fixtureA.path },
      sha256: fixtureA.sha256,
      userConfig: {},
    });
    await rm(fixtureA.path, { recursive: true, force: true });
    const fixtureB = await vendorMailFixture(
      imap,
      smtp,
      'io.github.tester/mail-vendor-b',
      'Vendor Mail B',
    );
    await rpc(page, 'plugins.install', {
      source: { kind: 'file', path: fixtureB.path },
      sha256: fixtureB.sha256,
      userConfig: {},
    });
    await rm(fixtureB.path, { recursive: true, force: true });

    await openInstalledMailFilter(page);

    // A 卡管理：添加账号 X，落在 A 的分组下。
    await page.locator('[data-testid="plugins-card-io.github.tester/mail-vendor"]').waitFor();
    await page
      .locator('[data-testid="plugins-manage-mail-io.github.tester/mail-vendor"]')
      .click();
    await expect(page.locator('[data-testid="plugins-content-mail"]')).toBeVisible();
    await addAccount(page, 'bot@example.com');
    await expect(
      page.locator('[data-testid="mail-group-io.github.tester/mail-vendor"]'),
    ).toBeVisible({ timeout: 30_000 });

    // B 卡管理：空态——A 的账号不出现在 B 的视图里（数据归属圈定）。
    // mail-empty 在挂载时（数据未到）必然先渲染，补一条账号行恒 0 的重试断言兜住时序。
    await page.locator('[data-testid="plugins-content-back"]').click();
    await page.locator('[data-testid="plugins-card-io.github.tester/mail-vendor-b"]').waitFor();
    await page
      .locator('[data-testid="plugins-manage-mail-io.github.tester/mail-vendor-b"]')
      .click();
    await expect(page.locator('[data-testid="plugins-content-mail"]')).toBeVisible();
    await expect(page.locator('[data-testid="mail-empty"]')).toBeVisible();
    await expect(
      page.locator('[data-testid="extension-mail"] [data-testid^="mail-account-"]'),
    ).toHaveCount(0);
    await expect(page.locator('[data-testid="extension-mail"]')).not.toContainText(
      'bot@example.com',
      { timeout: 15_000 },
    );

    // B 里添加账号 Y：只进 B 的分组。
    await addAccount(page, 'other-b@example.com');
    await expect(
      page.locator('[data-testid="mail-group-io.github.tester/mail-vendor-b"]'),
    ).toBeVisible({ timeout: 30_000 });

    // 回到 A：只看到 X，看不到 Y（分组互不串台）。
    await page.locator('[data-testid="plugins-content-back"]').click();
    await page
      .locator('[data-testid="plugins-manage-mail-io.github.tester/mail-vendor"]')
      .click();
    await expect(page.locator('[data-testid="extension-mail"]')).toContainText('bot@example.com', {
      timeout: 15_000,
    });
    await expect(page.locator('[data-testid="extension-mail"]')).not.toContainText(
      'other-b@example.com',
      { timeout: 15_000 },
    );
    await expect(
      page.locator('[data-testid="mail-group-io.github.tester/mail-vendor-b"]'),
    ).toHaveCount(0);

    // 卸载 A → 只级联 A 的账号，B 的账号保留；卸载 B → 清空。
    await rpc(page, 'plugins.uninstall', { id: 'io.github.tester/mail-vendor' });
    await expect
      .poll(
        async () =>
          ((await rpc(page, 'mail.accounts.list', undefined)) as { accounts: unknown[] }).accounts
            .length,
        { timeout: 30_000 },
      )
      .toBe(1);
    const rest = (await rpc(page, 'mail.accounts.list', undefined)) as {
      accounts: Array<Record<string, unknown>>;
    };
    expect(rest.accounts[0]).toMatchObject({
      address: 'other-b@example.com',
      pluginId: 'io.github.tester/mail-vendor-b',
    });
    await rpc(page, 'plugins.uninstall', { id: 'io.github.tester/mail-vendor-b' });
    await expect
      .poll(
        async () =>
          ((await rpc(page, 'mail.accounts.list', undefined)) as { accounts: unknown[] }).accounts
            .length,
        { timeout: 30_000 },
      )
      .toBe(0);
  } finally {
    await imap.stop();
    await smtp.stop();
    await llm.stop();
    if (app !== null) await app.close();
    await rmHomeTolerant(home);
  }
});

test('mail plugin: bot panel plugin cards scope mail bindings to the owning plugin', async () => {
  test.setTimeout(240_000);
  const llm = await startMockLlm();
  const home = await mkdtemp(path.join(tmpdir(), 'kepcup-e2e-mail-bot-'));
  const imap = new FakeImapServer({ advertiseIdle: false });
  const smtp = new FakeSmtpServer();
  await imap.start();
  await smtp.start();
  let app: ElectronApplication | null = null;
  try {
    app = (await launch(home, llm.url)).app;
    const page = await app.firstWindow();

    // 两个邮件插件各建一颗账号（沿用上一用例的圈定前提）。
    const fixtureA = await vendorMailFixture(imap, smtp);
    await rpc(page, 'plugins.install', {
      source: { kind: 'file', path: fixtureA.path },
      sha256: fixtureA.sha256,
      userConfig: {},
    });
    await rm(fixtureA.path, { recursive: true, force: true });
    const fixtureB = await vendorMailFixture(
      imap,
      smtp,
      'io.github.tester/mail-vendor-b',
      'Vendor Mail B',
    );
    await rpc(page, 'plugins.install', {
      source: { kind: 'file', path: fixtureB.path },
      sha256: fixtureB.sha256,
      userConfig: {},
    });
    await rm(fixtureB.path, { recursive: true, force: true });
    await openInstalledMailFilter(page);
    await page.locator('[data-testid="plugins-card-io.github.tester/mail-vendor"]').waitFor();
    await page
      .locator('[data-testid="plugins-manage-mail-io.github.tester/mail-vendor"]')
      .click();
    await addAccount(page, 'bot@example.com');
    await expect(
      page.locator('[data-testid="mail-group-io.github.tester/mail-vendor"]'),
    ).toBeVisible({ timeout: 30_000 });
    await page.locator('[data-testid="plugins-content-back"]').click();
    await page
      .locator('[data-testid="plugins-manage-mail-io.github.tester/mail-vendor-b"]')
      .click();
    await expect(page.locator('[data-testid="plugins-content-mail"]')).toBeVisible();
    await addAccount(page, 'other-b@example.com');
    await expect(
      page.locator('[data-testid="mail-group-io.github.tester/mail-vendor-b"]'),
    ).toBeVisible({ timeout: 30_000 });
    const listed = (await rpc(page, 'mail.accounts.list', undefined)) as {
      accounts: Array<Record<string, unknown>>;
    };
    const idOf = (address: string): string =>
      listed.accounts.find((account) => account.address === address)!.id as string;

    // 建 Bot 并把两个邮件插件都加进来：先 Esc 收起扩展中心（设置页整页视图），
    // 否则侧栏被盖住，建号 helper 点不到会话。
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="settings-page"]')).toBeHidden({ timeout: 15_000 });
    const bot = await createBotAndOpenChat(page, '邮箱甲');
    if (!(await page.locator('[data-testid="right-panel"]').isVisible())) {
      await page.locator('[data-testid="right-panel-toggle"]').click();
    }
    const back = page.locator('[data-testid="bot-detail-back"]');
    if (await back.isVisible()) await back.click();
    await page.locator('[data-testid="bot-config-row-plugins"]').click();
    const section = page.locator('[data-testid="bot-plugins"]');
    await expect(section).toBeVisible({ timeout: 15_000 });
    await section.locator('[data-testid="bot-plugins-add"]').click();
    const dialog = page.locator('[data-testid="bot-plugins-add-dialog"]');
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    for (const id of ['io.github.tester/mail-vendor', 'io.github.tester/mail-vendor-b']) {
      await dialog.locator('[data-testid="bot-plugins-add-search"]').fill(id);
      const addButton = dialog.locator(`[data-testid="bot-plugins-add-to-bot-${id}"]`);
      await addButton.click();
      await expect(addButton).toContainText('已添加给该 Bot', { timeout: 15_000 });
    }
    await dialog.locator('[data-testid="bot-plugins-add-done"]').click();

    // 展开两卡：A 卡只列 X，B 卡只列 Y（勾选列表按数据归属圈定）。
    const rowA = section.locator('[data-testid="bot-plugins-io.github.tester/mail-vendor"]');
    await expect(rowA).toBeVisible({ timeout: 15_000 });
    await rowA.locator('[data-testid="bot-plugins-expand-io.github.tester/mail-vendor"]').click();
    const mailA = rowA.locator('[data-testid="bot-mail"]');
    await expect(mailA).toContainText('bot@example.com', { timeout: 15_000 });
    await expect(mailA).not.toContainText('other-b@example.com', { timeout: 15_000 });
    const rowB = section.locator('[data-testid="bot-plugins-io.github.tester/mail-vendor-b"]');
    await rowB.locator('[data-testid="bot-plugins-expand-io.github.tester/mail-vendor-b"]').click();
    const mailB = rowB.locator('[data-testid="bot-mail"]');
    await expect(mailB).toContainText('other-b@example.com', { timeout: 15_000 });
    await expect(mailB).not.toContainText('bot@example.com', { timeout: 15_000 });

    // 勾选绑定照常生效：按地址断言每颗账号的绑定恰为本 Bot（不锁长度，锁归属与唯一性）。
    await mailA.locator(`[data-testid="bot-mail-${idOf('bot@example.com')}"]`).check();
    await mailB.locator(`[data-testid="bot-mail-${idOf('other-b@example.com')}"]`).check();
    await expect
      .poll(async () => {
        const result = (await rpc(page, 'mail.accounts.list', undefined)) as {
          accounts: Array<{ address: string; botIds: string[] }>;
        };
        return result.accounts
          .map((account) => ({ address: account.address, botIds: account.botIds }))
          .sort((a, b) => a.address.localeCompare(b.address));
      }, { timeout: 30_000 })
      .toEqual([
        { address: 'bot@example.com', botIds: [bot.botId] },
        { address: 'other-b@example.com', botIds: [bot.botId] },
      ]);
  } finally {
    await imap.stop();
    await smtp.stop();
    await llm.stop();
    if (app !== null) await app.close();
    await rmHomeTolerant(home);
  }
});
