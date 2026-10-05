import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page, _electron } from '@playwright/test';
import { startMockLlm, step, type MockLlmServer } from '@kepcup/testkit';

/**
 * 对话附件（docs/design/20-conversation-media.md，P17）：回形针上传图片 →
 * 待发送附件 chip → 入草稿（抽屉附件可移除）→ 发送 → 消息缩略图 → 灯箱
 * 打开/关闭。覆盖 D61 的用户可见主链路。
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
  await rm(session.home, { recursive: true, force: true });
}

async function waitReady(page: Page): Promise<void> {
  await expect(page.locator('[data-testid="app-shell"]')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('[data-testid="ping-result"]')).toContainText('ping ✓', {
    timeout: 60_000,
  });
  await expect(
    page.locator('[data-testid="chat-view"]').or(page.locator('[data-testid="start-chat-panel"]')),
  ).toBeVisible({ timeout: 60_000 });
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
  await expect(page.locator('[data-testid="chat-view"]')).toBeVisible({ timeout: 30_000 });

  // 「+」面板的自动展开是启动恢复的异步尾巴，可能落在建 Bot 之后（慢机器）；
  // 其全屏 backdrop 会拦截后续一切点击，进入测试主体前确保它已收起。
  const backdrop = page.locator('[data-testid="start-chat-backdrop"]');
  if (await backdrop.isVisible()) await backdrop.click();
  await expect(backdrop).toHaveCount(0);
}

/** 1x1 红色像素 PNG。 */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test.describe('对话附件与媒体', () => {
  test('上传图片 → 草稿附件 → 发送 → 缩略图 → 灯箱', async () => {
    test.setTimeout(240_000);
    const session = await startSession('kepcup-attachments-e2e-');
    const { page, llm } = session;
    try {
      await waitReady(page);
      await createBotAndOpenChat(page, '画图甲');
      llm.script('mock-main', [step().replyText('收到图片了')]);

      const imagePath = path.join(session.home, 'fixture.png');
      await writeFile(imagePath, PNG_BYTES);

      // 上传（回形针 → 隐藏 file input），chip 出现且为 ready。
      await page.locator('[data-testid="composer-attach"]').click();
      await page.locator('[data-testid="composer-file-input"]').setInputFiles(imagePath);
      await expect(page.locator('[data-testid="composer-pending-attachments"]')).toBeVisible();
      await expect(page.locator('[data-testid="pending-attachment-ready"]')).toBeVisible();

      // 入草稿：抽屉里出现附件 chip（可移除），文本为空 → 占位文案。
      await page.locator('[data-testid="composer-input"]').pressSequentially('看这张图');
      await page.locator('[data-testid="composer-input"]').press('Enter');
      await expect(page.locator('[data-testid="draft-drawer"]')).toBeVisible();
      await expect(page.locator('[data-testid="draft-attachments"]')).toBeVisible();

      // 发送：消息行出现图片缩略图（字节加载完成渲染 <img>）。
      await page.locator('[data-testid="composer-send"]').click();
      const thumbnail = page.locator('[data-testid="attachment-image"] img');
      await expect(thumbnail).toBeVisible({ timeout: 30_000 });

      // 灯箱：点击缩略图打开，Esc 关闭。
      await page.locator('[data-testid="attachment-image"]').click();
      await expect(page.locator('[data-testid="lightbox"]')).toBeVisible();
      await expect(page.locator('[data-testid="lightbox-image"]')).toBeVisible();
      await page.locator('[data-testid="lightbox-close"]').click();
      await expect(page.locator('[data-testid="lightbox"]')).toBeHidden();

      // Bot 回复照常到达（附件发送不影响响应链路）。
      await expect(
        page.locator('[data-testid="bot-bubble"]').filter({ hasText: '收到图片了' }),
      ).toBeVisible({ timeout: 60_000 });
    } finally {
      await closeSession(session);
    }
  });
});
