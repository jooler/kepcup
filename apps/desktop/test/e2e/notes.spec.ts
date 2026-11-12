import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page, _electron } from '@playwright/test';
import { startMockLlm, type MockLlmServer } from '@kepcup/testkit';
import { createBotAndOpenChat, openConversationByName, rpc } from './helpers/create-bot';
import { rmHomeTolerant } from './helpers/home-cleanup';

/**
 * 右栏 Bot 详情「便签」tab：仅私聊提供；新建 → 直接编辑 → 超过 4 行出现
 * 折叠行 → 收起后正文高度压到 4 行 → 删除。落库经 notes.* RPC 验证。
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
    page
      .locator('[data-testid="chat-view"]')
      .or(page.locator('[data-testid="start-chat-panel"]'))
      .or(page.locator('[data-testid="onboarding"]')),
  ).toBeVisible({ timeout: 60_000 });
  const backdrop = page.locator('[data-testid="start-chat-backdrop"]');
  if (await backdrop.isVisible()) await backdrop.click({ timeout: 2_000 }).catch(() => {});
}

async function openRightPanel(page: Page): Promise<void> {
  if (!(await page.locator('[data-testid="right-panel"]').isVisible())) {
    await page.locator('[data-testid="right-panel-toggle"]').click();
  }
  await expect(page.locator('[data-testid="right-panel"]')).toBeVisible({ timeout: 15_000 });
}

async function noteCount(page: Page, conversationId: string): Promise<number> {
  const result = (await rpc(page, 'notes.list', { conversationId })) as { notes: unknown[] };
  return result.notes.length;
}

test('conversation notes: edit inline, collapse past four lines, persist and delete', async () => {
  test.setTimeout(180_000);
  const session = await startSession('kepcup-e2e-notes-');
  const { page } = session;
  try {
    await waitReady(page);
    const { conversationId } = await createBotAndOpenChat(page, '便签乙');
    await openRightPanel(page);

    // 私聊才有便签入口。
    const notesTab = page.locator('[data-testid="right-panel-tab-notes"]');
    await expect(notesTab).toBeVisible({ timeout: 15_000 });
    await notesTab.click();
    await expect(page.locator('[data-testid="bot-notes-add"]')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid="note-card"]')).toHaveCount(0);

    // 新建即聚焦，正文直接输入（没有输入框外观）。
    const addButton = page.locator('[data-testid="bot-notes-add"]');
    await expect(addButton).toBeEnabled({ timeout: 15_000 });
    // 图标按钮：无背景，默认 50% / hover 90% / 按下 100%，始终 pointer。
    const opacity = () => addButton.evaluate((el) => getComputedStyle(el).opacity);
    const background = () => addButton.evaluate((el) => getComputedStyle(el).backgroundColor);
    await expect.poll(opacity).toBe('0.5');
    expect(await background()).toBe('rgba(0, 0, 0, 0)');
    await addButton.hover();
    await expect.poll(opacity).toBe('0.9');
    expect(await background()).toBe('rgba(0, 0, 0, 0)');
    expect(await addButton.evaluate((el) => getComputedStyle(el).cursor)).toBe('pointer');
    const buttonBox = await addButton.boundingBox();
    if (buttonBox === null) throw new Error('add-note button has no box');
    await page.mouse.move(buttonBox.x + buttonBox.width / 2, buttonBox.y + buttonBox.height / 2);
    await page.mouse.down();
    await expect.poll(opacity).toBe('1');
    await page.mouse.up();
    const textarea = page.locator('[data-testid="note-textarea"]').first();
    await expect(textarea).toBeFocused();
    const body = [
      '启动命令',
      'npm run dev',
      '',
      '测试账号',
      'tester@example.com',
      '密码：secret',
      '第七行',
    ];
    await textarea.fill(body.join('\n'));
    await textarea.blur();

    // 失焦立即落库。
    await expect.poll(() => noteCount(page, conversationId), { timeout: 10_000 }).toBe(1);

    // 超过 4 行：折叠行出现；收起后正文高度压到 4 行。
    const toggle = page.locator('[data-testid="note-collapse-toggle"]');
    await expect(toggle).toBeVisible({ timeout: 10_000 });
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const expandedHeight = await textarea.evaluate((el) => el.getBoundingClientRect().height);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    const collapsedHeight = await textarea.evaluate((el) => el.getBoundingClientRect().height);
    expect(collapsedHeight).toBeLessThan(expandedHeight - 20);
    expect(collapsedHeight).toBeGreaterThan(80);
    expect(collapsedHeight).toBeLessThan(110);

    // 独立遮罩层覆盖卡片下半部（高度 = 折叠后卡片高度的一半）。
    const mask = page.locator('[data-testid="note-collapse-mask"]');
    await expect(mask).toBeVisible();
    const cardHeight = await page
      .locator('[data-testid="note-card"]')
      .first()
      .evaluate((el) => el.getBoundingClientRect().height);
    const maskHeight = await mask.evaluate((el) => el.getBoundingClientRect().height);
    expect(Math.abs(maskHeight - cardHeight / 2)).toBeLessThan(2);

    // 展开恢复。
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(await textarea.evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThan(
      collapsedHeight + 20,
    );

    // 删除后落库同步清空。先把焦点移出卡片：编辑中的卡片会隐藏删除按钮。
    await page.locator('[data-testid="right-panel-tab-notes"]').click();
    const card = page.locator('[data-testid="note-card"]').first();
    await card.hover();
    await card.locator('[data-testid="note-delete"]').click();
    await expect(page.locator('[data-testid="note-card"]')).toHaveCount(0, { timeout: 15_000 });
    await expect.poll(() => noteCount(page, conversationId), { timeout: 10_000 }).toBe(0);

    // 空白处双击也能新建。
    await page.locator('[data-testid="bot-notes-scroll"]').dblclick({ position: { x: 40, y: 40 } });
    await expect(page.locator('[data-testid="note-textarea"]')).toHaveCount(1, { timeout: 15_000 });
    await expect(page.locator('[data-testid="note-textarea"]').first()).toBeFocused();

    // 另一个对话不串数据；切回原对话时正文已落库（切走时立即保存）。
    await page.locator('[data-testid="note-textarea"]').first().fill('切对话前输入的正文');
    await createBotAndOpenChat(page, '便签丙');
    await openRightPanel(page);
    await page.locator('[data-testid="right-panel-tab-notes"]').click();
    await expect(page.locator('[data-testid="bot-notes-add"]')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid="note-card"]')).toHaveCount(0);

    await openConversationByName(page, '便签乙');
    await page.locator('[data-testid="right-panel-tab-notes"]').click();
    await expect(page.locator('[data-testid="note-textarea"]').first()).toHaveValue(
      '切对话前输入的正文',
      { timeout: 15_000 },
    );
    await expect.poll(() => noteCount(page, conversationId), { timeout: 10_000 }).toBe(1);
  } finally {
    await closeSession(session);
  }
});
