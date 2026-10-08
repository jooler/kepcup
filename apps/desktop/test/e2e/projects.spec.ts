import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page, _electron } from '@playwright/test';
import { startMockLlm, step, viaTask, type MockLlmServer } from '@kepcup/testkit';

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
    // D75：写在写任务里（任务启动前整任务持有项目写租约），结果经对话轮转述。
    llm.script(
      'mock-main',
      viaTask({
        title: '写演示文件',
        taskSteps: [
          step().replyToolCall('write', { path: 'demo.txt', content: 'demo-content-v1' }),
          step().replyText('demo.txt 已写入'),
        ],
        relay: '写好了',
      }),
    );
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

// D75（DEV-015）：同一 project 的写任务在任务层排队（还没去申请写租约），
// 状态行与任务卡显示「等写入租约（任务 … 持有）」；「强制收回」对这种排队
// 不起作用——放行方式是取消（或等完）持有它的那条任务。
test('a write task queued behind another conversation\'s write task shows the wait and runs once that task is cancelled', async () => {
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

    // D75：甲的写任务启动前取得项目租约并整任务持有（挂在工具调用上保持执行中）。
    const held = step().hold().replyToolCall('bash', { command: 'sleep 30' });
    llm.script(
      'mock-main',
      viaTask({ title: '占用项目', ack: '甲开始工作', taskSteps: [held] }),
    );
    await page.locator('[data-testid="composer-input"]').fill('开始工作');
    await page.locator('[data-testid="composer-input"]').press('ControlOrMeta+Enter');
    await expect(
      page.locator('[data-testid="run-status"]').filter({ hasText: '占用项目' }),
    ).toBeVisible({ timeout: 30_000 });
    // The task's request is parked on the held step (the script is replaced next).
    await expect.poll(() => held.consumed, { timeout: 30_000 }).toBe(true);

    // 乙：第二个对话绑定同一项目，触发写入 → 排队等待租约
    await createBotAndOpenChat(page, '乙');
    await openProjectSelector(page);
    await page.locator('[data-testid="project-option"]').first().click();
    await expect(
      page.locator('[data-testid="system-message"]').filter({ hasText: '项目已绑定' }),
    ).toHaveCount(1, { timeout: 15_000 });
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="project-picker-dialog"]')).not.toBeVisible();

    // 乙的写任务排队等同一项目的租约（任务仍是 submitted，状态行显示等待）。
    llm.script(
      'mock-main',
      viaTask({
        title: '也写一个',
        ack: '乙去写',
        taskSteps: [
          step().replyToolCall('write', { path: '乙.txt', content: 'from-b' }),
          step().replyText('乙.txt 已写入'),
        ],
        relay: '写完了',
      }),
    );
    await page.locator('[data-testid="composer-input"]').fill('也写一个');
    await page.locator('[data-testid="composer-input"]').press('ControlOrMeta+Enter');

    const status = page.locator('[data-testid="run-status-text"]').filter({ hasText: '也写一个' });
    await expect(status).toContainText('等写入租约', { timeout: 60_000 });
    const card = page.locator('[data-testid^="task-card-"]').filter({ hasText: '也写一个' });
    await expect(card).toHaveAttribute('data-task-state', 'submitted');
    await expect(card.locator('[data-testid="task-queue-reason"]')).toContainText('等写入租约');

    // 回到甲的对话，在甲的任务卡上取消 → 乙的任务取得租约并完成写入
    await page
      .locator('[data-testid^="conversation-item-"]', { hasText: '甲' })
      .first()
      .click();
    const holder = page.locator('[data-testid^="task-card-"]').filter({ hasText: '占用项目' });
    await expect(holder).toHaveAttribute('data-task-state', 'running', { timeout: 30_000 });
    await holder.locator('[data-testid="task-cancel"]').click();
    await expect(holder).toHaveAttribute('data-task-state', 'cancelled', { timeout: 30_000 });
    await expect
      .poll(() => existsSync(path.join(project, '乙.txt')), { timeout: 60_000 })
      .toBe(true);
    expect(readFileSync(path.join(project, '乙.txt'), 'utf8')).toBe('from-b');
    await page
      .locator('[data-testid^="conversation-item-"]', { hasText: '乙' })
      .first()
      .click();
    await expect(card).toHaveAttribute('data-task-state', 'completed', { timeout: 60_000 });
    await expect(
      page.locator('[data-testid="bot-bubble"]').filter({ hasText: '写完了' }),
    ).toBeVisible({ timeout: 60_000 });
  } finally {
    rmSync(project, { recursive: true, force: true });
    await closeSession(session);
  }
});
