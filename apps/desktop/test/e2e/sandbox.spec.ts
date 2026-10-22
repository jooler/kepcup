import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page, _electron } from '@playwright/test';
import { startMockLlm, step, viaTask, type MockLlmServer } from '@kepcup/testkit';
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
  return { ...launched, llm };
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

test('settings page shows the sandbox status', async () => {
  const session = await startSession('kepcup-e2e-sandbox-');
  const { page } = session;
  try {
    await waitReady(page);
    await page.locator('[data-testid="user-menu-trigger"]').click();
    await page.locator('[data-testid="menu-settings"]').click();
    await expect(page.locator('[data-testid="settings-page-content"]')).toBeVisible();
    await page.locator('[data-testid="settings-nav-environment"]').click();

    const section = page.locator('[data-testid="settings-sandbox"]');
    await expect(section).toBeVisible();
    const state = page.locator('[data-testid="sandbox-state"]');
    await expect(state).toBeVisible({ timeout: 60_000 });
    // Available on macOS/Linux CI runners; the label text differs per platform
    // but a status badge is always rendered.
    const text = await state.textContent();
    expect(['可用', '不可用']).toContain(text?.trim());
    // Reprobe keeps the section functional.
    await page.locator('[data-testid="sandbox-reprobe"]').click();
    await expect(state).toBeVisible({ timeout: 60_000 });
  } finally {
    await closeSession(session);
  }
});

test('run status line shows the command description while a command executes', async () => {
  test.setTimeout(180_000);
  const session = await startSession('kepcup-e2e-statusline-');
  const { page, llm } = session;
  try {
    await waitReady(page);
    await createBotAndOpenChat(page, '小执行');

    // D75: commands run in tasks; the status line shows the task's activity.
    // `echo` returns in milliseconds. On a fast macOS runner the progress
    // event and the task's terminal status land before the renderer paints,
    // so `[data-testid="task-status-text"]` never attaches. `locator.textContent()`
    // inside `expect.poll` then waits its full 30s action timeout and fails.
    // Hold the task step after the command: the run stays active with the
    // progress text until the assertion has seen it. `echo` stays on the
    // read-only allowlist so confirm mode (sandbox unavailable) still runs it.
    const afterCommand = step().hold().replyText('命令输出 sandbox-e2e-probe');
    llm.script(
      'mock-main',
      viaTask({
        title: '跑命令',
        writes: false,
        taskSteps: [
          step().replyToolCall('bash', { command: 'echo sandbox-e2e-probe' }),
          afterCommand,
        ],
        relay: '执行完了',
      }),
    );

    const composer = page.locator('[data-testid="composer-input"]');
    await composer.fill('跑个命令');
    // Cmd/Ctrl+Enter 发送队列中的全部草稿（Enter 只入队）。
    await composer.press('ControlOrMeta+Enter');

    const statusText = page.locator('[data-testid="task-status-text"]');
    await expect(statusText).toContainText('正在执行命令', { timeout: 60_000 });
    afterCommand.release();

    await expect(page.locator('[data-testid="task-status"]')).toBeHidden({ timeout: 120_000 });
    await expect(page.locator('[data-testid="chat-view"]').getByText('执行完了')).toBeVisible();
  } finally {
    await closeSession(session);
  }
});
