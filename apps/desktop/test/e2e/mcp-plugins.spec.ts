import { mkdtemp } from 'node:fs/promises';
import { rmHomeTolerant } from './helpers/home-cleanup';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page, _electron } from '@playwright/test';
import { buildPluginFixture, startMockLlm } from '@kepcup/testkit';
import { rpc } from './helpers/create-bot';

/**
 * mcp 实例化 e2e（P4-M2，todo/plugin-platform P4-extension-center.md §4 实施注）——
 * 覆盖厂商模版主旅程：
 * - 安装厂商形态的 mcp 插件（锁定端点 + Authorization 头模板）→ 插件卡「管理 · 工具」
 *   → 实例表单只有 备注名 / token（锁定端点不可见不可改）；
 * - 创建成功后实例列表出现该服务（按插件分组），`settings.mcpServers` 落一条
 *   instance 来源 server（headers 只含 `secret:header:` 占位）；
 * - 编辑实例（令牌轮换路径）：非敏感回显、敏感「已设置」占位；
 * - 卸载插件 → 实例与 server 级联清除。
 *
 * 不在本 spec（黑盒无服务缝，由更底层测试补位）：secrets 明文落点与令牌轮换的
 * core 断言（`plugins-instances.test.ts`）、注入口径（`plugins-injection.test.ts`）、
 * 通用模版（`url:''`）形态（同文件第二组用例的 core 版本）。
 *
 * 实例创建不发起新网络请求（只登记 settings），无需假服务器；真实 MCP 端点指向
 * 一个不可达的 https 域名即可（懒连接，不点工具就不会碰网络）。
 */

test.skip(process.platform === 'win32', 'mcp e2e fixtures are POSIX-only');

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
    },
  });
  const page = await app.firstWindow();
  await waitReady(page);
  return { app, page };
}

/** 厂商形态的 mcp 模版插件（端点锁定；token 是唯一的敏感实例字段）。 */
async function vendorMcpFixture() {
  return buildPluginFixture({
    dir: await mkdtemp(path.join(tmpdir(), 'kepcup-e2e-mcp-fx-')),
    manifest: {
      id: 'io.github.tester/mcp-vendor',
      name: 'Vendor Docs',
      instances: ['mcp'],
      contributions: {
        skills: [],
        connectors: [],
        mcp: [
          {
            kind: 'http',
            id: 'docs',
            name: 'Vendor Docs',
            url: 'https://docs.example.com/openapi/mcp',
            auth: 'headers',
            headers: [{ name: 'Authorization', key: 'token' }],
          },
        ],
        mail: [],
        im: [],
      },
    },
  });
}

async function openInstalledMcpFilter(page: Page): Promise<void> {
  await page.locator('[data-testid="extension-center-button"]').click();
  const dialog = page.locator('[data-testid="settings-page"]');
  await expect(dialog).toBeVisible();
  await dialog.locator('[data-testid="extension-center-tab-installed"]').click();
  await expect(page.locator('[data-testid="extension-installed"]')).toBeVisible();
  await page.locator('[data-testid="plugins-filter-mcp"]').click();
}

