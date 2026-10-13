import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page, _electron } from '@playwright/test';
import { startMockLlm, step, type MockChatRequest, type MockLlmServer } from '@kepcup/testkit';

/**
 * 对话内设置卡（todo/conversational-app-setup.md §六，P0「e2e 一条：卡片 → 应用 → Bot 续答」）。
 * 走真实 core：脚本化的模型在真实的响应 run 里调用 settings_change，宿主按目录 + 上下文裁定档位：
 *
 * ① 单聊、用户本人直接发起 → 白名单项（默认主模型）direct：宿主立即改、出回执卡
 *    「原来 → 现在」；点「撤销」经同一套 CAS 写回，卡片标 reverted（不唤醒 Bot）。
 * ② 群聊 → 同一类白名单项（默认轻量模型）被收紧为 confirm：卡片展示「当前 → 建议」，
 *    在卡上「应用」（settings.items.apply，expected = 出卡时的当前值）→ 卡片标 applied，
 *    宿主写 setting_card_resolved 唤醒该 Bot 续答。
 *
 * mock 模型 = KEPCUP_MOCK_LLM_URL 自动配置的 custom:mock（mock-main / mock-light）。
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

/** 反思（记忆整理）请求：与对话轮请求分开匹配，不抢对话的脚本步。 */
function isReflection(req: MockChatRequest): boolean {
  return JSON.stringify(req.body).includes('runSummary');
}

function reflections(count: number) {
  return Array.from({ length: count }, () =>
    step().expect(isReflection).replyJson(emptyReflection()),
  );
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
  return { app, page, home, llm };
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
}

async function createBot(page: Page, name: string): Promise<void> {
  await page.locator('[data-testid="new-chat-button"]').click();
  await page.locator('[data-testid="bot-create-form"]').click();
  await page.locator('[data-testid="bot-create-dialog"] [data-testid="bot-name-input"]').fill(name);
  await page.locator('[data-testid="bot-create-save"]').click();
  await expect(page.locator('[data-testid="chat-view"]')).toBeVisible({ timeout: 15_000 });
  const backdrop = page.locator('[data-testid="start-chat-backdrop"]');
  if (await backdrop.isVisible()) await backdrop.click();
  await expect(backdrop).toHaveCount(0);
}

function groupSetupCard(page: Page, stepName: string) {
  return page.locator(`[data-testid="group-setup-card"][data-step="${stepName}"]`);
}

async function createGroupViaUi(page: Page, title: string, memberNames: string[]): Promise<void> {
  await page.locator('[data-testid="new-chat-button"]').click();
  await page.locator('[data-testid="start-chat-create-group"]').click();
  await expect(groupSetupCard(page, 'title')).toBeVisible({ timeout: 15_000 });
  await groupSetupCard(page, 'title').locator('[data-testid="group-setup-input"]').fill(title);
  await groupSetupCard(page, 'title').locator('[data-testid="group-setup-submit"]').click();
  await expect(groupSetupCard(page, 'purpose')).toBeVisible({ timeout: 15_000 });
  await groupSetupCard(page, 'purpose')
    .locator('[data-testid="group-setup-input"]')
    .fill('一起调设置');
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
  await expect(page.locator('[data-testid="conversation-name"]', { hasText: title })).toBeVisible({
    timeout: 15_000,
  });
}

async function mentionAndSend(page: Page, botName: string, text: string): Promise<void> {
  const composer = page.locator('[data-testid="composer-input"]');
  await composer.click();
  await composer.pressSequentially(`@${botName}`);
  await expect(
    page.locator('[data-testid="mention-popup"] button').filter({ hasText: botName }).first(),
  ).toBeVisible({ timeout: 5_000 });
  await composer.press('Enter');
  await composer.pressSequentially(text);
  await composer.press('ControlOrMeta+Enter');
}

function settingCard(page: Page, itemId: string) {
  return page.locator(`[data-setting-card="${itemId}"]`).last();
}

