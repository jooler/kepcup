import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page, _electron } from '@playwright/test';
import { projectTitleFromMemberNames } from '@kepcup/shared';
import { startMockLlm, type MockLlmServer } from '@kepcup/testkit';
import { createBotAndOpenChat, dismissStartPanel, rpc } from './helpers/create-bot';
import { rmHomeTolerant } from './helpers/home-cleanup';

/**
 * 新建项目组的双轮成员输入（ProjectComposeBar，「+」→ 新建项目组）：第一轮
 * 选负责人、第二轮选成员。Esc 取消；负责人轮空回车只提示；点负责人进入成
 * 员轮；空 Backspace 先删最后一位成员、再退回负责人轮；成员轮至少 1 人；在
 * 负责人轮输入新名字回车 = 新建 Bot 并作为负责人；空回车建组。候选排除管家
 * （管家永不入项目组），成员轮候选不含负责人。方向键行为不在此覆盖。
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
      TZ: 'Asia/Shanghai',
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
  await page.locator('[data-testid="start-chat-create-project"]').click();
  await expect(page.locator('[data-testid="project-compose-view"]')).toBeVisible({
    timeout: 15_000,
  });
  // 输入视图替换主区域：不打开任何对话。
  await expect(page.locator('[data-testid="chat-view"]')).toHaveCount(0);
}

async function projectConversations(
  page: Page,
): Promise<Array<{ id: string; title: string | null }>> {
  const { conversations } = (await rpc(page, 'conversations.list')) as {
    conversations: Array<{ id: string; type: string; title: string | null }>;
  };
  return conversations.filter((conversation) => conversation.type === 'project');
}

test('project compose: Esc cancels; lead phase needs a lead; pick lead enters members phase; Backspace returns to lead phase; needs 1 member; Enter creates a Bot as lead; empty Enter creates the project', async () => {
  test.setTimeout(240_000);
  const session = await startSession('kepcup-e2e-project-compose-');
  const { page } = session;
  try {
    await waitReady(page);
    await createBotAndOpenChat(page, '阿甲');
    const beta = await createBotAndOpenChat(page, '阿乙');
    // 通讯录里有管家（D70），候选必须排除它——管家永不加入项目组。
    await rpc(page, 'butler.ensure', {});

    const view = page.locator('[data-testid="project-compose-view"]');
    const input = page.locator('[data-testid="project-compose-input"]');
    const menu = page.locator('[data-testid="project-compose-menu"]');
    const phase = page.locator('[data-testid="project-compose-phase"]');
    const hint = page.locator('[data-testid="project-compose-hint"]');
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

    // 候选不含管家；撰写时侧栏不高亮任何对话（chat.activeId 为 null）。
    await beginCompose(page);
    await expect(menu.locator('button', { hasText: '管家' })).toHaveCount(0);
    await expect(menu.locator('button', { hasText: '阿甲' })).toHaveCount(1);
    await expect(activeName).toHaveCount(0);
    // 负责人轮空回车：只提示，不建组，仍在输入视图。
    await input.press('Enter');
    await expect(hint).toContainText('请先选择项目负责人');
    await expect(view).toBeVisible();
    expect(await projectConversations(page)).toHaveLength(0);

    // 负责人轮输入新名字回车：新建一个 Bot 并作为负责人，进入成员轮。
    await input.fill('阿丙');
    await input.press('Enter');
    await expect(phase).toHaveAttribute('data-phase', 'members', { timeout: 15_000 });
    await expect(page.locator('[data-testid="project-compose-lead-chip"]')).toContainText('阿丙');
    await expect
      .poll(async () => {
        const { bots } = (await rpc(page, 'bots.list')) as { bots: Array<{ name: string }> };
        return bots.some((bot) => bot.name === '阿丙');
      })
      .toBe(true);
    // 成员轮候选不含负责人（阿丙），管家仍然不在候选里。
    await expect(menu.locator('button', { hasText: '阿丙' })).toHaveCount(0);
    await expect(menu.locator('button', { hasText: '管家' })).toHaveCount(0);
    await expect(view).toBeVisible();
    await expect(page.locator('[data-testid="chat-view"]')).toHaveCount(0);

    // 成员轮空回车（0 位成员）：只提示「至少再添加 1 位成员」。
    await input.fill('');
    await input.press('Enter');
    await expect(hint).toContainText('至少再添加 1 位成员');
    expect(await projectConversations(page)).toHaveLength(0);

    // 空输入 Backspace：删掉最后一位成员，它回到候选列表；再按一次退回负责人轮。
    await menu.locator('button', { hasText: '阿乙' }).first().click();
    await expect(page.locator(`[data-testid="project-compose-chip-${beta.botId}"]`)).toBeVisible();
    await input.press('Backspace');
    await expect(page.locator(`[data-testid="project-compose-chip-${beta.botId}"]`)).toHaveCount(0);
    await expect(menu.locator('button', { hasText: '阿乙' })).toHaveCount(1);
    await input.press('Backspace');
    await expect(phase).toHaveAttribute('data-phase', 'lead', { timeout: 5_000 });
    await expect(page.locator('[data-testid="project-compose-lead-chip"]')).toHaveCount(0);

    // 重选负责人（点选已有 Bot），再进成员轮。
    await menu.locator('button', { hasText: '阿甲' }).first().click();
    await expect(phase).toHaveAttribute('data-phase', 'members', { timeout: 5_000 });
    await expect(page.locator('[data-testid="project-compose-lead-chip"]')).toContainText('阿甲');
    // 成员轮候选不含负责人（阿甲）。
    await expect(menu.locator('button', { hasText: '阿甲' })).toHaveCount(0);

    // ≥1 位成员后空回车：以「负责人、成员」拼接的默认名建组并打开。
    await menu.locator('button', { hasText: '阿乙' }).first().click();
    const title = projectTitleFromMemberNames(['阿甲', '阿乙']);
    await input.press('Enter');
    await expect(view).toHaveCount(0, { timeout: 15_000 });
    await expect(page.locator('[data-testid="chat-view"]')).toBeVisible({ timeout: 15_000 });
    await expect(activeName).toContainText(title, {
      timeout: 15_000,
    });
    const projects = await projectConversations(page);
    expect(projects).toHaveLength(1);
    expect(projects[0]?.title).toBe(title);
  } finally {
    await closeSession(session);
  }
});
