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

async function createBot(page: Page, name: string): Promise<void> {
  await page.locator('[data-testid="new-chat-button"]').click();
  await page.locator('[data-testid="bot-create-form"]').click();
  await page.locator('[data-testid="bot-create-dialog"] [data-testid="bot-name-input"]').fill(name);
  await page.locator('[data-testid="bot-create-save"]').click();
  await expect(page.locator('[data-testid="chat-view"]')).toBeVisible({ timeout: 15_000 });
}

/** setup 卡定位：对话内群创建（19/D60）按 step 渲染四问。 */
function groupSetupCard(page: Page, step: string) {
  return page.locator(`[data-testid="group-setup-card"][data-step="${step}"]`);
}

async function createGroupViaUi(page: Page, title: string, memberNames: string[]): Promise<void> {
  await page.locator('[data-testid="new-chat-button"]').click();
  await page.locator('[data-testid="start-chat-create-group"]').click();
  // 对话内创建：名称 → 主要事务 → 成员 → 目录（跳过），零模型调用。
  await expect(groupSetupCard(page, 'title')).toBeVisible({ timeout: 15_000 });
  await groupSetupCard(page, 'title').locator('[data-testid="group-setup-input"]').fill(title);
  await groupSetupCard(page, 'title').locator('[data-testid="group-setup-submit"]').click();

  await expect(groupSetupCard(page, 'purpose')).toBeVisible({ timeout: 15_000 });
  await groupSetupCard(page, 'purpose')
    .locator('[data-testid="group-setup-input"]')
    .fill('协作处理日常事务');
  await groupSetupCard(page, 'purpose').locator('[data-testid="group-setup-submit"]').click();

  await expect(groupSetupCard(page, 'members')).toBeVisible({ timeout: 15_000 });
  for (const name of memberNames) {
    await groupSetupCard(page, 'members')
      .locator('label', { hasText: name })
      .locator('button[role="checkbox"]')
      .click();
  }
  await groupSetupCard(page, 'members').locator('[data-testid="group-setup-submit"]').click();

  await expect(groupSetupCard(page, 'project')).toBeVisible({ timeout: 15_000 });
  await groupSetupCard(page, 'project').locator('[data-testid="group-setup-skip"]').click();

  // Wait for the sidebar entry (finalized title) so later clicks hit the group.
  await expect(page.locator('[data-testid="conversation-name"]', { hasText: title })).toBeVisible({
    timeout: 15_000,
  });
}

/** Types text with an @ mention picked from the popup (keyboard Enter). */
async function mentionAndType(page: Page, botName: string, text: string): Promise<void> {
  const composer = page.locator('[data-testid="composer-input"]');
  await composer.click();
  await composer.pressSequentially(`@${botName}`);
  const candidate = page
    .locator('[data-testid="mention-popup"] button')
    .filter({ hasText: botName })
    .first();
  await expect(candidate).toBeVisible({ timeout: 5_000 });
  // 弹层打开时回车是「确认提及目标」，不得把消息推入待发送队列。
  await composer.press('Enter');
  await composer.pressSequentially(text);
}

