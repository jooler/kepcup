import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page, _electron } from '@playwright/test';
import { startMockLlm, step, type MockLlmServer } from '@kepcup/testkit';

interface LaunchedApp {
  app: ElectronApplication;
  page: Page;
  home: string;
}

async function launchApp(options: { home: string; llmUrl: string }): Promise<LaunchedApp> {
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
}

async function startSession(prefix: string): Promise<Session> {
  const llm = await startMockLlm();
  const home = await mkdtemp(path.join(tmpdir(), prefix));
  const launched = await launchApp({ home, llmUrl: llm.url });
  return { ...launched, home, llm };
}

async function closeSession(session: Session): Promise<void> {
  await session.app.close();
  await session.llm.stop();
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

/** Forces the native directory picker to return `dir` (no real dialog in e2e). */
async function mockDirectoryPicker(app: ElectronApplication, dir: string): Promise<void> {
  await app.evaluate(({ dialog }, target) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
  }, dir);
}

function makeProjectDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
  writeFileSync(path.join(dir, 'README.md'), '# demo\n');
  return dir;
}

/** 项目选择器已移入右栏「配置」tab：右栏收起时先展开再切 tab，然后打开选择器。 */
async function openProjectSelector(page: Page): Promise<void> {
  if (!(await page.locator('[data-testid="right-panel-tabs"]').isVisible())) {
    await page.locator('[data-testid="right-panel-toggle"]').click();
  }
  await page.locator('[data-testid="right-panel-tabs"]').locator('text=配置').click();
  await page.locator('[data-testid="project-selector-trigger"]').click();
}

test('project selection, switching block while running, changes card, diff and revert', async () => {
  test.setTimeout(300_000);
  const session = await startSession('kepcup-e2e-project-');
  const { page, app, llm } = session;
  const project = makeProjectDir('kepcup-e2e-proj-');
  try {
    await waitReady(page);
    await createBotAndOpenChat(page, '小项');

    // 选择新目录 → 系统对话框（已被 mock）→ 绑定 + 系统消息（弹框保持打开，
    // 方便继续权限设置；对话流程前先 Esc 关闭）
    await mockDirectoryPicker(app, project);
    await openProjectSelector(page);
    await page.locator('[data-testid="project-pick-new"]').click();
    await expect(page.locator('[data-testid="project-selector-name"]')).toContainText(
      path.basename(project),
      { timeout: 15_000 },
    );
    await expect(
      page.locator('[data-testid="system-message"]').filter({ hasText: '项目已绑定' }),
    ).toHaveCount(1, { timeout: 15_000 });
    await expect(page.locator('[data-testid="project-selector"]')).toContainText(
      path.basename(project),
    );
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="project-picker-dialog"]')).not.toBeVisible();

    // 执行中禁用切换：挂起一个 run
    llm.script('mock-main', [step().hold().replyText('挂起中')]);
    await page.locator('[data-testid="composer-input"]').fill('占住执行');
    await page.locator('[data-testid="composer-input"]').press('ControlOrMeta+Enter');
    await expect(page.locator('[data-testid="run-status"]')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-testid="project-selector-trigger"]')).toBeDisabled();
    await expect(page.locator('[data-testid="project-switch-blocked-hint"]')).toBeVisible();

    // 放行后恢复可用
    llm.releaseAll();
    await expect(page.locator('[data-testid="run-status"]')).not.toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-testid="project-selector-trigger"]')).toBeEnabled();

    // 一次有改动的执行 → 改动摘要卡片 → 查看 diff → 整次回退
    llm.script('mock-main', [
      step().replyToolCall('acquire_project_write', { reason: '写入演示文件' }),
      step().replyToolCall('write', { path: 'demo.txt', content: 'demo-content-v1' }),
      step().replyText('写好了'),
    ]);
    await page.locator('[data-testid="composer-input"]').fill('写一个文件');
    await page.locator('[data-testid="composer-input"]').press('ControlOrMeta+Enter');

    const card = page.locator('[data-testid="run-changes-card"]');
    await expect(card).toBeVisible({ timeout: 120_000 });
    expect(existsSync(path.join(project, 'demo.txt'))).toBe(true);

    await card.locator('[data-testid="run-changes-diff"]').click();
    await expect(page.locator('[data-testid="diff-dialog"]')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-testid="diff-body"]')).toContainText('demo.txt', {
      timeout: 30_000,
    });
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="diff-dialog"]')).not.toBeVisible();

    await card.locator('[data-testid="run-changes-revert"]').click();
    await expect(card).not.toBeVisible({ timeout: 30_000 });
    expect(existsSync(path.join(project, 'demo.txt'))).toBe(false);
    expect(readFileSync(path.join(project, 'README.md'), 'utf8')).toBe('# demo\n');
  } finally {
    rmSync(project, { recursive: true, force: true });
    await closeSession(session);
  }
});

test('lease waiting shows in the status line and can be force revoked', async () => {
  test.setTimeout(300_000);
  const session = await startSession('kepcup-e2e-lease-');
  const { page, app, llm } = session;
  const project = makeProjectDir('kepcup-e2e-lease-proj-');
  try {
    await waitReady(page);
    await createBotAndOpenChat(page, '甲');

    // 甲绑定项目并占住租约（挂在工具调用上，run 保持执行中）
    await mockDirectoryPicker(app, project);
    await openProjectSelector(page);
    await page.locator('[data-testid="project-pick-new"]').click();
    await expect(
      page.locator('[data-testid="system-message"]').filter({ hasText: '项目已绑定' }),
    ).toHaveCount(1, { timeout: 15_000 });
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="project-picker-dialog"]')).not.toBeVisible();

    llm.script('mock-main', [
      step().replyToolCall('acquire_project_write', { reason: '占用' }),
      step().hold().replyToolCall('bash', { command: 'sleep 30' }),
    ]);
    await page.locator('[data-testid="composer-input"]').fill('开始工作');
    await page.locator('[data-testid="composer-input"]').press('ControlOrMeta+Enter');
    await expect(page.locator('[data-testid="run-status"]')).toBeVisible({ timeout: 30_000 });

    // 乙：第二个对话绑定同一项目，触发写入 → 排队等待租约
    await createBotAndOpenChat(page, '乙');
    await openProjectSelector(page);
    await page.locator('[data-testid="project-option"]').first().click();
    await expect(
      page.locator('[data-testid="system-message"]').filter({ hasText: '项目已绑定' }),
    ).toHaveCount(1, { timeout: 15_000 });
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="project-picker-dialog"]')).not.toBeVisible();

    llm.script('mock-main', [
      step().replyToolCall('write', { path: '乙.txt', content: 'from-b' }),
      step().replyText('写完了'),
    ]);
    await page.locator('[data-testid="composer-input"]').fill('也写一个');
    await page.locator('[data-testid="composer-input"]').press('ControlOrMeta+Enter');

    const waiting = page.locator('[data-testid="lease-waiting-text"]');
    await expect(waiting).toContainText('等待 甲 完成对项目的修改', { timeout: 60_000 });
    await expect(page.locator('[data-testid="lease-revoke"]')).toBeVisible();

    // 强制收回：乙取得租约并完成写入
    await page.locator('[data-testid="lease-revoke"]').click();
    await expect(waiting).not.toBeVisible({ timeout: 60_000 });
    await expect(page.locator('[data-testid="run-status"]')).not.toBeVisible({ timeout: 120_000 });
    expect(readFileSync(path.join(project, '乙.txt'), 'utf8')).toBe('from-b');
  } finally {
    rmSync(project, { recursive: true, force: true });
    await closeSession(session);
  }
});
