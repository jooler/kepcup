import { mkdtemp } from 'node:fs/promises';
import { rmHomeTolerant } from './helpers/home-cleanup';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { startMockLlm, step, type MockLlmServer } from '@kepcup/testkit';
import { createBotAndOpenChat, openConversationByName, rpc } from './helpers/create-bot';

/**
 * D70 回归（首启向导 → 管家访谈 → 组队提议 → 确认 → 左栏即时出现新 Bot）：
 * butler_proposal 确认后 core 只以 conversation.updated 事件推送新私聊，而
 * 事件负载是裸 domain 会话（无 bot 视图字段）——渲染端不得把它当已删除
 * 丢弃，否则出现「管家报告创建成功、左栏却没有新条目」。全程 mock LLM。
 */

const PROPOSED_BOT = {
  name: '文书',
  bio: '起草与润色文档',
  expertise: '写作',
  responsibilities: '周报、方案与邮件的起草和润色',
  reason: '你选择了工作：写作、文档与汇报',
};

async function startSession(
  prefix: string,
  options: { onboardingOff?: boolean } = {},
): Promise<{
  page: Page;
  llm: MockLlmServer;
  home: string;
  close: () => Promise<void>;
}> {
  const llm = await startMockLlm();
  const home = await mkdtemp(path.join(tmpdir(), prefix));
  const { _electron } = await import('@playwright/test');
  const app = await _electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      TZ: 'Asia/Shanghai',
      KEPCUP_HOME: home,
      NODE_ENV: 'test',
      KEPCUP_KEYSTORE: 'file',
      KEPCUP_FILE_KEYSTORE_PATH: path.join(home, '.test-master-key'),
      KEPCUP_MOCK_LLM_URL: llm.url,
      // P13-B e2e seam：非引导用例不出现首启向导（原用例走向导，不开）。
      ...(options.onboardingOff === true ? { KEPCUP_ONBOARDING: 'off' } : {}),
    },
  });
  const page = await app.firstWindow();
  await expect(page.locator('[data-testid="app-shell"]')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('[data-testid="ping-result"]')).toContainText('ping ✓', {
    timeout: 60_000,
  });
  // 等启动恢复收尾（同 onboarding.spec）：ping ✓ 早于 bootstrap 结束；空态
  // 「+」面板的全屏 backdrop 会拦截后续点击，收尾后确保它已收起。
  await expect(
    page
      .locator('[data-testid="chat-view"]')
      .or(page.locator('[data-testid="start-chat-panel"]'))
      .or(page.locator('[data-testid="onboarding"]')),
  ).toBeVisible({ timeout: 60_000 });
  const startBackdrop = page.locator('[data-testid="start-chat-backdrop"]');
  if (await startBackdrop.isVisible()) {
    await startBackdrop.click({ timeout: 2_000 }).catch(() => {});
  }
  return {
    page,
    llm,
    home,
    close: async () => {
      await app.close();
      await llm.stop();
      await rmHomeTolerant(home);
    },
  };
}