test('group chat: create, @ mention, reply-quote, turn status, no-claim click', async () => {
  test.setTimeout(240_000);
  const session = await startSession('kepcup-e2e-group-');
  const { page, llm } = session;
  try {
    await waitReady(page);
    await createBot(page, '阿甲');
    await createBot(page, '阿乙');
    await createGroupViaUi(page, '项目讨论组', ['阿甲', '阿乙']);

    // Right panel shows the group info and member cards（右栏默认收起，先展开）。
    if (!(await page.locator('[data-testid="group-info"]').isVisible())) {
      await page.locator('[data-testid="right-panel-toggle"]').click();
    }
    await expect(page.locator('[data-testid="group-info"]')).toBeVisible();
    await expect(page.locator('[data-testid="group-info-title"]')).toHaveText('项目讨论组');
    await expect(page.locator('[data-testid^="group-member-card-"]')).toHaveCount(2);

    const composer = page.locator('[data-testid="composer-input"]');

    // --- @ mention: popup, input highlight, only the mentioned bot answers ---
    llm.script('mock-main', [
      step()
        .expect((r) => JSON.stringify(r.body.messages).includes('名字：阿甲'))
        .replyText('阿甲收到'),
    ]);
    // 输入框内提及交互：高亮着色 + Backspace 一次删掉整个 @XXX（先吃分隔
    // 空格，再删节点），触发符 @ 保留且弹层立刻重开，可继续选目标。
    await composer.click();
    await composer.pressSequentially('@阿甲');
    await page
      .locator('[data-testid="mention-popup"] button')
      .filter({ hasText: '阿甲' })
      .first()
      .click();
    await expect(page.locator('[data-testid="composer-mention"]')).toHaveText('@阿甲');
    await composer.press('Backspace');
    await composer.press('Backspace');
    await expect(composer).toHaveText('@');
    await expect(page.locator('[data-testid="mention-popup"]').first()).toBeVisible();
    // 再退格删掉触发符，回到空输入后重新提及发送。
    await composer.press('Backspace');
    await expect(composer).toHaveText('');
    await mentionAndType(page, '阿甲', ' 帮我看个问题');
    await expect(page.locator('[data-testid="composer-mention"]')).toHaveText('@阿甲');
    await composer.press('Meta+Enter');
    await expect(page.locator('[data-testid="user-bubble"]').first()).toContainText(
      '帮我看个问题',
      {
        timeout: 15_000,
      },
    );
    // 发送后的用户气泡里 @ 部分有独立样式（mention pill span）。
    await expect(
      page.locator('[data-testid="user-bubble"]').first().locator('[data-testid="user-mention"]'),
    ).toHaveText('@阿甲');
    await expect(page.locator('[data-testid="bot-bubble"]').first()).toContainText('阿甲收到', {
      timeout: 30_000,
    });

    // --- 引用回复: hover quote button, reply preview, quoted line ------------
    llm.script('mock-main', [
      step()
        .expect((r) => JSON.stringify(r.body.messages).includes('名字：阿甲'))
        .replyText('引用也给我'),
    ]);
    // 引用按钮随行 hover 出现（用户/Bot 消息都有），定位到 bot 消息所在行。
    const quotedRow = page
      .locator('[data-testid^="message-"][role="group"]')
      .filter({ has: page.locator('[data-testid="bot-bubble"]') })
      .first();
    await quotedRow.hover();
    await quotedRow.locator('[data-testid="message-quote"]').click();
    await expect(page.locator('[data-testid="reply-preview"]')).toBeVisible();
    await composer.click();
    await composer.pressSequentially('就按这个继续');
    await composer.press('Meta+Enter');
    await expect(page.locator('[data-testid="quoted-line"]').first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator('[data-testid="bot-bubble"]').nth(1)).toContainText('引用也给我', {
      timeout: 30_000,
    });

    // --- 轮次状态: A running while B queued ----------------------------------
    llm.script('mock-main', [
      step()
        .expect((r) => JSON.stringify(r.body.messages).includes('名字：阿甲'))
        .hold()
        .replyText('甲先答'),
      step()
        .expect((r) => JSON.stringify(r.body.messages).includes('名字：阿甲'))
        .replyText('甲补充'),
      step()
        .expect((r) => JSON.stringify(r.body.messages).includes('名字：阿乙'))
        .replyText('乙再答'),
    ]);
    await mentionAndType(page, '阿甲', ' 第一个问题');
    await composer.press('Enter');
    await mentionAndType(page, '阿乙', ' 第二个问题');
    await composer.press('Enter');
    await composer.press('Meta+Enter');

    const status = page.locator('[data-testid="group-turn-status"]');
    await expect(status).toBeVisible({ timeout: 15_000 });
    await expect(status).toHaveAttribute('data-phase', 'running');
    await expect(status).toContainText('阿甲');
    await expect(status).toContainText('阿乙');

    llm.releaseAll();
    await expect(page.locator('[data-testid="bot-bubble"]').nth(2)).toContainText('甲先答', {
      timeout: 30_000,
    });
    await expect(page.locator('[data-testid="bot-bubble"]').nth(3)).toContainText('乙再答', {
      timeout: 30_000,
    });
    await expect(page.locator('[data-testid="group-turn-status"]')).toHaveCount(0, {
      timeout: 15_000,
    });

    // --- 全员静默: system message with clickable bots -------------------------
    llm.script('mock-light', [
      step()
        .expect((r) => r.lastUserText().includes('你的名片：阿甲'))
        .replyJson({ decision: 'not_mine', confidence: 0.5, reason: '不归我' }),
      step()
        .expect((r) => r.lastUserText().includes('你的名片：阿乙'))
        .replyJson({ decision: 'not_mine', confidence: 0.5, reason: '不归我' }),
    ]);
    llm.script('mock-main', [
      step()
        .expect((r) => JSON.stringify(r.body.messages).includes('名字：阿甲'))
        .replyText('好吧我来处理'),
    ]);
    await composer.click();
    await composer.pressSequentially('这个问题总得有人处理吧');
    await composer.press('Meta+Enter');

    const noClaim = page.locator('[data-testid="no-claim-bots"]');
    await expect(noClaim).toBeVisible({ timeout: 30_000 });
    await noClaim.locator('button', { hasText: '阿甲' }).click();
    await expect(page.locator('[data-testid="bot-bubble"]').last()).toContainText('好吧我来处理', {
      timeout: 30_000,
    });
  } finally {
    await closeSession(session);
  }
});

