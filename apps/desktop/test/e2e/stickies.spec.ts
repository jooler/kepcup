import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page, _electron } from '@playwright/test';
import { startMockLlm, step, type MockLlmServer } from '@kepcup/testkit';

interface Session {
  app: ElectronApplication;
  page: Page;
  home: string;
  llm: MockLlmServer;
}

async function launchApp(options: { home: string; llmUrl: string }): Promise<LaunchedApp> {
  const app = await _electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      KEPCUP_HOME: options.home,
      NODE_ENV: 'test',
      KEPCUP_KEYSTORE: 'file',
      KEPCUP_ONBOARDING: 'off',
      KEPCUP_FILE_KEYSTORE_PATH: path.join(options.home, '.test-master-key'),
      KEPCUP_MOCK_LLM_URL: options.llmUrl,
    },
  });
  const page = await app.firstWindow();
  return { app, page };
}

interface LaunchedApp {
  app: ElectronApplication;
  page: Page;
}

async function startSession(prefix: string): Promise<Session> {
  const llm = await startMockLlm();
  const home = await mkdtemp(path.join(tmpdir(), prefix));
  const { app, page } = await launchApp({ home, llmUrl: llm.url });
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
  const backdrop = page.locator('[data-testid="start-chat-backdrop"]');
  if (await backdrop.isVisible()) await backdrop.click({ timeout: 2_000 }).catch(() => {});
}

/** Creates one bot through the UI and opens its chat. */
async function createBotAndOpenChat(page: Page, name: string): Promise<void> {
  await page.locator('[data-testid="new-chat-button"]').click();
  await page.locator('[data-testid="bot-create-form"]').click();
  await expect(page.locator('[data-testid="bot-create-dialog"]')).toBeVisible();
  await page.locator('[data-testid="bot-create-dialog"] [data-testid="bot-name-input"]').fill(name);
  await page
    .locator('[data-testid="bot-create-dialog"] [data-testid="bot-personality-input"]')
    .fill('认真可靠');
  await page.locator('[data-testid="bot-create-save"]').click();
  await expect(page.locator('[data-testid="chat-view"]')).toBeVisible({ timeout: 15_000 });
  const backdrop = page.locator('[data-testid="start-chat-backdrop"]');
  if (await backdrop.isVisible()) await backdrop.click();
  await expect(backdrop).toHaveCount(0);
}

/** Selects the full text of the first bot bubble with a real DOM selection. */
async function selectBotBubbleText(page: Page): Promise<void> {
  await page.evaluate(() => {
    const bubble = document.querySelector('[data-testid="bot-bubble"]');
    if (bubble === null) throw new Error('bot bubble not found');
    const walker = document.createTreeWalker(bubble, NodeFilter.SHOW_TEXT);
    const node = walker.nextNode();
    if (node === null) throw new Error('no text node in bot bubble');
    const range = document.createRange();
    range.selectNodeContents(node);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  });
}

async function openConversation(page: Page, name: string): Promise<void> {
  await page.locator('[data-testid^="conversation-item-"]').filter({ hasText: name }).click();
  await expect(page.locator('[data-testid="chat-view"]')).toBeVisible({ timeout: 15_000 });
}