test('mcp plugin: card-managed instances, locked endpoint, header token, cascade uninstall', async () => {
  test.setTimeout(240_000);
  const llm = await startMockLlm();
  const home = await mkdtemp(path.join(tmpdir(), 'kepcup-e2e-mcp-'));
  let app: ElectronApplication | null = null;
  try {
    app = (await launch(home, llm.url)).app;
    const page = await app.firstWindow();

    const fixture = await vendorMcpFixture();
    await rpc(page, 'plugins.install', {
      source: { kind: 'file', path: fixture.path },
      sha256: fixture.sha256,
      userConfig: {},
    });

    await openInstalledMcpFilter(page);

    // 插件卡出现且带「管理 · 工具」入口（纯模版插件 counts.mcp = 0，管理入口由
    // providesInstances 提供）。
    const card = page.locator('[data-testid="plugins-card-io.github.tester/mcp-vendor"]');
    await expect(card).toBeVisible();

    // 管理视图：ExtensionMcpInstances（实例列表，instance 插件不走 McpSection）。
    await page
      .locator('[data-testid="plugins-manage-mcp-io.github.tester/mcp-vendor"]')
      .click();
    await expect(page.locator('[data-testid="plugins-content-mcp"]')).toBeVisible();
    await expect(page.locator('[data-testid="extension-mcp-instances"]')).toBeVisible();

    // 添加实例：表单只有 备注名 / token——锁定端点不可见。
    await page.locator('[data-testid="mcp-add"]').click();
    await expect(page.locator('[data-testid="mcp-add-form"]')).toBeVisible();
    const fields = page.locator('[data-testid="mcp-instance-fields"]');
    await expect(fields).toBeVisible();
    await expect(fields.locator('input')).toHaveCount(2);
    await expect(fields.locator('[data-testid="mcp-instance-field-url"]')).toHaveCount(0);
    await page.locator('[data-testid="mcp-instance-field-label"]').fill('我的文档');
    await page.locator('[data-testid="mcp-instance-field-token"]').fill('Bearer abc');
    await page.locator('[data-testid="mcp-save"]').click();

    // 创建成功：分组列表出现该实例；settings 落一条 instance 来源 server
    // （headers 只含占位符，明文永不进 settings）。
    await expect(
      page.locator('[data-testid="mcp-group-io.github.tester/mcp-vendor"]'),
    ).toBeVisible({ timeout: 30_000 });
    const listed = (await rpc(page, 'plugins.instances.list', {
      pluginId: 'io.github.tester/mcp-vendor',
    })) as { instances: Array<Record<string, unknown>> };
    expect(listed.instances).toHaveLength(1);
    expect(listed.instances[0]).toMatchObject({
      kind: 'mcp',
      title: '我的文档',
      pluginId: 'io.github.tester/mcp-vendor',
    });
    const settings = (await rpc(page, 'settings.get', undefined)) as {
      mcpServers: Array<Record<string, unknown>>;
    };
    expect(settings.mcpServers).toHaveLength(1);
    const server = settings.mcpServers[0]!;
    expect(server).toMatchObject({
      transport: 'http',
      url: 'https://docs.example.com/openapi/mcp',
      auth: 'headers',
      autoApprove: false,
      tier: 'developer',
    });
    expect(server.headers).toEqual({ Authorization: 'secret:header:Authorization' });
    expect(server.source).toMatchObject({
      kind: 'instance',
      pluginId: 'io.github.tester/mcp-vendor',
    });

    // 编辑：非敏感回显、敏感字段「已保存」占位（保存保留存值）；改动必须真实落库
    // （更新 label 并断言 instances 返回新值——否则 update 被拒时测试会空转通过）。
    await page.locator('[data-testid^="mcp-instance-pli_"]').first().click();
    await expect(page.locator('[data-testid="mcp-edit-form"]')).toBeVisible();
    await expect(page.locator('[data-testid="mcp-instance-field-label"]')).toHaveValue('我的文档');
    const tokenInput = page.locator('[data-testid="mcp-instance-field-token"]');
    await expect(tokenInput).toHaveAttribute('placeholder', /已保存/);
    await tokenInput.fill('Bearer def');
    await page.locator('[data-testid="mcp-instance-field-label"]').fill('我的文档2');
    await page.locator('[data-testid="mcp-save"]').click();
    await expect(page.locator('[data-testid="mcp-edit-form"]')).toHaveCount(0, {
      timeout: 30_000,
    });
    await expect
      .poll(
        async () =>
          (
            (await rpc(page, 'plugins.instances.list', {
              pluginId: 'io.github.tester/mcp-vendor',
            })) as { instances: Array<{ values: Record<string, unknown> }> }
          ).instances[0]!.values.label,
        { timeout: 30_000 },
      )
      .toBe('我的文档2');
    const afterUpdate = (await rpc(page, 'settings.get', undefined)) as {
      mcpServers: Array<Record<string, unknown>>;
    };
    expect(afterUpdate.mcpServers).toHaveLength(1);

    // 卸载插件 → 实例与 server 级联清除。
    await rpc(page, 'plugins.uninstall', { id: 'io.github.tester/mcp-vendor' });
    await expect
      .poll(
        async () =>
          ((await rpc(page, 'settings.get', undefined)) as { mcpServers: unknown[] })
            .mcpServers.length,
        { timeout: 30_000 },
      )
      .toBe(0);
  } finally {
    await llm.stop();
    if (app !== null) await app.close();
    await rmHomeTolerant(home);
  }
});