test('group settings: rename, member management, delete', async () => {
  test.setTimeout(240_000);
  const session = await startSession('kepcup-e2e-group-settings-');
  const { page, llm } = session;
  try {
    await waitReady(page);
    await createBot(page, '阿甲');
    await createBot(page, '阿乙');
    await createGroupViaUi(page, '旧群名', ['阿甲', '阿乙']);
    // 右栏（群信息）默认收起，先经顶部药丸展开，后续改名/成员管理断言用它。
    if (!(await page.locator('[data-testid="group-info"]').isVisible())) {
      await page.locator('[data-testid="right-panel-toggle"]').click();
    }

    // One exchange so a message from 阿甲 exists before its removal.
    llm.script('mock-main', [
      step()
        .expect((r) => JSON.stringify(r.body.messages).includes('名字：阿甲'))
        .replyText('旧消息'),
    ]);
    await mentionAndType(page, '阿甲', ' 留个历史');
    await page.locator('[data-testid="composer-input"]').press('Meta+Enter');
    const oldBubble = page.locator('[data-testid="bot-bubble"]').first();
    await expect(oldBubble).toContainText('旧消息', { timeout: 30_000 });
    // 群聊消息保留发送者头像（UI 改版：名字/时间行已移除，头像即身份）。
    await expect(page.locator('[data-testid="bot-avatar"]').first()).toBeVisible();

    // Open group settings from the sidebar item menu.
    await page
      .locator('li', { hasText: '旧群名' })
      .locator('[data-testid^="conversation-row-"]')
      .click({ button: 'right' });
    await page.locator('[data-testid="context-group-settings"]').click();
    await expect(page.locator('[data-testid="group-settings-dialog"]')).toBeVisible();

    // Rename.
    await page.locator('[data-testid="group-rename-input"]').fill('新群名');
    await page.locator('[data-testid="group-rename-save"]').click();
    await expect(page.locator('[data-testid="group-info-title"]')).toHaveText('新群名', {
      timeout: 10_000,
    });

    // Add a member (create one more bot first).
    await page.keyboard.press('Escape');
    await createBot(page, '阿丙');
    await page
      .locator('li', { hasText: '新群名' })
      .locator('[data-testid^="conversation-row-"]')
      .click({ button: 'right' });
    await page.locator('[data-testid="context-group-settings"]').click();
    await page.locator('[data-testid="group-add-member-select"]').selectOption({ label: '阿丙' });
    await page.locator('[data-testid="group-add-member-confirm"]').click();
    await expect(page.locator('[data-testid="group-member-list"] li')).toHaveCount(3, {
      timeout: 10_000,
    });

    // Remove a member (joined first -> 阿甲).
    await page.locator('[data-testid^="group-member-remove-"]').first().click();
    await expect(page.locator('[data-testid="group-member-list"] li')).toHaveCount(2, {
      timeout: 10_000,
    });
    // History of the removed member stays renderable (avatar kept, no name row).
    await expect(oldBubble).toContainText('旧消息');
    await expect(page.locator('[data-testid="bot-avatar"]').first()).toBeVisible();

    // Delete the whole group (two-step confirm).
    await page.keyboard.press('Escape');
    await page
      .locator('li', { hasText: '新群名' })
      .locator('[data-testid^="conversation-row-"]')
      .click({ button: 'right' });
    await page.locator('[data-testid="context-group-settings"]').click();
    await page.locator('[data-testid="group-delete-begin"]').click();
    await page.locator('[data-testid="group-delete-confirm"]').click();
    await expect(page.locator('[data-testid="chat-empty"]')).toBeVisible({ timeout: 15_000 });
    // The group disappears from the sidebar; the members' direct chats remain.
    await expect(page.locator('li', { hasText: '新群名' })).toHaveCount(0);
  } finally {
    await closeSession(session);
  }
});
