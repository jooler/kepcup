import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page, _electron } from '@playwright/test';
import { startMockLlm, step, type MockLlmServer } from '@kepcup/testkit';

/**
 * P10 e2e (docs/dev/phases/P10-proactive.md 测试要求「端到端」: 定时任务列表显示
 * 与取消). Schedule data flows through the REAL core stack: the scripted model
 * calls the schedule tool inside a real response run, the real single-timer
 * service arms the real clock, and a due task is delivered through the real
 * Mailbox (reason='scheduled') — the bot posts proactively. The right-panel tab
 * and the settings overview render schedules.list; cancellation is the two-step
 * confirm over schedules.cancel.
 */

function emptyReflection() {
  return {
    runSummary: '无新记忆',
    memories: [],
    profileProposals: [],
    wikiSuggestions: [],
    skillSuggestion: null,
  };
}

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
  return { ...launched, llm };
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

async function openSettings(page: Page): Promise<void> {
  // 弹框可能已开着（嵌套向导关闭后设置仍在）：先 Escape 归零再走菜单入口。
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-testid="settings-dialog"]')).toBeHidden();
  await page.locator('[data-testid="user-menu-trigger"]').click();
  await page.locator('[data-testid="menu-settings"]').click();
  await expect(page.locator('[data-testid="settings-page-content"]')).toBeVisible();
}

async function backToChats(page: Page): Promise<void> {
  // 设置是弹框（主区域常驻对话）：Escape 关闭即可回到对话。
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-testid="settings-dialog"]')).toBeHidden();
  await expect(page.locator('[data-testid="chat-view"]')).toBeVisible({ timeout: 15_000 });
}

async function openSchedulesTab(page: Page): Promise<void> {
  // 右栏默认收起：需要时经顶部药丸展开（toggle 语义，不能盲点）。
  if (!(await page.locator('[data-testid="right-panel-tabs"]').isVisible())) {
    await page.locator('[data-testid="right-panel-toggle"]').click();
  }
  await page.locator('[data-testid="right-panel-tabs"]').locator('text=定时任务').click();
  await expect(page.locator('[data-testid="schedules-tab"]')).toBeVisible();
}

/** The real response run creates the task through the schedule tool. */
async function scheduleViaChat(
  page: Page,
  llm: MockLlmServer,
  options: { fireInMs: number; note: string; ack: string },
): Promise<void> {
  const when = new Date(Date.now() + options.fireInMs).toISOString();
  llm.script('mock-main', [
    step()
      .expect((req) => req.lastUserText().includes('提醒'))
      .replyToolCall('schedule', { when, note: options.note }),
    step()
      .expect((req) => JSON.stringify(req.body).includes('已创建一次性定时任务'))
      .replyText(options.ack),
  ]);
  const composer = page.locator('[data-testid="composer-input"]');
  await composer.fill('十分钟后提醒我看报表');
  await composer.press('ControlOrMeta+Enter');
  await expect(
    page.locator('[data-testid="bot-bubble"]').filter({ hasText: options.ack }).first(),
  ).toBeVisible({ timeout: 30_000 });
}

