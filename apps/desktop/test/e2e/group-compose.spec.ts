import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page, _electron } from '@playwright/test';
import { groupTitleFromMemberNames } from '@kepcup/shared';
import { startMockLlm, type MockLlmServer } from '@kepcup/testkit';
import { createBotAndOpenChat, dismissStartPanel, rpc } from './helpers/create-bot';
import { rmHomeTolerant } from './helpers/home-cleanup';

/**
 * 新建群聊的顶部成员输入（GroupComposeBar，「+」→ 新建群聊）：Esc 取消；不足
 * 2 人空回车只出提示不建群；空输入 Backspace 删最后一个成员；输入名字回车新建
 * Bot 并加入；≥2 人空回车以成员名拼接的群名建群并打开。整个输入过程不打开任何
 * 对话（主区域是输入视图而不是 chat-view）。方向键行为不在此覆盖。
 */

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
  await rmHomeTolerant(session.home);
}

async function waitReady(page: Page): Promise<void> {
  await expect(page.locator('[data-testid="app-shell"]')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('[data-testid="ping-result"]')).toContainText('ping ✓', {
    timeout: 60_000,
  });
  await expect(
    page.locator('[data-testid="chat-view"]').or(page.locator('[data-testid="start-chat-panel"]')),
  ).toBeVisible({ timeout: 60_000 });
  await dismissStartPanel(page);
}

async function beginCompose(page: Page): Promise<void> {
  await page.locator('[data-testid="new-chat-button"]').click();
  await page.locator('[data-testid="start-chat-create-group"]').click();
  await expect(page.locator('[data-testid="group-compose-view"]')).toBeVisible({
    timeout: 15_000,
  });
  // 输入视图替换主区域：不打开任何对话。
  await expect(page.locator('[data-testid="chat-view"]')).toHaveCount(0);
}

async function groupConversations(
  page: Page,
): Promise<Array<{ id: string; title: string | null }>> {
  const { conversations } = (await rpc(page, 'conversations.list')) as {
    conversations: Array<{ id: string; type: string; title: string | null }>;
  };
  return conversations.filter((conversation) => conversation.type === 'group');
}

test('group compose: Esc cancels, needs 2 members, Backspace removes, Enter creates a Bot, empty Enter creates the group', async () => {
  test.setTimeout(240_000);
  const session = await startSession('kepcup-e2e-group-compose-');
  const { page } = session;
  try {
    await waitReady(page);
    const alpha = await createBotAndOpenChat(page, '阿甲');
    const beta = await createBotAndOpenChat(page, '阿乙');

    const view = page.locator('[data-testid="group-compose-view"]');
    const input = page.locator('[data-testid="group-compose-input"]');
    const chips = page.locator('[data-testid^="group-compose-chip-"]');
    const activeName = page.locator(
      '[data-testid^="conversation-item-"][data-active="true"] [data-testid="conversation-name"]',
    );

    // Esc：退出输入视图，回到原来的对话。
    await beginCompose(page);
    await expect(input).toBeFocused();
    await input.press('Escape');
    await expect(view).toHaveCount(0);
    await expect(page.locator('[data-testid="chat-view"]')).toBeVisible();
    await expect(activeName).toHaveText('阿乙');

    // 只有 1 个成员时空回车：出提示，不建群，仍在输入视图。
    await beginCompose(page);
    await page.locator(`[data-testid="group-compose-option-${alpha.botId}"]`).click();
    await expect(page.locator(`[data-testid="group-compose-chip-${alpha.botId}"]`)).toBeVisible();
    await input.press('Enter');
    await expect(page.locator('[data-testid="group-compose-hint"]')).toContainText(
      '至少添加 2 个成员',
    );
    await expect(view).toBeVisible();
    expect(await groupConversations(page)).toHaveLength(0);

    // 空输入 Backspace：删掉最后一个成员，它回到候选列表。
    await page.locator(`[data-testid="group-compose-option-${beta.botId}"]`).click();
    await expect(chips).toHaveCount(2);
    await input.press('Backspace');
    await expect(page.locator(`[data-testid="group-compose-chip-${beta.botId}"]`)).toHaveCount(0);
    await expect(page.locator(`[data-testid="group-compose-chip-${alpha.botId}"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="group-compose-option-${beta.botId}"]`)).toBeVisible();

    // 输入新名字回车：新建一个 Bot 并直接加入，不跳去它的对话。
    await input.fill('阿丙');
    await input.press('Enter');
    await expect(chips.filter({ hasText: '阿丙' })).toBeVisible({ timeout: 15_000 });
    await expect(input).toHaveValue('');
    await expect(chips).toHaveCount(2);
    await expect
      .poll(async () => {
        const { bots } = (await rpc(page, 'bots.list')) as { bots: Array<{ name: string }> };
        return bots.some((bot) => bot.name === '阿丙');
      })
      .toBe(true);
    await expect(view).toBeVisible();
    await expect(page.locator('[data-testid="chat-view"]')).toHaveCount(0);
    // 撰写群聊时侧栏不高亮任何对话（chat.activeId 为 null）。
    await expect(activeName).toHaveCount(0);
    expect(await groupConversations(page)).toHaveLength(0);

    // ≥2 人空回车：以成员名拼接的群名建群并打开。
    const title = groupTitleFromMemberNames(['阿甲', '阿丙']);
    await input.press('Enter');
    await expect(view).toHaveCount(0, { timeout: 15_000 });
    await expect(page.locator('[data-testid="chat-view"]')).toBeVisible({ timeout: 15_000 });
    await expect(activeName).toHaveText(title, { timeout: 15_000 });
    const groups = await groupConversations(page);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.title).toBe(title);
  } finally {
    await closeSession(session);
  }
});
