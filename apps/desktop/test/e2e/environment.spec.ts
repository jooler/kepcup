import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { expect, test, type ElectronApplication, type Page, _electron } from '@playwright/test';
import {
  startFileServer,
  startMockLlm,
  step,
  viaTask,
  type MockLlmServer,
  type TestFileServer,
} from '@kepcup/testkit';

/**
 * P06 e2e (docs/dev/phases/P06-environment.md 测试要求): the environment
 * approval card shows size + source + a progress bar; the settings page
 * lists and removes installs. Downloads run against a LOCAL file server via
 * KEPCUP_ENV_CATALOG_FILE — the pinned catalog is never touched.
 */

const ITEM = 'fakeuv';
const VERSION = '1.0.0';

interface LaunchedApp {
  app: ElectronApplication;
  page: Page;
  home: string;
}

async function launchApp(options: {
  home: string;
  llmUrl: string;
  catalogFile: string;
}): Promise<LaunchedApp> {
  const app = await _electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      KEPCUP_HOME: options.home,
      NODE_ENV: 'test',
      KEPCUP_KEYSTORE: 'file',
      // P13-B e2e seam: 非引导用例不出现首启向导（packaged 产物恒为 on）。
      KEPCUP_ONBOARDING: 'off',
      KEPCUP_FILE_KEYSTORE_PATH: path.join(options.home, '.test-master-key'),
      KEPCUP_MOCK_LLM_URL: options.llmUrl,
      KEPCUP_ENV_CATALOG_FILE: options.catalogFile,
    },
  });
  const page = await app.firstWindow();
  return { app, page, home: options.home };
}

interface Session {
  app: ElectronApplication;
  page: Page;
  home: string;
  llm: MockLlmServer;
  fileServer: TestFileServer;
}

async function startSession(prefix: string): Promise<Session> {
  const llm = await startMockLlm();

  // 本地模拟文件服务器 + 指向它的 catalog 文件（绝不打真实官方地址）。
  const fixtureDir = mkdtempSync(path.join(tmpdir(), 'kepcup-e2e-env-fixture-'));
  const root = path.join(fixtureDir, `${ITEM}-${VERSION}-bin`);
  mkdirSync(root, { recursive: true });
  const script = path.join(root, ITEM);
  writeFileSync(script, '#!/bin/sh\necho "fakeuv 1.0.0"\n');
  chmodSync(script, 0o755);
  const archive = path.join(fixtureDir, `${ITEM}.tar.gz`);
  execFileSync('tar', ['-czf', archive, '-C', fixtureDir, `${ITEM}-${VERSION}-bin`]);
  const bytes = execFileSync('cat', [archive]);
  const fileServer = await startFileServer({ [`${ITEM}.tar.gz`]: bytes });
  const catalog = [
    {
      item: ITEM,
      version: VERSION,
      displayName: 'FakeUV',
      source: `${fileServer.url}/releases`,
      install: { via: 'archive' },
      platforms: {
        [`${process.platform}-${process.arch}`]: {
          url: `${fileServer.url}/${ITEM}.tar.gz`,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          sizeBytes: bytes.byteLength,
          kind: 'archive',
        },
      },
      verify: { command: '"{bin}" --version', expect: 'fakeuv 1.0.0' },
    },
  ];
  const catalogFile = path.join(fixtureDir, 'catalog.json');
  writeFileSync(catalogFile, JSON.stringify(catalog));

  const home = await mkdtemp(path.join(tmpdir(), prefix));
  const launched = await launchApp({ home, llmUrl: llm.url, catalogFile });
  return { ...launched, llm, fileServer };
}

async function closeSession(session: Session): Promise<void> {
  await session.app.close();
  await session.llm.stop();
  await session.fileServer.stop();
  await rm(session.home, { recursive: true, force: true });
}

