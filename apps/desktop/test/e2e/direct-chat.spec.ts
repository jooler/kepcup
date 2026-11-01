import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page, _electron } from '@playwright/test';
import { startMockLlm, step, type MockLlmServer } from '@kepcup/testkit';
import { createBotAndOpenChat } from './helpers/create-bot';
import { rmHomeTolerant } from './helpers/home-cleanup';

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
      TZ: 'Asia/Shanghai',
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

/**
 * 「+」面板的自动展开是启动恢复（bootstrap）的异步尾巴，可能落在测试早期
 * 交互之后；其全屏 backdrop 会拦截后续点击，关键交互前确保它已收起。
 */
async function ensureStartPanelClosed(page: Page): Promise<void> {
  const backdrop = page.locator('[data-testid="start-chat-backdrop"]');
  if (await backdrop.isVisible()) await backdrop.click();
  await expect(backdrop).toHaveCount(0);
}

test('direct send: Enter sends immediately, Cmd+Enter too, reply works', async () => {
  test.setTimeout(180_000);
  const session = await startSession('kepcup-e2e-draft-');
  const { page, llm } = session;
  try {
    await waitReady(page);
    await createBotAndOpenChat(page, '小艾');

    const composer = page.locator('[data-testid="composer-input"]');

    // No messages yet: the composer floats centered; the dock moves to the
    // bottom once the first message exists.
    await expect(page.locator('[data-testid="composer-dock"]')).toHaveAttribute(
      'data-centered',
      'true',
    );

    llm.script('mock-main', [step().replyText('收到，看到了')]);
    await composer.fill('第一条消息');
    await composer.press('Enter');

    await expect(page.locator('[data-testid="user-bubble"]')).toHaveCount(1, { timeout: 15_000 });
    await expect(page.locator('[data-testid="user-bubble"]').first()).toContainText('第一条消息');
    await expect(composer).toHaveText('');
    await expect(page.locator('[data-testid="composer-dock"]')).toHaveAttribute(
      'data-centered',
      'false',
    );
    await expect(page.locator('[data-testid="bot-bubble"]').first()).toContainText('收到，看到了', {
      timeout: 30_000,
    });

    // Cmd/Ctrl+Enter sends the current input immediately as well.
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
  } finally {
    await closeSession(session);
  }
});

test('a send shows the run status without cancel until the reply lands', async () => {
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

    await expect(page.locator('[data-testid="user-bubble"]')).toHaveCount(1, { timeout: 15_000 });
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

    // A follow-up message starts a new run that completes normally.
    await composer.fill('继续吧');
    await composer.press('Meta+Enter');
    await expect(page.locator('[data-testid="user-bubble"]')).toHaveCount(2, { timeout: 15_000 });
    await expect(page.locator('[data-testid="bot-bubble"]').nth(1)).toContainText('第二条回复', {
      timeout: 30_000,
    });
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

test('restart reopens the conversation last viewed (not the most recently messaged)', async () => {
  test.setTimeout(180_000);
  const session = await startSession('kepcup-e2e-restore-');
  const { page, home, llm } = session;
  try {
    await waitReady(page);
    // 先建「小安」再建「小北」：建完各自自动打开。两条会话都没有消息，
    // 旧启发式（最近消息时间）重启后总会选中较新的「小北」。
    await createBotAndOpenChat(page, '小安');
    await createBotAndOpenChat(page, '小北');
    await expect(page.locator('[data-testid="right-panel-toggle"]')).toContainText('小北');

    // 回到「小安」的对话——这是关闭前最后查看的会话。
    await page.locator('[data-testid^="conversation-item-"]').filter({ hasText: '小安' }).click();
    await expect(page.locator('[data-testid="right-panel-toggle"]')).toContainText('小安');

    await session.app.close();

    const relaunched = await launchApp({ home, llmUrl: llm.url, keystore: 'file' });
    try {
      await waitReady(relaunched.page);
      // 恢复的正是上次查看的「小安」，而不是启发式挑出的「小北」。
      await expect(relaunched.page.locator('[data-testid="right-panel-toggle"]')).toContainText(
        '小安',
        { timeout: 15_000 },
      );
    } finally {
      await relaunched.app.close();
    }
  } finally {
    await llm.stop();
    await rmHomeTolerant(home);
  }
});

test('removing the conversation archives it (restorable from the contacts); deleting the bot removes its entry and closes its chat', async () => {
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

    // Remove the conversation from the list (archive): the row disappears and
    // the chat closes, but nothing is deleted — the address book keeps the
    // entry and can restore it.
    await ensureStartPanelClosed(page);
    await page.locator('[data-testid^="conversation-row-"]').first().click({ button: 'right' });
    await page.locator('[data-testid="context-remove-conversation"]').click();
    await expect(page.locator('[data-testid="chat-empty"]')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-testid^="conversation-row-"]')).toHaveCount(0);

    // The address book lists the bot as removed and can restore its chat.
    await page.locator('[data-testid="user-menu-trigger"]').click();
    await page.locator('[data-testid="menu-contacts"]').click();
    const removedBot = page.locator('li[data-testid^="bot-card-"]').filter({ hasText: '小艾' });
    await expect(removedBot.locator('[data-testid^="bot-archived-"]')).toBeVisible();
    await removedBot.locator('[data-testid^="bot-restore-"]').click();
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="settings-page"]')).toBeHidden();
    await expect(page.locator('[data-testid^="conversation-row-"]')).toHaveCount(1);

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
    ).toBeHidden({ timeout: 60_000 });

    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="settings-page"]')).toBeHidden();
    await expect(page.locator('[data-testid="chat-empty"]')).toBeVisible({ timeout: 10_000 });
    // Only 小艾's restored chat is left; 小明's is gone with its bot.
    await expect(page.locator('[data-testid^="conversation-row-"]')).toHaveCount(1);
  } finally {
    await closeSession(session);
  }
});

