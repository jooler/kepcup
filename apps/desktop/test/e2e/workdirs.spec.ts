import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page, _electron } from '@playwright/test';
import { isTaskRequest, startMockLlm, step, viaTask, type MockLlmServer } from '@kepcup/testkit';
import { createBotAndOpenChat } from './helpers/create-bot';
import { rmHomeTolerant } from './helpers/home-cleanup';

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
      TZ: 'Asia/Shanghai',
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
  await rmHomeTolerant(session.home);
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

/** Forces the native directory picker to return `dir` (no real dialog in e2e). */
async function mockDirectoryPicker(app: ElectronApplication, dir: string): Promise<void> {
  await app.evaluate(({ dialog }, target) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
  }, dir);
}

function makeWorkdirDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
  writeFileSync(path.join(dir, 'README.md'), '# demo\n');
  return dir;
}

/** 工作目录选择器已移入右栏「配置」tab：右栏收起时先展开再切 tab，然后打开选择器。 */
async function openWorkdirSelector(page: Page): Promise<void> {
  if (!(await page.locator('[data-testid="right-panel-tabs"]').isVisible())) {
    await page.locator('[data-testid="right-panel-toggle"]').click();
  }
  await page.locator('[data-testid="right-panel-tabs"]').locator('text=配置').click();
  await page.locator('[data-testid="workdir-selector-trigger"]').click();
}

test('workdir selection, switching block while running; no changes card after writes', async () => {
  test.setTimeout(300_000);
  const session = await startSession('kepcup-e2e-workdir-');
  const { page, app, llm } = session;
  const workdir = makeWorkdirDir('kepcup-e2e-proj-');
  try {
    await waitReady(page);
    await createBotAndOpenChat(page, '小项');

    // 选择新目录 → 系统对话框（已被 mock）→ 绑定 + 系统消息（弹框保持打开，
    // 方便继续权限设置；对话流程前先 Esc 关闭）
    await mockDirectoryPicker(app, workdir);
    await openWorkdirSelector(page);
    await page.locator('[data-testid="workdir-pick-new"]').click();
    await expect(page.locator('[data-testid="workdir-selector-name"]')).toContainText(
      path.basename(workdir),
      { timeout: 15_000 },
    );
    await expect(
      page.locator('[data-testid="system-message"]').filter({ hasText: '工作目录已绑定' }),
    ).toHaveCount(1, { timeout: 15_000 });
    await expect(page.locator('[data-testid="workdir-selector"]')).toContainText(
      path.basename(workdir),
    );
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="workdir-picker-dialog"]')).not.toBeVisible();

    // 执行中禁用切换：挂起一个 run
    llm.script('mock-main', [step().hold().replyText('挂起中')]);
    await page.locator('[data-testid="composer-input"]').fill('占住执行');
    await page.locator('[data-testid="composer-input"]').press('ControlOrMeta+Enter');
    await expect(page.locator('[data-testid="run-status"]')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-testid="workdir-selector-trigger"]')).toBeDisabled();
    await expect(page.locator('[data-testid="workdir-switch-blocked-hint"]')).toBeVisible();

    // 放行后恢复可用
    llm.releaseAll();
    await expect(page.locator('[data-testid="run-status"]')).not.toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-testid="workdir-selector-trigger"]')).toBeEnabled();

    // 一次有改动的写任务：磁盘文件保留，对话中不再出现改动摘要卡 / diff / 回退。
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

    // 侧栏预览与消息气泡都带这句话：只认气泡。
    await expect(
      page.locator('[data-testid="bot-bubble"]').filter({ hasText: '写好了' }).first(),
    ).toBeVisible({ timeout: 120_000 });
    expect(existsSync(path.join(workdir, 'demo.txt'))).toBe(true);
    await expect(page.locator('[data-testid="run-changes-card"]')).toHaveCount(0);
    expect(readFileSync(path.join(workdir, 'README.md'), 'utf8')).toBe('# demo\n');
  } finally {
    rmSync(workdir, { recursive: true, force: true });
    await closeSession(session);
  }
});

