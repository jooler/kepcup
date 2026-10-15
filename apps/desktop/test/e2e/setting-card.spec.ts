import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page, _electron } from '@playwright/test';
import { startMockLlm, step, type MockChatRequest, type MockLlmServer } from '@kepcup/testkit';
import { createBotAndOpenChat } from './helpers/create-bot';
import { createGroupViaUi } from './helpers/create-group';

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

/**
 * 种子的 custom:mock 厂商没有 Key：模型选项（与宿主的「已配置厂商」判断）只认有 Key 的厂商，
 * 不补 Key 时宿主会把换模型收紧为 form。经设置「模型」分区的卡片补一个 Key。
 */
async function giveMockProviderAKey(page: Page): Promise<void> {
  await page.locator('[data-testid="user-menu-trigger"]').click();
  await page.locator('[data-testid="menu-settings"]').click();
  await expect(page.locator('[data-testid="settings-page-content"]')).toBeVisible();
  await page.locator('[data-testid="settings-nav-models"]').click();
  await page.locator('[data-testid="key-dialog-custom:mock"]').click();
  await expect(page.locator('[data-testid="provider-add-dialog"]')).toBeVisible();
  await page.locator('[data-testid="key-input-custom:mock"]').fill('sk-setting-card-e2e');
  await page.locator('[data-testid="provider-add-save"]').click();
  await expect(page.locator('[data-testid="key-state-custom:mock"]')).toBeVisible({
    timeout: 15_000,
  });
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-testid="settings-dialog"]')).toBeHidden();
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
    await giveMockProviderAKey(page);
    await createBotAndOpenChat(page, '阿甲');

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
    await createBotAndOpenChat(page, '阿乙');
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