test('pin selected text as a stickie: local scope per conversation, global scope everywhere, draggable, closable', async () => {
  test.setTimeout(180_000);
  const session = await startSession('kepcup-e2e-stickies-');
  const { page, llm } = session;
  try {
    await waitReady(page);
    await createBotAndOpenChat(page, '小艾');
    llm.script('mock-main', [step().replyText('这是一段可以被钉住的回复内容')]);
    const composer = page.locator('[data-testid="composer-input"]');
    await composer.fill('说点什么');
    await composer.press('Meta+Enter');
    await expect(page.locator('[data-testid="bot-bubble"]').first()).toContainText(
      '可以被钉住的回复内容',
      { timeout: 30_000 },
    );

    // 选中 Bot 气泡文本 → 浮动工具栏出现，只有一个 pin 按钮（钉当前对话）。
    await selectBotBubbleText(page);
    const toolbar = page.locator('[data-testid="selection-toolbar"]');
    await expect(toolbar).toBeVisible({ timeout: 5_000 });
    await expect(toolbar.locator('[data-testid="pin-conversation"]')).toBeVisible();
    await expect(toolbar.locator('[data-testid="pin-global"]')).toHaveCount(0);

    // pin：便签出现在当前对话，内容即选中文本。
    await toolbar.locator('[data-testid="pin-conversation"]').click();
    await expect(page.locator('[data-testid="stickie-card"]')).toHaveCount(1, { timeout: 5_000 });
    await expect(page.locator('[data-testid="stickie-card"]')).toContainText(
      '这是一段可以被钉住的回复内容',
    );
    await expect(page.locator('[data-testid="selection-toolbar"]')).toHaveCount(0);

    // 再 pin 第二张：两张按创建序级联错开 28px（第一张的手柄条未被盖住）。
    await selectBotBubbleText(page);
    await expect(page.locator('[data-testid="selection-toolbar"]')).toBeVisible();
    await page.locator('[data-testid="pin-conversation"]').click();
    await expect(page.locator('[data-testid="stickie-card"]')).toHaveCount(2);

    // 点击第一张便签：z 层级升到最高（盖过后钉的那张）。pointerdown 冒泡到卡片即置顶。
    await page.locator('[data-testid="stickie-drag-handle"]').first().click();
    const zFirst = Number(
      await page
        .locator('[data-testid="stickie-card"]')
        .first()
        .evaluate((el) => getComputedStyle(el).zIndex),
    );
    const zSecond = Number(
      await page
        .locator('[data-testid="stickie-card"]')
        .last()
        .evaluate((el) => getComputedStyle(el).zIndex),
    );
    expect(zFirst).toBeGreaterThan(zSecond);

    // 拖拽手柄移动便签（置顶后手柄无遮挡）：位置跟随指针位移变化（按下点为手柄中心）。
    const card = page.locator('[data-testid="stickie-card"]').first();
    const before = (await card.boundingBox())!;
    const handleBox = (await page
      .locator('[data-testid="stickie-drag-handle"]')
      .first()
      .boundingBox())!;
    const startX = handleBox.x + handleBox.width / 2;
    const startY = handleBox.y + handleBox.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX - 80, startY + 60, { steps: 5 });
    await page.mouse.up();
    const after = (await card.boundingBox())!;
    expect(Math.abs(after.x - (before.x - 80))).toBeLessThan(8);
    expect(Math.abs(after.y - (before.y + 60))).toBeLessThan(8);

    // 第二张在卡片上切全局：点击不触发拖拽（位置不变）；全局便签标注来源 Bot。
    const card2 = page.locator('[data-testid="stickie-card"]').last();
    const beforeToggle = (await card2.boundingBox())!;
    await page.locator('[data-testid="stickie-toggle-scope"]').last().click();
    await expect(card2).toHaveAttribute('data-stickie-scope', 'global');
    const afterToggle = (await card2.boundingBox())!;
    expect(Math.abs(afterToggle.x - beforeToggle.x)).toBeLessThan(2);
    expect(Math.abs(afterToggle.y - beforeToggle.y)).toBeLessThan(2);
    // 来源对话自身不标「来自」，仍显示「所有对话可见」。
    await expect(card2).toContainText('所有对话可见');
    const globalInXiaoai = (await card2.boundingBox())!;

    // global 作用域：小诚的对话里也显示，来源标注与位置都稳定。
    await createBotAndOpenChat(page, '小诚');
    await expect(page.locator('[data-testid="stickie-card"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="stickie-card"]')).toHaveAttribute(
      'data-stickie-scope',
      'global',
    );
    await expect(page.locator('[data-testid="stickie-card"]')).toContainText('来自 小艾');
    // 回归：全局便签跨对话位置稳定（修复前默认位按可见序推导，换对话会上下跳）。
    const globalInXiaocheng = (await page.locator('[data-testid="stickie-card"]').boundingBox())!;
    expect(Math.abs(globalInXiaocheng.y - globalInXiaoai.y)).toBeLessThan(2);

    // 在小诚对话里切换回「仅当前对话」：收回来源对话（小艾），此处消失。
    await page.locator('[data-testid="stickie-toggle-scope"]').click();
    await expect(page.locator('[data-testid="stickie-card"]')).toHaveCount(0);

    // 回小艾：两张都在；关闭一张后剩一张。
    await openConversation(page, '小艾');
    await expect(page.locator('[data-testid="stickie-card"]')).toHaveCount(2);
    await page.locator('[data-testid="stickie-close"]').first().click();
    await expect(page.locator('[data-testid="stickie-card"]')).toHaveCount(1);

    // 持久化：重启应用后便签仍在（main.db stickies）。关闭是乐观更新 +
    // 异步落库，等 delete RPC 到达 core 再重启。
    await page.waitForTimeout(500);

    // 持久化：重启应用后便签仍在（main.db stickies）。
    await session.app.close();
    await session.llm.stop();
    const llm2 = await startMockLlm();
    try {
      const relaunched = await launchApp({ home: session.home, llmUrl: llm2.url });
      try {
        await waitReady(relaunched.page);
        await openConversation(relaunched.page, '小艾');
        await expect(relaunched.page.locator('[data-testid="stickie-card"]')).toHaveCount(1, {
          timeout: 15_000,
        });
        await expect(relaunched.page.locator('[data-testid="stickie-card"]')).toContainText(
          '这是一段可以被钉住的回复内容',
        );
      } finally {
        await relaunched.app.close();
      }
    } finally {
      await llm2.stop();
    }
  } finally {
    await closeSession(session);
  }
});
