import { mkdtemp } from 'node:fs/promises';
import { rmHomeTolerant } from './helpers/home-cleanup';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page, _electron } from '@playwright/test';
import { FakeImapServer, FakeSmtpServer, buildPluginFixture, startMockLlm } from '@kepcup/testkit';
import { rpc } from './helpers/create-bot';

/**
 * 邮件插件化 e2e（D105 P3，P3-mail.md §4.6）：
 * - 安装厂商形态的邮件插件（锁定端点）→ 插件卡「管理 · 邮件」→ 实例表单只有
 *   地址 / 授权码（/ 用户名），主机不可见不可改；
 * - 创建成功后全局邮件视图出现该账号（按插件分组）；
 * - 同一插件添加第二个账号成功；
 * - 卸载插件 → 两个账号（与绑定）级联清除；
 * - 遗留无主账号（先建后装插件）仍显示、可删除，标「未关联插件」。
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

/** 厂商形态的邮件插件（端点锁定到本机假服务器）。 */
async function vendorMailFixture(imap: FakeImapServer, smtp: FakeSmtpServer) {
  return buildPluginFixture({
    dir: await mkdtemp(path.join(tmpdir(), 'kepcup-e2e-mail-fx-')),
    manifest: {
      id: 'io.github.tester/mail-vendor',
      name: 'Vendor Mail',
      instances: ['mail'],
      contributions: {
        skills: [],
        connectors: [],
        mcp: [],
        mail: [
          {
            id: 'vendor',
            label: 'Vendor Mail',
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
  const dialog = page.locator('[data-testid="extension-center-dialog"]');
  await expect(dialog).toBeVisible();
  await dialog.locator('[data-testid="extension-center-tab-installed"]').click();
  await expect(page.locator('[data-testid="extension-installed"]')).toBeVisible();
  await page.locator('[data-testid="plugins-filter-mail"]').click();
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