async function waitReady(page: Page): Promise<void> {
  await expect(page.locator('[data-testid="app-shell"]')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('[data-testid="ping-result"]')).toContainText('ping ✓', {
    timeout: 60_000,
  });
  // 等启动恢复收尾：chat-view（恢复了对话）/ 空态引导面板 / 首启向导三者
  // 之一都只在 bootstrap 完成后出现。ping ✓ 早于 bootstrap 结束，慢机器上
  // 直接往下走会与异步尾巴竞态。「+」面板的全屏 backdrop 会拦截后续一切
  // 点击，收尾后确保它已收起（面板只开一次，收掉后不会再出现）。
  await expect(
    page
      .locator('[data-testid="chat-view"]')
      .or(page.locator('[data-testid="start-chat-panel"]'))
      .or(page.locator('[data-testid="onboarding"]')),
  ).toBeVisible({ timeout: 60_000 });
  const startBackdrop = page.locator('[data-testid="start-chat-backdrop"]');
  if (await startBackdrop.isVisible()) {
    // 可能有更高层的模态（如首启沙箱准备向导）盖住 backdrop：收不掉就交给
    // 各测试自己的既有处理（它们大多自带 try-click 收尾），不在这里硬等。
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

  // 「+」面板的自动展开是启动恢复的异步尾巴，可能落在建 Bot 之后（慢机器）；
  // 其全屏 backdrop 会拦截后续一切点击，进入测试主体前确保它已收起。
  const backdrop = page.locator('[data-testid="start-chat-backdrop"]');
  if (await backdrop.isVisible()) await backdrop.click();
  await expect(backdrop).toHaveCount(0);
}

test('environment approval card shows size and source, install progress, settings lists and removes', async () => {
  test.setTimeout(240_000);
  const session = await startSession('kepcup-e2e-environment-');
  const { page, llm } = session;
  try {
    await waitReady(page);
    await createBotAndOpenChat(page, '小环');

    // D75: installs change the host — request_environment runs in a write task;
    // its result wakes a turn, the install outcome arrives as an event turn.
    llm.script('mock-main', [
      ...viaTask({
        title: '装环境',
        ack: '好的，我去申请',
        taskSteps: [
          step().replyToolCall('request_environment', { item: ITEM, reason: 'e2e 需要构建工具' }),
          step().replyText('已提交申请'),
        ],
        relay: '申请已提交，等你批准',
      }),
      step()
        .inTurn()
        .expect((req) => req.lastUserText().includes('environment_installed'))
        .replyText('装好了，继续干活'),
    ]);

    const composer = page.locator('[data-testid="composer-input"]');
    await composer.fill('装一下 fakeuv');
    await composer.press('ControlOrMeta+Enter');

    // 审批卡片：体积与来源可见（docs 任务 7）。
    const card = page.locator('[data-testid^="approval-card-"][data-approval-kind="environment"]');
    await expect(card).toBeVisible({ timeout: 60_000 });
    await expect(card.locator('[data-testid="approval-environment-item"]')).toContainText(
      `FakeUV ${VERSION}`,
    );
    await expect(card.locator('[data-testid="approval-environment-size"]')).toContainText(/KB|MB/);
    await expect(card.locator('[data-testid="approval-environment-source"]')).toContainText(
      '127.0.0.1',
    );
    await expect(card.locator('[data-testid="approval-environment"]')).toContainText(
      'e2e 需要构建工具',
    );

    // 批准 → 进度条出现（本地服务器很快，出现与否取决于时机）→ 安装完成标记。
    await card.locator('[data-testid="approval-approve"]').click();
    const doneOrFolded = page
      .locator('[data-testid="approval-environment-done"]')
      .or(page.locator('[data-testid^="approval-record-"][data-approval-status="approved"]'));
    await expect(doneOrFolded.first()).toBeVisible({ timeout: 60_000 });

    // 安装完成 → 事件投递 → Bot 继续工作。
    await expect(page.locator('[data-testid="chat-view"]')).toContainText('装好了，继续干活', {
      timeout: 60_000,
    });

    // 设置页「环境」分区：列出已安装项、占用，支持删除。
    await page.locator('[data-testid="user-menu-trigger"]').click();
    await page.locator('[data-testid="menu-settings"]').click();
    await expect(page.locator('[data-testid="settings-page-content"]')).toBeVisible();
    await page.locator('[data-testid="settings-nav-environment"]').click();
    const section = page.locator('[data-testid="settings-environment"]');
    await expect(section).toBeVisible();
    const row = section.locator(`[data-testid="environment-install-${ITEM}"]`);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row).toContainText(`${ITEM} ${VERSION}`);
    await expect(row.locator('[data-testid^="environment-status-"]')).toContainText('已安装');

    await row.locator(`[data-testid="environment-remove-${ITEM}"]`).click();
    await expect(page.locator('[data-testid="environment-remove-dialog"]')).toBeVisible();
    await page.locator('[data-testid="environment-remove-confirm"]').click();
    await expect(row.locator('[data-testid^="environment-status-"]')).toContainText('已删除', {
      timeout: 30_000,
    });
    await expect(row.locator(`[data-testid="environment-remove-${ITEM}"]`)).toHaveCount(0);
  } finally {
    await closeSession(session);
  }
});
