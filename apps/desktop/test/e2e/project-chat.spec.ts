import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page, _electron } from '@playwright/test';
import { startMockLlm, step, type MockLlmServer } from '@kepcup/testkit';
import { createBotAndOpenChat, openConversationByName, rpc } from './helpers/create-bot';
import { createProjectViaUi } from './helpers/create-project';
import { rmHomeTolerant } from './helpers/home-cleanup';

/**
 * 项目组沟通（D92 T1a WP8）：创建、@ 提及、引用回复、轮次状态行；详情页的
 * 改名 / 目标 / 成员 / 负责人 / 删除。全员静默的点选（no-claim）已随路由重写
 * 移除（WP3），不再覆盖。
 */

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
  // 弹层打开时回车是「确认提及目标」，不得把消息直接发送出去。
  await composer.press('Enter');
  await composer.pressSequentially(text);
}

test('project chat: create, @ mention, reply-quote, turn status', async () => {
  test.setTimeout(240_000);
  const session = await startSession('kepcup-e2e-project-chat-');
  const { page, llm } = session;
  try {
    await waitReady(page);
    await createBotAndOpenChat(page, '阿甲');
    await createBotAndOpenChat(page, '阿乙');
    await createProjectViaUi(page, '项目讨论组', ['阿甲', '阿乙']);

    // 项目组外壳已就位：两行顶栏 + 模块 tab；右栏与单聊药丸不再渲染。
    await expect(page.locator('[data-testid="project-header"]')).toBeVisible();
    await expect(page.locator('[data-testid="project-tabs"]')).toBeVisible();
    await expect(page.locator('[data-testid="right-panel-toggle"]')).toHaveCount(0);

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
    // 第二条 @ 在阿甲的轮次进行中到达：作为待处理批次排队，轮次结束后接续。
    await mentionAndType(page, '阿乙', ' 第二个问题');
    await composer.press('Enter');

    const status = page.locator('[data-testid="project-turn-status"]');
    await expect(status).toBeVisible({ timeout: 15_000 });
    await expect(status).toHaveAttribute('data-phase', 'running');
    await expect(status).toContainText('阿甲');

    llm.releaseAll();
    await expect(page.locator('[data-testid="bot-bubble"]').nth(2)).toContainText('甲先答', {
      timeout: 30_000,
    });
    await expect(page.locator('[data-testid="bot-bubble"]').nth(3)).toContainText('乙再答', {
      timeout: 30_000,
    });
    await expect(page.locator('[data-testid="project-turn-status"]')).toHaveCount(0, {
      timeout: 15_000,
    });
  } finally {
    await closeSession(session);
  }
});

