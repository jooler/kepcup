import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { startMockLlm, step, type MockLlmServer } from '@kepcup/testkit';

/**
 * 对话式新建 Bot（UI 改版，参考 Grok Bot）：侧栏「+」→「新建 Bot」→
 * 不弹表单、直接进入对话；core 确定性下发问候 + 固定首问卡片（4 个预置
 * 候选 + 自定义输入）→ 点选候选先被目录闸门扣下（19/D59：插入工作目录
 * 卡，暂不设置后缓冲消息才触发响应 run）→ Bot（mock LLM）用 ask_question
 * 出第二张问题卡片 → 自定义输入提交 → save_profile / finish_setup 收尾
 * （名字实时更新到侧栏与顶部药丸）。
 */

async function startSession(prefix: string): Promise<{
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
      KEPCUP_HOME: home,
      NODE_ENV: 'test',
      KEPCUP_KEYSTORE: 'file',
      KEPCUP_ONBOARDING: 'off',
      KEPCUP_FILE_KEYSTORE_PATH: path.join(home, '.test-master-key'),
      KEPCUP_MOCK_LLM_URL: llm.url,
    },
  });
  const page = await app.firstWindow();
  await expect(page.locator('[data-testid="app-shell"]')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('[data-testid="ping-result"]')).toContainText('ping ✓', {
    timeout: 60_000,
  });
  // 等启动恢复收尾（与 avatar.spec.ts 同款防护）：ping ✓ 早于 bootstrap 结束，
  // 空态下 App 会自动展开「+」面板，其全屏 backdrop 会拦截 new-chat-button
  // 的首次点击。收尾后确保 backdrop 已收起（面板只开一次，收掉不再出现）。
  await expect(page.locator('[data-testid="start-chat-panel"]')).toBeVisible({ timeout: 60_000 });
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
      await rm(home, { recursive: true, force: true });
    },
  };
}

test('conversational create: fixed first question card, option/custom answers, profile saved', async () => {
  test.setTimeout(240_000);
  const session = await startSession('kepcup-e2e-setup-');
  const { page, llm } = session;
  try {
    // 侧栏「+」→ 开始对话面板 → 新建 Bot（对话式，无表单）。
    await page.locator('[data-testid="new-chat-button"]').click();
    await expect(page.locator('[data-testid="start-chat-panel"]')).toBeVisible();
    await expect(page.locator('[data-testid="bot-create-form"]')).toBeVisible(); // 高级新建也是「+」面板的入口
    await page.locator('[data-testid="start-chat-create-bot"]').click();

    // 直接落到新 Bot 的对话：问候气泡 + 固定首问卡片（占位名）。
    await expect(page.locator('[data-testid="chat-view"]')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid="conversation-name"]').first()).toHaveText('新 Bot', {
      timeout: 15_000,
    });
    const firstCard = page.locator('[data-testid="setup-question-card"]').first();
    await expect(firstCard).toBeVisible({ timeout: 30_000 });
    await expect(
      page.locator('[data-testid="bot-bubble"]').filter({ hasText: '你好' }).first(),
    ).toBeVisible();
    await expect(firstCard.locator('[data-testid="setup-question-text"]')).toHaveText(
      '您希望我协助您处理哪些事务？',
    );
    await expect(firstCard.locator('[data-testid^="setup-option-"]')).toHaveCount(4);
    await expect(firstCard.locator('[data-testid="setup-option-0"]')).toHaveText('写作与文档');
    await expect(firstCard.locator('[data-testid="setup-custom-input"]')).toBeVisible();

    // Bot（mock LLM）确认 + ask_question 出第二张问题卡片。脚本必须先于
    // 触发动作就位：首答会被目录闸门扣下（19/D59——core 先插入确定性的
    // 工作目录卡，跳过后缓冲消息才一起触发响应 run），mock 对无脚本的
    // 请求会 fail loudly（run 直接失败，第二张卡不会出现）。
    llm.script('mock-main', [
      step().replyToolCall('ask_question', {
        acknowledgement: '好，我来当你的写作助手。',
        question: '你希望我叫什么名字？',
        options: ['小启', '阿文', '笔杆'],
      }),
    ]);
    await firstCard.locator('[data-testid="setup-option-0"]').click();
    await expect(firstCard).toHaveAttribute('data-answered', 'true');
    await expect(firstCard.locator('[data-testid="setup-answer"]')).toHaveText('写作与文档');
    await expect(firstCard.locator('[data-testid^="setup-option-"]')).toHaveCount(0);
    await expect(firstCard.locator('[data-testid="setup-custom-input"]')).toHaveCount(0);

    // 工作目录卡（19/D59）：确定性插入、无候选；未答期间输入被禁用。
    // 跳过（「暂不设置」）后首个响应 run 才开始。
    const pathCard = page.locator('[data-testid="setup-path-card"]');
    await expect(pathCard).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid="composer-readonly"]')).toBeVisible();
    await pathCard.locator('[data-testid="setup-path-skip"]').click();
    await expect(pathCard).toHaveAttribute('data-answered', 'true');
    await expect(pathCard.locator('[data-testid="setup-path-answer"]')).toHaveText(
      '暂不设置工作目录',
    );

    const secondCard = page.locator('[data-testid="setup-question-card"]').nth(1);
    await expect(secondCard).toBeVisible({ timeout: 60_000 });
    await expect(secondCard.locator('[data-testid="setup-question-text"]')).toHaveText(
      '你希望我叫什么名字？',
    );
    await expect(
      page.locator('[data-testid="bot-bubble"]').filter({ hasText: '写作助手' }).first(),
    ).toBeVisible();

    // 顶部药丸显示占位名；展开右栏确认面板正常。
    await expect(page.locator('[data-testid="right-panel-toggle"]')).toContainText('新 Bot');

    // 第二问走自定义输入：回车提交。
    llm.script('mock-main', [
      step().replyToolCall('save_profile', {
        changes: [
          { field: 'identity.name', value: '小启' },
          { field: 'role.responsibilities', value: '跟进每日写作' },
        ],
      }),
      step().replyToolCall('finish_setup', {}),
      step().replyText('好的，我是小启，以后每天帮你跟进写作。'),
    ]);
    const customInput = secondCard.locator('[data-testid="setup-custom-input"]');
    await customInput.fill('就叫小启');
    await customInput.press('Enter');
    await expect(secondCard.locator('[data-testid="setup-answer"]')).toHaveText('就叫小启');

    // 访谈收尾：名字一次性生效到顶部药丸与标题（访谈中 save_profile 的
    // identity.name 不改展示名，finish_setup 才切换）。
    await expect(
      page.locator('[data-testid="bot-bubble"]').filter({ hasText: '我是小启' }).first(),
    ).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('[data-testid="conversation-name"]').first()).toHaveText('小启', {
      timeout: 15_000,
    });
    await expect(page.locator('[data-testid="right-panel-toggle"]')).toContainText('小启');

    // 三张卡片都转已答态；全程没有用户消息气泡（setupAnswer 消息不渲染）。
    await expect(secondCard).toHaveAttribute('data-answered', 'true');
    await expect(page.locator('[data-testid="user-bubble"]')).toHaveCount(0);
  } finally {
    await session.close();
  }
});