test('butler proposal confirm: the new bot lands in the sidebar without a restart', async () => {
  test.setTimeout(240_000);
  const session = await startSession('kepcup-e2e-butler-proposal-');
  const { page, llm } = session;
  try {
    // 首启向导（同 onboarding.spec 的模型直存路径）走到「认识管家」。
    const wizard = page.locator('[data-testid="onboarding"]');
    await expect(wizard).toBeVisible({ timeout: 30_000 });
    await page.locator('[data-testid="onboarding-start"]').click();
    await expect(wizard).toHaveAttribute('data-step', 'model');
    await page.locator('[data-testid="onboarding-provider-select"]').selectOption('custom:mock');
    await page.locator('[data-testid="onboarding-key-input"]').fill('sk-onboarding-e2e');
    await page.locator('[data-testid="onboarding-model-save"]').click();
    await expect(wizard).toHaveAttribute('data-step', 'permissions');
    await page.locator('[data-testid="onboarding-next"]').click();
    await expect(wizard).toHaveAttribute('data-step', 'sandbox');
    await expect(page.locator('[data-testid="onboarding-sandbox-state"]')).toContainText(
      process.platform === 'win32' ? 'wsl' : 'srt',
      { timeout: 30_000 },
    );
    await page.locator('[data-testid="onboarding-next"]').click();

    // ⑤ 认识管家：建立唯一管家并进入组队访谈，首问卡由 core 确定性下发。
    await expect(wizard).toHaveAttribute('data-step', 'bot');
    await page.locator('[data-testid="onboarding-butler-start"]').click();
    await expect(wizard).toBeHidden({ timeout: 15_000 });
    await expect(page.locator('[data-testid="chat-view"]')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid="conversation-name"]').first()).toHaveText('管家');
    const firstCard = page.locator('[data-testid="setup-question-card"]').first();
    await expect(firstCard).toBeVisible({ timeout: 30_000 });

    // 首答触发首个响应 run：mock 管家直接提议一个新 Bot（非阻塞审批卡）。
    llm.script('mock-main', [
      step().replyToolCall('propose_bot', { bot: PROPOSED_BOT, note: '按你选的方向' }),
    ]);
    // 首问是多选卡：勾一项再提交。
    await firstCard.locator('[data-testid="setup-question-check-1"]').click();
    await firstCard.locator('[data-testid="setup-question-submit"]').click();

    const card = page.locator(
      '[data-testid^="approval-card-"][data-approval-kind="butler_proposal"]',
    );
    await expect(card).toBeVisible({ timeout: 60_000 });
    // 确认前：左栏只有管家一个条目。
    await expect(page.locator('[data-testid^="conversation-item-"]')).toHaveCount(1);

    // 确认提议：core 确定性创建（bot.updated + 新私聊的 conversation.updated）。
    llm.script('mock-main', [step().replyText('文书已经建好了，去左栏找它聊吧。')]);
    await card.locator('[data-testid="approval-approve"]').click();

    // 回归断言：新 Bot 的私聊不经重启直接进左栏（此前被渲染端当已删除丢弃）。
    await expect(
      page.locator('[data-testid="conversation-name"]').filter({ hasText: '文书' }),
    ).toHaveCount(1, { timeout: 30_000 });
    // 管家收到 internal follow-up 并向用户复述结果（用户看到的「创建成功」）。
    await expect(
      page.locator('[data-testid="bot-bubble"]').filter({ hasText: '文书已经建好了' }).first(),
    ).toBeVisible({ timeout: 60_000 });
  } finally {
    await session.close();
  }
});

test('butler propose_project: lead can be changed on the card before approving', async () => {
  test.setTimeout(240_000);
  const session = await startSession('kepcup-e2e-butler-project-', { onboardingOff: true });
  const { page, llm } = session;
  try {
    // startSession 已等到 bootstrap 收尾（backdrop 已收）。
    const alpha = await createBotAndOpenChat(page, '阿甲');
    const beta = await createBotAndOpenChat(page, '阿乙');
    // 管家（D70）：不经首启向导，直接 ensure 一个普通管家并打开其私聊。
    await rpc(page, 'butler.ensure', {});
    await openConversationByName(page, '管家');

    // 管家提议建项目组（D92 T1a）：默认负责人 阿甲。
    llm.script('mock-main', [
      step().replyToolCall('propose_project', {
        title: '内容协作组',
        goal: '围绕内容协作：选题、写作与发布',
        lead_bot_id: alpha.botId,
        member_bot_ids: [alpha.botId, beta.botId],
        reason: '两人的职责互补',
      }),
    ]);
    const composer = page.locator('[data-testid="composer-input"]');
    await composer.fill('帮我组一个项目组');
    await composer.press('ControlOrMeta+Enter');

    // 提议卡：项目组名称 / 目标 / 负责人下拉（默认提议的 阿甲）/ 成员。
    const card = page.locator(
      '[data-testid^="approval-card-"][data-approval-kind="butler_proposal"]',
    );
    await expect(card).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('[data-testid="approval-butler-project"]')).toBeVisible();
    await expect(page.locator('[data-testid="approval-butler-project-title"]')).toHaveText(
      '内容协作组',
    );
    const leadSelect = page.locator('[data-testid="approval-butler-project-lead"]');
    await expect(leadSelect).toHaveValue(alpha.botId);

    // 批准前把负责人改成 阿乙：decide 带 leadBotId，建出的项目组负责人是改后的。
    await leadSelect.selectOption(beta.botId);
    await expect(leadSelect).toHaveValue(beta.botId);
    llm.script('mock-main', [step().replyText('项目组已经按新负责人建好了。')]);
    await card.locator('[data-testid="approval-approve"]').click();

    await expect
      .poll(
        async () => {
          const { conversations } = (await rpc(page, 'conversations.list')) as {
            conversations: Array<{
              id: string;
              type: string;
              title: string | null;
              leadBotId: string | null;
            }>;
          };
          return (
            conversations.find(
              (conversation) =>
                conversation.type === 'project' && conversation.title === '内容协作组',
            ) ?? null
          );
        },
        { timeout: 30_000 },
      )
      .toMatchObject({ leadBotId: beta.botId });
  } finally {
    await session.close();
  }
});