test('project settings: rename, goal, members, set lead, delete', async () => {
  test.setTimeout(240_000);
  const session = await startSession('kepcup-e2e-project-settings-');
  const { page, llm } = session;
  try {
    await waitReady(page);
    const alpha = await createBotAndOpenChat(page, '阿甲');
    const beta = await createBotAndOpenChat(page, '阿乙');
    await createProjectViaUi(page, '旧项目名', ['阿甲', '阿乙']);

    // 经 ⚙ 打开详情页（内容区页面，不是弹框；master-detail 默认落在「概览」）。
    await page.locator('[data-testid="project-settings-button"]').click();
    const settingsPage = page.locator('[data-testid="project-settings-page"]');
    await expect(settingsPage).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid="project-settings-section-overview"]')).toBeVisible();
    await expect(page.locator('[data-testid="project-view"]')).toHaveAttribute(
      'data-view',
      'settings',
    );

    // Rename（回车保存，侧栏当前会话名即时更新）。
    const titleInput = page.locator('[data-testid="project-title-input"]');
    await titleInput.fill('新项目名');
    await titleInput.press('Enter');
    await expect(
      page.locator(
        '[data-testid^="conversation-item-"][data-active="true"] [data-testid="conversation-name"]',
      ),
    ).toContainText('新项目名', {
      timeout: 10_000,
    });

    // Goal：填写后自动保存（无保存按钮），经 RPC 核对落库。
    await page.locator('[data-testid="project-goal-input"]').fill('把官网改版做完');
    await expect(page.locator('[data-testid="project-goal-save"]')).toHaveCount(0);
    await expect
      .poll(
        async () => {
          const { conversations } = (await rpc(page, 'conversations.list')) as {
            conversations: Array<{ title: string | null; goal: string | null }>;
          };
          return conversations.find((c) => c.title === '新项目名')?.goal ?? null;
        },
        { timeout: 10_000 },
      )
      .toBe('把官网改版做完');

    // One exchange so a message from 阿甲 exists before member churn.
    llm.script('mock-main', [
      step()
        .expect((r) => JSON.stringify(r.body.messages).includes('名字：阿甲'))
        .replyText('旧消息'),
    ]);
    await page.locator('[data-testid="project-tab-chat"]').click();
    await expect(page.locator('[data-testid="project-view"]')).toHaveAttribute(
      'data-view',
      'chat',
      { timeout: 15_000 },
    );
    const composer = page.locator('[data-testid="composer-input"]');
    await mentionAndType(page, '阿甲', ' 留个历史');
    await composer.press('Enter');
    const oldBubble = page.locator('[data-testid="bot-bubble"]').first();
    await expect(oldBubble).toContainText('旧消息', { timeout: 30_000 });
    // 项目组消息保留发送者头像（头像即身份，UI 改版后无名字行）。
    await expect(page.locator('[data-testid="bot-avatar"]').first()).toBeVisible();

    // 添加成员：新建 阿丙，回到项目详情页，用底部选择器搜索加入。
    const gammaId = await (async () => {
      await createBotAndOpenChat(page, '阿丙');
      const { bots } = (await rpc(page, 'bots.list')) as {
        bots: Array<{ id: string; name: string }>;
      };
      return bots.find((bot) => bot.name === '阿丙')?.id ?? '';
    })();
    await openConversationByName(page, '新项目名');
    await page.locator('[data-testid="project-settings-button"]').click();
    await expect(settingsPage).toBeVisible({ timeout: 15_000 });
    // master-detail：同屏只渲染当前分区，成员操作先经导航切到「成员」。
    await page.locator('[data-testid="project-settings-nav-members"]').click();
    await expect(page.locator('[data-testid="project-settings-section-members"]')).toBeVisible();
    const memberRows = page.locator(
      '[data-testid="project-member-list"] [data-testid^="project-member-row-"]',
    );
    await expect(memberRows).toHaveCount(2);
    const memberAdd = page.locator('[data-testid="project-member-add"]');
    await memberAdd.fill('阿丙');
    await page
      .locator('[data-testid^="project-member-add-option-"]')
      .filter({ hasText: '阿丙' })
      .click();
    await expect(memberRows).toHaveCount(3, { timeout: 10_000 });
    // 被移出成员的历史消息仍可渲染（头像保留）。
    await expect(oldBubble).toContainText('旧消息');

    // 设为负责人：阿乙 接任；负责人的移出按钮置灰，旧负责人恢复可移出。
    await page.locator(`[data-testid="project-make-lead-${beta.botId}"]`).click();
    await expect(
      page.locator(`[data-testid="project-member-remove-${beta.botId}"]`),
    ).toBeDisabled();
    await expect(
      page.locator(`[data-testid="project-member-remove-${alpha.botId}"]`),
    ).toBeEnabled();

    // 移出成员：阿丙（非负责人）移出后成员行回到 2。
    await page.locator(`[data-testid="project-member-remove-${gammaId}"]`).click();
    await expect(memberRows).toHaveCount(2, { timeout: 10_000 });

    // 负责人更换反映在「概览」的负责人卡片：切回概览核对。
    await page.locator('[data-testid="project-settings-nav-overview"]').click();
    const overview = page.locator('[data-testid="project-settings-section-overview"]');
    await expect(overview).toBeVisible();
    await expect(overview).toContainText('阿乙', { timeout: 10_000 });
    await expect(overview.locator('[data-testid="project-lead-badge"]')).toBeVisible();

    // 删除项目组在「其它」分区的危险区卡片（两步确认）回到空态；成员的私聊仍在侧栏。
    await page.locator('[data-testid="project-settings-nav-danger"]').click();
    await expect(page.locator('[data-testid="project-settings-section-danger"]')).toBeVisible();
    await page.locator('[data-testid="project-delete-begin"]').click();
    await expect(page.locator('[data-testid="project-delete-confirm-box"]')).toBeVisible();
    await page.locator('[data-testid="project-delete-confirm"]').click();
    await expect(page.locator('[data-testid="chat-empty"]')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('li', { hasText: '新项目名' })).toHaveCount(0);
    await expect(
      page.locator('[data-testid="conversation-name"]').filter({ hasText: '阿甲' }),
    ).toHaveCount(1);
  } finally {
    await closeSession(session);
  }
});
