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

test('loop narration: status line sits under the last message, yields to interim messages and names the running tool', async () => {
  test.setTimeout(180_000);
  const session = await startSession('kepcup-e2e-loop-progress-');
  const { page, llm } = session;
  try {
    await waitReady(page);
    await createBotAndOpenChat(page, '小艾');

    // 每个关键 turn 都 hold：让「请稍待 → 正在调用工具 → 中间消息 → 又一次
    // 正在调用工具 → 最终回复」每个状态都稳定可断言（search_messages 执行
    // 只有毫秒级，不 hold 的话状态一闪而过）。保留 step 引用逐个 release。
    const step1 = step().hold().replyToolCall('search_messages', { query: '背景' });
    const step2 = step().hold().replyTextAndToolCall('收到，我来处理…', 'search_messages', { query: '背景' });
    const step3 = step().hold().replyTextAndToolCall('让我再检索一些细节…', 'search_messages', { query: '细节' });
    llm.script('mock-main', [
      step1,
      step2,
      step3,
      step().replyText('调研完成：这是最终结论。'),
    ]);

    const composer = page.locator('[data-testid="composer-input"]');
    await composer.fill('帮我调研一下');
    // Cmd/Ctrl+Enter 直接发送（Enter 只入队，见 direct-chat.spec.ts 草稿队列流）。
    await composer.press('ControlOrMeta+Enter');

    // 1) run 启动后、模型输出前：状态行「请稍等…」出现在消息流末尾
    //    （用户消息下方、下一条消息将出现的位置）。
    const status = page.locator('[data-testid="run-status"]');
    await expect(status).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid="run-status-text"]')).toContainText('请稍等', {
      timeout: 15_000,
    });
    // 状态行在消息列表内，而不是输入坞里（todo/loop-interim-updates.md 拍板 1）。
    await expect(page.locator('[data-testid="message-list"] [data-testid="run-status"]')).toBeVisible();
    await expect(page.locator('[data-testid="composer-dock"] [data-testid="run-status"]')).toHaveCount(0);

    // 2) 放行第一个请求：无文本的工具调用 → 状态行显示工具动词，且稳定
    //    （第二个请求 hold 中）。
    step1.release();
    await expect(page.locator('[data-testid="run-status-text"]')).toContainText('正在检索对话', {
      timeout: 15_000,
    });

    // 3) 放行第二个请求：第一条中间消息出现（状态行让位后随下一个工具调用
    //    重现）；第三个请求 hold 中，工具动词标签再次稳定。
    const list = page.locator('[data-testid="message-list"]');
    step2.release();
    await expect(list.getByText('收到，我来处理…')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid="run-status-text"]')).toContainText('正在检索对话', {
      timeout: 15_000,
    });

    // 4) 放行第三个请求：第二条中间消息 + 最终回复出现，run 结束后状态行消失。
    step3.release();
    await expect(list.getByText('让我再检索一些细节…')).toBeVisible({ timeout: 15_000 });
    await expect(list.getByText('调研完成：这是最终结论。')).toBeVisible({ timeout: 15_000 });
    await expect(status).toBeHidden({ timeout: 15_000 });
  } finally {
    await closeSession(session);
  }
});