test('a Markdown table fullscreen covers the app and keeps its toolbar clickable', async () => {
  test.setTimeout(180_000);
  const session = await startSession('kepcup-e2e-table-fullscreen-');
  const { page, llm, app } = session;
  try {
    await waitReady(page);
    await createBotAndOpenChat(page, '表格乙');

    // 右栏开着时，它的顶栏按钮过去会浮在表格全屏之上；全屏期间整栏隐藏。
    await page.locator('[data-testid="right-panel-toggle"]').click();
    const rightPanel = page.locator('[data-testid="right-panel"]');
    await expect(rightPanel).toBeVisible({ timeout: 15_000 });

    llm.script('mock-main', [
      step().replyText('| 名称 | 数量 |\n| --- | --- |\n| 苹果 | 3 |\n| 香蕉 | 5 |'),
    ]);
    const composer = page.locator('[data-testid="composer-input"]');
    await composer.fill('列个表');
    await composer.press('Enter');

    const tableWrapper = page.locator('[data-streamdown="table-wrapper"]');
    await expect(tableWrapper).toBeVisible({ timeout: 60_000 });
    // 表格没有下载必要：工具条只保留复制与全屏。
    await expect(tableWrapper.locator('button[title="Download table"]')).toHaveCount(0);
    const copyButton = tableWrapper.locator('button[title="Copy table"]');
    await expect(copyButton).toBeVisible();

    // 复制菜单 portal 到 body：补 z-index 前会被消息列表压住，选项点不到。
    await copyButton.click();
    const copyMenu = page.locator('#table-download-popover');
    await expect(copyMenu).toBeVisible();
    expect(await copyMenu.evaluate((el) => getComputedStyle(el).zIndex)).toBe('50');
    expect(await copyMenu.evaluate((el) => getComputedStyle(el).paddingTop)).toBe('4px');
    // 每个选项的文字行盒必须完整落在自己的 hover 背景（按钮盒子）内。
    expect(
      await copyMenu.evaluate((el) =>
        Array.from(el.querySelectorAll('button')).every((button) => {
          const box = button.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(button);
          const text = range.getBoundingClientRect();
          return (
            text.top >= box.top &&
            text.bottom <= box.bottom &&
            text.left >= box.left &&
            text.right <= box.right
          );
        }),
      ),
    ).toBe(true);
    const menuBox = await copyMenu.boundingBox();
    expect(menuBox).not.toBeNull();
    expect(
      await page.evaluate(
        ({ x, y }) => document.elementFromPoint(x, y)?.closest('#table-download-popover') !== null,
        { x: menuBox!.x + menuBox!.width / 2, y: menuBox!.y + menuBox!.height / 2 },
      ),
    ).toBe(true);
    await copyMenu.locator('button[title="Copy table as Markdown"]').click();
    await expect(copyMenu).toBeHidden();
    await expect
      .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
      .toContain('苹果');

    await tableWrapper.locator('button[title="View fullscreen"]').click();

    const fullscreen = page.locator('[data-streamdown="table-fullscreen"]');
    await expect(fullscreen).toBeVisible();
    await expect(fullscreen.locator('button[title="Download table"]')).toHaveCount(0);
    const dragBand = page.locator('[data-testid="window-drag-band"]');
    await expect(dragBand).toHaveAttribute('data-active', 'true');
    await expect(rightPanel).toBeHidden();

    // 消息层原本是 z-10 的层叠上下文，会把浮层压在聊天头部 / 输入坞 / 右栏
    //（z-30）之下；全屏期间必须抬到 z-50。
    expect(
      await page.locator('[data-message-layer]').evaluate((el) => getComputedStyle(el).zIndex),
    ).toBe('50');
    // 聊天头部（h-16，顶部）与输入坞（底部）也必须真正被浮层盖住，而不只是
    // 右栏被 display:none 隐藏。
    expect(
      await page.evaluate(() => {
        const hitAt = (x: number, y: number): boolean =>
          document.elementFromPoint(x, y)?.closest('[data-streamdown="table-fullscreen"]') !== null;
        return (
          hitAt(window.innerWidth / 2, 50) && hitAt(window.innerWidth / 2, window.innerHeight - 20)
        );
      }),
    ).toBe(true);
    // 顶栏让出全局拖拽带的 40px，按钮才不在 drag 矩形里（否则真实点击被吞成拖窗口）。
    expect(await fullscreen.evaluate((el) => getComputedStyle(el).paddingTop)).toBe('40px');

    // 全屏工具条里的复制菜单同样要浮在抬到 z-50 的消息层之上。
    await fullscreen.locator('button[title="Copy table"]').click();
    await expect(copyMenu).toBeVisible();
    expect(await copyMenu.evaluate((el) => getComputedStyle(el).zIndex)).toBe('50');
    await copyMenu.locator('button[title="Copy table as CSV"]').click();
    await expect(copyMenu).toBeHidden();

    // 真点击退出：按钮被 drag 矩形盖住时这一步会卡住失败。
    await fullscreen.locator('button[title="Exit fullscreen"]').click();
    await expect(fullscreen).toBeHidden();
    await expect(rightPanel).toBeVisible();
    await expect(dragBand).toHaveAttribute('data-active', 'false');
  } finally {
    await closeSession(session);
  }
});