test('schedules tab and settings overview: list display and two-step cancel', async () => {
  test.setTimeout(240_000);
  const session = await startSession('kepcup-e2e-schedules-');
  const { page, llm } = session;
  try {
    await waitReady(page);
    await createBotAndOpenChat(page, '阿点');

    // Fire in 5 minutes: the task never comes due inside this test — the
    // cancel path is what removes it.
    await scheduleViaChat(page, llm, {
      fireInMs: 5 * 60_000,
      note: '提醒用户看报表',
      ack: '好的，到时候我会提醒你',
    });
    llm.script('mock-light', [step().replyJson(emptyReflection())]);

    // --- right-panel tab: the task shows note, bot and next fire time -------
    await openSchedulesTab(page);
    const tab = page.locator('[data-testid="schedules-tab"]');
    const item = tab.locator('[data-testid^="schedule-item-"]').filter({ hasText: '看报表' });
    await expect(item).toBeVisible({ timeout: 15_000 });
    await expect(item.locator('[data-testid="schedule-note"]')).toHaveText('提醒用户看报表');
    await expect(item.locator('[data-testid="schedule-bot"]')).toHaveText('阿点');
    await expect(item.locator('[data-testid="schedule-when"]')).toContainText('下次触发');
    await expect(item.locator('[data-testid="schedule-when"]')).toContainText(/\d{4}/);
    // Nothing defers this task (no quiet hours, daily cap not reached).
    await expect(item.locator('[data-testid="schedule-deferred"]')).toHaveCount(0);

    // --- settings overview: the same task under the bot's name --------------
    await openSettings(page);
    await page.locator('[data-testid="settings-nav-unattended"]').click();
    const section = page.locator('[data-testid="settings-schedules"]');
    const globalItem = section
      .locator('[data-testid^="schedule-item-"]')
      .filter({ hasText: '看报表' });
    await expect(globalItem).toBeVisible({ timeout: 15_000 });
    await expect(globalItem.locator('[data-testid="schedule-bot"]')).toHaveText('阿点');

    // --- back to the chat: two-step cancel removes the task everywhere ------
    await backToChats(page);
    await openSchedulesTab(page);
    await item.locator('[data-testid^="schedule-cancel-"]').click();
    await expect(item.locator('[data-testid="schedule-cancel-confirm"]')).toBeVisible();
    await item.locator('[data-testid="schedule-cancel-confirm"]').click();
    await expect(tab.locator('[data-testid="schedules-tab-empty"]')).toBeVisible({
      timeout: 15_000,
    });

    // The settings overview follows (schedules.list is live on refresh).
    await openSettings(page);
    await page.locator('[data-testid="settings-nav-unattended"]').click();
    await expect(page.locator('[data-testid="settings-schedules-list-empty"]')).toBeVisible({
      timeout: 15_000,
    });
  } finally {
    await closeSession(session);
  }
});

test('due task fires: the bot posts proactively and the task leaves the list', async () => {
  test.setTimeout(300_000);
  const session = await startSession('kepcup-e2e-schedules-fire-');
  const { page, llm } = session;
  try {
    await waitReady(page);
    await createBotAndOpenChat(page, '阿钟');

    // Real clock: the single-timer service fires ~25s after creation; the
    // trigger segment (reason=scheduled) carries the note.
    llm.script('mock-main', [
      step()
        .expect((req) => req.lastUserText().includes('提醒'))
        .replyToolCall('schedule', {
          when: new Date(Date.now() + 25_000).toISOString(),
          note: '提醒用户看报表',
        }),
      step()
        .expect((req) => JSON.stringify(req.body).includes('已创建一次性定时任务'))
        .replyText('好的，到点我提醒你'),
      step()
        .expect((req) => req.lastUserText().includes('定时任务触发'))
        .replyText('提醒：到点啦，该看报表了'),
    ]);
    // One reflection per completed response run (creation + proactive), plus margin.
    llm.script(
      'mock-light',
      Array.from({ length: 3 }, () => step().replyJson(emptyReflection())),
    );

    const composer = page.locator('[data-testid="composer-input"]');
    await composer.fill('十分钟后提醒我看报表');
    await composer.press('ControlOrMeta+Enter');
    await expect(
      page.locator('[data-testid="bot-bubble"]').filter({ hasText: '到点我提醒你' }).first(),
    ).toBeVisible({ timeout: 30_000 });

    // The pending task is listed while it waits.
    await openSchedulesTab(page);
    const tab = page.locator('[data-testid="schedules-tab"]');
    await expect(
      tab.locator('[data-testid^="schedule-item-"]').filter({ hasText: '看报表' }),
    ).toBeVisible({ timeout: 15_000 });

    // The proactive message lands in the conversation (no user input involved).
    await expect(
      page.locator('[data-testid="bot-bubble"]').filter({ hasText: '到点啦，该看报表了' }).first(),
    ).toBeVisible({ timeout: 120_000 });

    // A fired one-shot task is done: the list empties on refresh.
    await tab.locator('[data-testid="schedules-tab-refresh"]').click();
    await expect(tab.locator('[data-testid="schedules-tab-empty"]')).toBeVisible({
      timeout: 15_000,
    });
  } finally {
    await closeSession(session);
  }
});