// D75（DEV-015）：同一 workdir 的写任务在任务层排队（还没去申请写租约），
// 状态行与任务卡显示「等写入租约（任务 … 持有）」；「强制收回」对这种排队
// 不起作用——放行方式是取消（或等完）持有它的那条任务。
test("a write task queued behind another conversation's write task shows the wait and runs once that task is cancelled", async () => {
  test.setTimeout(300_000);
  const session = await startSession('kepcup-e2e-lease-');
  const { page, app, llm } = session;
  const workdir = makeWorkdirDir('kepcup-e2e-lease-proj-');
  try {
    await waitReady(page);
    await createBotAndOpenChat(page, '甲');

    // 甲绑定工作目录并占住租约（挂在工具调用上，run 保持执行中）
    await mockDirectoryPicker(app, workdir);
    await openWorkdirSelector(page);
    await page.locator('[data-testid="workdir-pick-new"]').click();
    await expect(
      page.locator('[data-testid="system-message"]').filter({ hasText: '工作目录已绑定' }),
    ).toHaveCount(1, { timeout: 15_000 });
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="workdir-picker-dialog"]')).not.toBeVisible();

    // D75：甲的写任务启动前取得工作目录租约并整任务持有（挂在工具调用上保持执行中）。
    const held = step().hold().replyToolCall('bash', { command: 'sleep 30' });
    llm.script(
      'mock-main',
      viaTask({ title: '占用工作目录', ack: '甲开始工作', taskSteps: [held] }),
    );
    await page.locator('[data-testid="composer-input"]').fill('开始工作');
    await page.locator('[data-testid="composer-input"]').press('ControlOrMeta+Enter');
    await expect(
      page.locator('[data-testid="task-status"]').filter({ hasText: '占用工作目录' }),
    ).toBeVisible({ timeout: 30_000 });
    // The task's request is parked on the held step (the script is replaced next).
    await expect.poll(() => held.consumed, { timeout: 30_000 }).toBe(true);

    // 乙：第二个对话绑定同一工作目录，触发写入 → 排队等待租约
    await createBotAndOpenChat(page, '乙');
    await openWorkdirSelector(page);
    await page.locator('[data-testid="workdir-option"]').first().click();
    await expect(
      page.locator('[data-testid="system-message"]').filter({ hasText: '工作目录已绑定' }),
    ).toHaveCount(1, { timeout: 15_000 });
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="workdir-picker-dialog"]')).not.toBeVisible();

    // 乙的写任务排队等同一工作目录的租约（任务仍是 submitted，状态行显示等待）。
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

    const status = page.locator('[data-testid="task-status-text"]').filter({ hasText: '也写一个' });
    await expect(status).toContainText('等写入租约', { timeout: 60_000 });
    const card = page.locator('[data-testid^="task-card-"]').filter({ hasText: '也写一个' });
    await expect(card).toHaveAttribute('data-task-state', 'submitted');
    await expect(card.locator('[data-testid="task-queue-reason"]')).toContainText('等写入租约');

    // 回到甲的对话，在甲的任务卡上取消 → 乙的任务取得租约并完成写入。
    // D93：用户取消会唤醒甲；必须先备好取消 wake，否则会吃掉乙 viaTask 的 relay「写完了」。
    await page.locator('[data-testid^="conversation-item-"]', { hasText: '甲' }).first().click();
    const holder = page.locator('[data-testid^="task-card-"]').filter({ hasText: '占用工作目录' });
    await expect(holder).toHaveAttribute('data-task-state', 'running', { timeout: 30_000 });
    llm.script('mock-main', [
      step()
        .inTurn()
        .expect(
          (req) =>
            !isTaskRequest(req) && req.lastUserText().includes('用户从任务卡主动取消'),
        )
        .replyText('好，占用已取消'),
      step().inTask().replyToolCall('write', { path: '乙.txt', content: 'from-b' }),
      step().inTask().replyText('乙.txt 已写入'),
      step()
        .inTurn()
        .expect(
          (req) =>
            !isTaskRequest(req) &&
            req.lastUserText().includes('<trigger reason="task"') &&
            !req.lastUserText().includes('用户从任务卡主动取消'),
        )
        .replyText('写完了'),
    ]);
    await holder.locator('[data-testid="task-cancel"]').click();
    await expect(holder).toHaveAttribute('data-task-state', 'cancelled', { timeout: 30_000 });
    await expect(
      page.locator('[data-testid="bot-bubble"]').filter({ hasText: '好，占用已取消' }),
    ).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() => existsSync(path.join(workdir, '乙.txt')), { timeout: 60_000 })
      .toBe(true);
    expect(readFileSync(path.join(workdir, '乙.txt'), 'utf8')).toBe('from-b');
    await page.locator('[data-testid^="conversation-item-"]', { hasText: '乙' }).first().click();
    await expect(card).toHaveAttribute('data-task-state', 'completed', { timeout: 60_000 });
    await expect(
      page.locator('[data-testid="bot-bubble"]').filter({ hasText: '写完了' }),
    ).toBeVisible({ timeout: 60_000 });
  } finally {
    rmSync(workdir, { recursive: true, force: true });
    await closeSession(session);
  }
});
