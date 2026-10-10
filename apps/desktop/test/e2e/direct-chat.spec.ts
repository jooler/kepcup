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

async function launchApp(options: {
  home: string;
  llmUrl: string;
  keystore?: 'memory' | 'file';
}): Promise<LaunchedApp> {
  const app = await _electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      KEPCUP_HOME: options.home,
      NODE_ENV: 'test',
      KEPCUP_KEYSTORE: options.keystore ?? 'file',
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

/** Creates one bot through the UI and opens its chat. Returns its card name. */
async function createBotAndOpenChat(page: Page, name: string): Promise<void> {
  await page.locator('[data-testid="new-chat-button"]').click();

  await page.locator('[data-testid="bot-create-form"]').click();
  await expect(page.locator('[data-testid="bot-create-dialog"]')).toBeVisible();
  await page.locator('[data-testid="bot-create-dialog"] [data-testid="bot-name-input"]').fill(name);
  await page
    .locator('[data-testid="bot-create-dialog"] [data-testid="bot-personality-input"]')
    .fill('认真可靠');
  await page.locator('[data-testid="bot-create-save"]').click();

  // Creating a bot opens its chat directly.
  await expect(page.locator('[data-testid="chat-view"]')).toBeVisible({ timeout: 15_000 });

  // 「+」面板的自动展开是启动恢复的异步尾巴，可能落在建 Bot 之后（慢机器）；
  // 其全屏 backdrop 会拦截后续一切点击，进入测试主体前确保它已收起。
  const backdrop = page.locator('[data-testid="start-chat-backdrop"]');
  if (await backdrop.isVisible()) await backdrop.click();
  await expect(backdrop).toHaveCount(0);
}

/**
 * 「+」面板的自动展开是启动恢复（bootstrap）的异步尾巴，可能落在测试早期
 * 交互之后；其全屏 backdrop 会拦截后续点击，关键交互前确保它已收起。
 */
async function ensureStartPanelClosed(page: Page): Promise<void> {
  const backdrop = page.locator('[data-testid="start-chat-backdrop"]');
  if (await backdrop.isVisible()) await backdrop.click();
  await expect(backdrop).toHaveCount(0);
}

test('draft queue full flow: add, edit, reorder, remove, Enter flush, Cmd+Enter, reply', async () => {
  test.setTimeout(180_000);
  const session = await startSession('kepcup-e2e-draft-');
  const { page, llm } = session;
  try {
    await waitReady(page);
    await createBotAndOpenChat(page, '小艾');

    const composer = page.locator('[data-testid="composer-input"]');

    // No messages yet: the queue + composer float centered; the dock moves to
    // the bottom once the first message exists.
    await expect(page.locator('[data-testid="composer-dock"]')).toHaveAttribute(
      'data-centered',
      'true',
    );

    // Two drafts join the queue; the input clears each time.
    await composer.fill('第一条消息');
    await composer.press('Enter');
    await expect(page.locator('[data-testid="draft-text"]')).toHaveCount(1);
    await expect(composer).toHaveText('');
    await composer.fill('第二条消息');
    await composer.press('Enter');
    await expect(page.locator('[data-testid="draft-text"]')).toHaveCount(2);

    // Reorder: drag the first draft onto the second -> [第二条消息, 第一条消息].
    await page
      .locator('[data-testid^="draft-item-"]')
      .first()
      .dragTo(page.locator('[data-testid^="draft-item-"]').last());
    await expect(page.locator('[data-testid="draft-text"]').first()).toHaveText('第二条消息');

    // Edit the first draft inline.
    await page.locator('[data-testid="draft-text"]').first().click();
    const editInput = page.locator('[data-testid="draft-edit-input"]');
    await expect(editInput).toBeVisible();
    await editInput.fill('第二条消息（已修改）');
    await editInput.press('Enter');
    await expect(page.locator('[data-testid="draft-text"]').first()).toHaveText(
      '第二条消息（已修改）',
    );

    // Remove the remaining draft ("第一条消息").
    await page.locator('[data-testid^="draft-item-"]').last().hover();
    await page.locator('[data-testid="draft-remove"]').last().click();
    await expect(page.locator('[data-testid="draft-text"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="draft-text"]').first()).toHaveText(
      '第二条消息（已修改）',
    );

    // Flush with Enter on the empty input; the mock answers.
    llm.script('mock-main', [step().replyText('收到，看到了')]);
    await composer.click();
    await composer.press('Enter');

    await expect(page.locator('[data-testid="user-bubble"]')).toHaveCount(1, { timeout: 15_000 });
    await expect(page.locator('[data-testid="user-bubble"]').first()).toContainText(
      '第二条消息（已修改）',
    );
    await expect(page.locator('[data-testid="composer-dock"]')).toHaveAttribute(
      'data-centered',
      'false',
    );
    await expect(page.locator('[data-testid="draft-queue"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="bot-bubble"]').first()).toContainText('收到，看到了', {
      timeout: 30_000,
    });

    // Cmd/Ctrl+Enter sends the current input immediately.
    llm.script('mock-main', [step().replyText('好的，第二条也收到')]);
    await composer.fill('再来一条');
    await composer.press('Meta+Enter');
    await expect(page.locator('[data-testid="user-bubble"]')).toHaveCount(2, { timeout: 15_000 });
    await expect(page.locator('[data-testid="bot-bubble"]').nth(1)).toContainText(
      '好的，第二条也收到',
      {
        timeout: 30_000,
      },
    );

    // 「立即」sends only the targeted draft; the rest of the queue stays put.
    llm.script('mock-main', [step().replyText('立即的一条收到')]);
    await composer.fill('先排队一条');
    await composer.press('Enter');
    await composer.fill('再排队一条');
    await composer.press('Enter');
    await expect(page.locator('[data-testid="draft-text"]')).toHaveCount(2);
    await page.locator('[data-testid="draft-send-now"]').first().click();
    await expect(page.locator('[data-testid="user-bubble"]')).toHaveCount(3, { timeout: 15_000 });
    await expect(page.locator('[data-testid="user-bubble"]').last()).toContainText('先排队一条');
    await expect(page.locator('[data-testid="draft-text"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="draft-text"]').first()).toHaveText('再排队一条');

    // Clean up the leftover draft so the session ends tidy.
    await page.locator('[data-testid^="draft-item-"]').hover();
    await page.locator('[data-testid="draft-remove"]').click();
    await expect(page.locator('[data-testid="draft-queue"]')).toHaveCount(0);
  } finally {
    await closeSession(session);
  }
});

test('a batch of drafts becomes multiple bubbles and one run; the run status shows without cancel', async () => {
  test.setTimeout(180_000);
  const session = await startSession('kepcup-e2e-status-');
  const { page, llm } = session;
  try {
    await waitReady(page);
    await createBotAndOpenChat(page, '小艾');
    const composer = page.locator('[data-testid="composer-input"]');

    // The first model call hangs until we release it: the status line stays.
    llm.script('mock-main', [
      step().hold().replyText('释放后才到达的第一条回复'),
      step().replyText('第二条回复'),
    ]);

    await composer.fill('先做一件事');
    await composer.press('Enter');
    await composer.fill('再做另一件事');
    await composer.press('Enter');
    await composer.click();
    await composer.press('Enter');

    await expect(page.locator('[data-testid="user-bubble"]')).toHaveCount(2, { timeout: 15_000 });
    await expect(page.locator('[data-testid="run-status"]')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid="run-status-text"]')).toBeVisible();

    // Sidebar shows the running marker.
    await expect(page.locator('[data-testid="running-dot"]').first()).toBeVisible();

    // 状态行只展示不允许取消：没有取消入口，run 自己跑完。
    await expect(page.locator('[data-testid="run-cancel"]')).toHaveCount(0);

    // Release: the run completes on its own and the status line gives way.
    llm.releaseAll();
    await expect(page.locator('[data-testid="bot-bubble"]').first()).toContainText(
      '释放后才到达的第一条回复',
      {
        timeout: 30_000,
      },
    );
    await expect(page.locator('[data-testid="run-status"]')).toBeHidden({ timeout: 15_000 });
    await expect(page.locator('[data-testid="user-bubble"]')).toHaveCount(2);

    // A follow-up message starts a new run that completes normally.
    await composer.fill('继续吧');
    await composer.press('Meta+Enter');
    await expect(page.locator('[data-testid="user-bubble"]')).toHaveCount(3, { timeout: 15_000 });
    await expect(page.locator('[data-testid="bot-bubble"]')).toHaveCount(2, { timeout: 30_000 });
    await expect(page.locator('[data-testid="bot-bubble"]').last()).toContainText('第二条回复');
  } finally {
    await closeSession(session);
  }
});

test('a failed run shows a closable banner: dismiss hides it across switches and successes', async () => {
  test.setTimeout(180_000);
  const session = await startSession('kepcup-e2e-failbanner-');
  const { page, llm } = session;
  try {
    await waitReady(page);
    await createBotAndOpenChat(page, '小艾');

    // 注入一次供应商故障使 run 失败：横幅出现，内容为「执行失败：…」。
    llm.script('mock-main', [step().failWith(500, '模拟供应商故障')]);
    const composer = page.locator('[data-testid="composer-input"]');
    await composer.fill('触发一次失败');
    await composer.press('Meta+Enter');
    await expect(page.locator('[data-testid="user-bubble"]')).toHaveCount(1, { timeout: 15_000 });

    const banner = page.locator('[data-testid="run-failed-banner"]');
    await expect(banner).toBeVisible({ timeout: 30_000 });
    await expect(banner).toContainText('执行失败');

    // 关闭按钮收起横幅；该失败不再回弹（本会话内）。
    await banner.locator('[data-testid="run-failed-dismiss"]').click();
    await expect(banner).toBeHidden({ timeout: 10_000 });

    // 切走（第二个 Bot 的会话）再切回：已关闭的失败不因重新加载会话而复现。
    // 以失败消息的用户气泡可见作为「会话切换完成」信号，避免发送竞态。
    await createBotAndOpenChat(page, '小诚');
    await page
      .locator('[data-testid^="conversation-item-"]')
      .filter({ hasText: '小艾' })
      .first()
      .click();
    await expect(page.locator('[data-testid="user-bubble"]')).toHaveCount(1, { timeout: 15_000 });
    await expect(page.locator('[data-testid="run-failed-banner"]')).toHaveCount(0);

    // 之后的成功发送既不复活旧横幅，也不被其阻挡。
    llm.script('mock-main', [step().replyText('这次成功了')]);
    await composer.fill('再来一次');
    await composer.press('Meta+Enter');
    await expect(page.locator('[data-testid="user-bubble"]')).toHaveCount(2, { timeout: 15_000 });
    await expect(page.locator('[data-testid="bot-bubble"]').first()).toContainText('这次成功了', {
      timeout: 30_000,
    });
    await expect(page.locator('[data-testid="run-failed-banner"]')).toHaveCount(0);
  } finally {
    await closeSession(session);
  }
});

test('queued drafts survive an app restart', async () => {
  test.setTimeout(180_000);
  const session = await startSession('kepcup-e2e-restart-');
  const { page, home, llm } = session;
  try {
    await waitReady(page);
    await createBotAndOpenChat(page, '小艾');
    const composer = page.locator('[data-testid="composer-input"]');
    await composer.fill('重启前写入队列的消息');
    await composer.press('Enter');
    await expect(page.locator('[data-testid="draft-text"]')).toHaveText('重启前写入队列的消息');

    await session.app.close();
    await llm.stop();

    const llm2 = await startMockLlm();
    try {
      llm2.script('mock-main', [step().replyText('重启后收到')]);
      const relaunched = await launchApp({ home, llmUrl: llm2.url, keystore: 'file' });
      try {
        await waitReady(relaunched.page);
        // Open the conversation again from the sidebar.
        await relaunched.page.locator('[data-testid^="conversation-item-"]').first().click();
        await expect(relaunched.page.locator('[data-testid="draft-text"]')).toHaveText(
          '重启前写入队列的消息',
          { timeout: 15_000 },
        );

        await relaunched.page.locator('[data-testid="composer-input"]').click();
        await relaunched.page.locator('[data-testid="composer-input"]').press('Enter');
        await expect(relaunched.page.locator('[data-testid="bot-bubble"]').first()).toContainText(
          '重启后收到',
          { timeout: 30_000 },
        );
      } finally {
        await relaunched.app.close();
      }
    } finally {
      await llm2.stop();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('deleting the conversation removes it; deleting the bot removes its entry and closes its chat', async () => {
  test.setTimeout(180_000);
  const session = await startSession('kepcup-e2e-delete-');
  const { page, llm } = session;
  try {
    await waitReady(page);
    await createBotAndOpenChat(page, '小艾');

    llm.script('mock-main', [step().replyText('历史消息')]);
    const composer = page.locator('[data-testid="composer-input"]');
    await composer.fill('留下历史');
    await composer.press('Meta+Enter');
    await expect(page.locator('[data-testid="bot-bubble"]').first()).toContainText('历史消息', {
      timeout: 30_000,
    });

    // Delete the conversation itself (context menu on the sidebar item).
    await ensureStartPanelClosed(page);
    await page.locator('[data-testid^="conversation-row-"]').first().click({ button: 'right' });
    await page.locator('[data-testid="context-delete-conversation"]').click();
    await expect(page.locator('[data-testid="conversation-delete-dialog"]')).toBeVisible();
    await page.locator('[data-testid="conversation-delete-confirm"]').click();
    await expect(page.locator('[data-testid="chat-empty"]')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-testid^="conversation-row-"]')).toHaveCount(0);

    // Delete a bot from the contacts page: its data is kept, but the UI shows
    // the deletion — the sidebar no longer lists its direct chat and the open
    // chat closes (memory evidence jumps can still reopen it read-only).
    await createBotAndOpenChat(page, '小明');
    await ensureStartPanelClosed(page);
    llm.script('mock-main', [step().replyText('在')]);
    await composer.fill('再来一条');
    await composer.press('Meta+Enter');
    await expect(page.locator('[data-testid="bot-bubble"]').first()).toContainText('在', {
      timeout: 30_000,
    });
    await page.locator('[data-testid="user-menu-trigger"]').click();
    await page.locator('[data-testid="menu-contacts"]').click();
    await page
      .locator('li[data-testid^="bot-card-"]')
      .filter({ hasText: '小明' })
      .locator('[data-testid^="bot-delete-"]')
      .click();
    await expect(page.locator('[data-testid="bot-delete-dialog"]')).toBeVisible();
    await page.locator('[data-testid="bot-delete-confirm"]').click();
    await expect(
      page.locator('li[data-testid^="bot-card-"]').filter({ hasText: '小明' }),
    ).toBeHidden();

    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="settings-dialog"]')).toBeHidden();
    await expect(page.locator('[data-testid="chat-empty"]')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-testid^="conversation-row-"]')).toHaveCount(0);
  } finally {
    await closeSession(session);
  }
});