test('setting card: direct receipt can be undone; a group confirm card is applied and wakes the bot', async () => {
  test.setTimeout(300_000);
  const session = await startSession('kepcup-e2e-setting-card-');
  const { page, llm } = session;
  try {
    await waitReady(page);
    await createBot(page, '阿甲');

    // --- ① 单聊、用户本人发起：默认主模型 direct → 回执卡 → 撤销 -----------------------
    llm.script('mock-main', [
      step()
        .expect((req) => !isReflection(req) && req.lastUserText().includes('默认模型换成轻量'))
        .replyToolCall('settings_change', {
          id: 'models.default-main',
          values: { model: 'custom:mock/mock-light' },
          reason: '用户想把默认模型换成轻量模型',
        }),
      step()
        .expect((req) => !isReflection(req))
        .replyText('已经换好了，不合适可以在卡片上撤销。'),
      ...reflections(3),
    ]);
    llm.script('mock-light', reflections(3));

    const composer = page.locator('[data-testid="composer-input"]');
    await composer.fill('把默认模型换成轻量的吧');
    await composer.press('ControlOrMeta+Enter');

    const receipt = settingCard(page, 'models.default-main');
    await expect(receipt).toHaveAttribute('data-view', 'receipt', { timeout: 30_000 });
    await expect(receipt).toHaveAttribute('data-state', 'applied');
    await expect(receipt.locator('[data-testid="setting-card-diff"]')).toContainText('Mock Main');
    await expect(receipt.locator('[data-testid="setting-card-diff"]')).toContainText('Mock Light');
    await expect(
      page.locator('[data-testid="bot-bubble"]').filter({ hasText: '已经换好了' }).first(),
    ).toBeVisible({ timeout: 30_000 });

    // 撤销：同一套条目级 CAS 写回旧值，卡片标 reverted，不唤醒 Bot。
    await receipt.locator('[data-testid="setting-card-undo"]').click();
    await expect(receipt).toHaveAttribute('data-state', 'reverted', { timeout: 15_000 });
    await expect(receipt.locator('[data-testid="setting-card-state"]')).toHaveText('已撤销');
    await expect(receipt.locator('[data-testid="setting-card-undo"]')).toHaveCount(0);

    // --- ② 群聊：同类白名单项被收紧为 confirm → 卡上应用 → Bot 被唤醒续答 -------------------
    await createBot(page, '阿乙');
    await createGroupViaUi(page, '设置讨论组', ['阿甲', '阿乙']);

    llm.script('mock-main', [
      step()
        .expect((req) => !isReflection(req) && req.lastUserText().includes('轻量模型也用主模型'))
        .replyToolCall('settings_change', {
          id: 'models.default-light',
          values: { model: 'custom:mock/mock-main' },
          reason: '轻量工作也用主模型',
        }),
      step()
        .expect((req) => !isReflection(req) && !JSON.stringify(req.body).includes('用户已应用'))
        .replyText('群聊里只能出卡，请在卡片上确认。'),
      step()
        .expect((req) => !isReflection(req) && JSON.stringify(req.body).includes('用户已应用'))
        .replyText('好了，轻量模型已经换成主模型。'),
      ...reflections(4),
    ]);
    llm.script('mock-light', reflections(4));

    await mentionAndSend(page, '阿甲', ' 轻量模型也用主模型吧');

    const card = settingCard(page, 'models.default-light');
    await expect(card).toHaveAttribute('data-view', 'confirm', { timeout: 30_000 });
    await expect(card).toHaveAttribute('data-state', 'pending');
    await expect(card.locator('[data-testid="setting-card-reason"]')).toContainText(
      '轻量工作也用主模型',
    );
    await expect(card.locator('[data-testid="setting-card-mode-reason"]')).toContainText('群聊');
    await expect(card.locator('[data-testid="setting-card-diff"]')).toContainText('Mock Light');
    await expect(card.locator('[data-testid="setting-card-diff"]')).toContainText('Mock Main');
    await expect(
      page.locator('[data-testid="bot-bubble"]').filter({ hasText: '只能出卡' }).first(),
    ).toBeVisible({ timeout: 30_000 });

    // 卡上的选择框预填了建议值；「应用」= 自带 CAS 的 settings.items.apply（带卡片消息 id）。
    await expect(card.locator('[data-testid="setting-card-default-models-select"]')).toHaveValue(
      'custom:mock/mock-main',
    );
    await card.locator('[data-testid="setting-card-default-models-apply"]').click();
    await expect(card).toHaveAttribute('data-state', 'applied', { timeout: 15_000 });
    await expect(card.locator('[data-testid="setting-card-state"]')).toHaveText('已应用');

    // 宿主写一次性内部事件唤醒 Bot：Bot 接着回应用户原来的请求。
    await expect(
      page.locator('[data-testid="bot-bubble"]').filter({ hasText: '已经换成主模型' }).first(),
    ).toBeVisible({ timeout: 60_000 });
  } finally {
    await closeSession(session);
  }
});
