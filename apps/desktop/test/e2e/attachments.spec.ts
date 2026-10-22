import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page, _electron } from '@playwright/test';
import { startMockLlm, step, type MockLlmServer } from '@kepcup/testkit';
import { createBotAndOpenChat } from './helpers/create-bot';
import { rmHomeTolerant } from './helpers/home-cleanup';

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
      TZ: 'Asia/Shanghai',
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

      // 直发：消息行出现图片缩略图（字节加载完成渲染 <img>）。
      await page.locator('[data-testid="composer-input"]').pressSequentially('看这张图');
      await page.locator('[data-testid="composer-input"]').press('Enter');
      const thumbnail = page.locator('[data-testid="attachment-image"] img');
      await expect(thumbnail).toBeVisible({ timeout: 30_000 });

      // 灯箱：点击缩略图打开，Esc 关闭。开着时全局拖拽带应激活（窗口仍可拖），
      // 且带是 body 最后一个子节点——app-region 矩形按 DOM 顺序后者胜出，
      // 排不到最后就压不过浮层的 no-drag（window-drag-band.ts）。
      await page.locator('[data-testid="attachment-image"]').click();
      await expect(page.locator('[data-testid="lightbox"]')).toBeVisible();
      await expect(page.locator('[data-testid="lightbox-image"]')).toBeVisible();
      const dragBand = page.locator('[data-testid="window-drag-band"]');
      await expect(dragBand).toHaveAttribute('data-active', 'true');
      await expect
        .poll(() =>
          page.evaluate(() => document.body.lastElementChild?.getAttribute('data-testid')),
        )
        .toBe('window-drag-band');
      await page.locator('[data-testid="lightbox-close"]').click();
      await expect(page.locator('[data-testid="lightbox"]')).toBeHidden();
      await expect(dragBand).toHaveAttribute('data-active', 'false');

      // Bot 回复照常到达（附件发送不影响响应链路）。
      await expect(
        page.locator('[data-testid="bot-bubble"]').filter({ hasText: '收到图片了' }),
      ).toBeVisible({ timeout: 60_000 });
    } finally {
      await closeSession(session);
    }
  });
});
