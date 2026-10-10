import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page, _electron } from '@playwright/test';
import { startMockLlm, step, type MockLlmServer } from '@kepcup/testkit';

/**
 * 输入框草稿的按会话缓存：文本 / @ 提及 / 引用回复 / 待发送附件随会话保留——
 * 切换会话回来、关闭应用再打开都要正确重载；附件字节在 core，重启后经
 * attachments.get 重建预览，重载后的草稿可正常发送。
 */

interface LaunchedApp {
  app: ElectronApplication;
  page: Page;
  home: string;
}

async function launchApp(options: {
  home: string;
  llmUrl: string;
  keystore?: 'memory' | 'file';
}): Promise<LaunchedApp> {
  const app = await _electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      KEPCUP_HOME: options.home,
      NODE_ENV: 'test',
      KEPCUP_KEYSTORE: options.keystore ?? 'file',
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
  // 等 Bot 药丸标题切到新 Bot：旧会话的 chat-view 本来就在，不能作为「已切
  // 过去」的信号。
  await expect(page.locator('[data-testid="right-panel-toggle"]')).toContainText(name, {
    timeout: 30_000,
  });

  // 「+」面板的自动展开是启动恢复的异步尾巴，可能落在建 Bot 之后（慢机器）；
  // 其全屏 backdrop 会拦截后续一切点击，进入测试主体前确保它已收起。
  const backdrop = page.locator('[data-testid="start-chat-backdrop"]');
  if (await backdrop.isVisible()) await backdrop.click();
  await expect(backdrop).toHaveCount(0);
}

/** 点击侧栏里名字对应的会话条目并等输入坞头部切换过去。 */
async function openConversation(page: Page, name: string): Promise<void> {
  await page
    .locator('[data-testid^="conversation-row-"]')
    .filter({ hasText: name })
    .first()
    .click();
  await expect(page.locator('[data-testid="right-panel-toggle"]')).toContainText(name, {
    timeout: 15_000,
  });
}

/** 1x1 红色像素 PNG。 */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function attachImage(page: Page, imagePath: string): Promise<void> {
  await page.locator('[data-testid="composer-attach"]').click();
  await page.locator('[data-testid="composer-file-input"]').setInputFiles(imagePath);
  await expect(page.locator('[data-testid="pending-attachment-ready"]')).toBeVisible();
}

test.describe('输入框草稿按会话缓存', () => {
  test('切换会话：文本与待发送附件按会话保留，发送链路不受影响', async () => {
    test.setTimeout(240_000);
    const session = await startSession('kepcup-composer-draft-');
    const { page, llm } = session;
    try {
      await waitReady(page);
      await createBotAndOpenChat(page, '画图甲');
      llm.script('mock-main', [step().replyText('收到图片了')]);

      const imagePath = path.join(session.home, 'fixture.png');
      await writeFile(imagePath, PNG_BYTES);

      const composer = page.locator('[data-testid="composer-input"]');
      await composer.fill('甲会话的草稿');
      await attachImage(page, imagePath);

      // 切到第二个 Bot 的会话：输入框为空，输入另一份草稿。
      await createBotAndOpenChat(page, '记录乙');
      await expect(composer).toHaveText('');
      await composer.fill('乙会话的草稿');
      await expect(page.locator('[data-testid="composer-pending-attachments"]')).toHaveCount(0);

      // 回到甲的会话：文本与附件 chip 都要回来（图片预览字节重建后渲染 <img>）。
      await openConversation(page, '画图甲');
      await expect(composer).toHaveText('甲会话的草稿');
      await expect(page.locator('[data-testid="pending-attachment-ready"]')).toBeVisible();
      await expect(page.locator('[data-testid="pending-attachment-image"] img')).toBeVisible();

      // 乙的会话仍然只有自己的文本、没有甲的附件。
      await openConversation(page, '记录乙');
      await expect(composer).toHaveText('乙会话的草稿');
      await expect(page.locator('[data-testid="composer-pending-attachments"]')).toHaveCount(0);

      // 回甲发送：附件随草稿发出（Meta+Enter = 入队并立即发送）。
      await openConversation(page, '画图甲');
      await expect(composer).toHaveText('甲会话的草稿');
      await composer.press('Meta+Enter');
      await expect(page.locator('[data-testid="attachment-image"]').first()).toBeVisible({
        timeout: 30_000,
      });
      await expect(
        page.locator('[data-testid="bot-bubble"]').filter({ hasText: '收到图片了' }),
      ).toBeVisible({ timeout: 60_000 });
    } finally {
      await closeSession(session);
    }
  });

  test('重启应用：输入框草稿与待发送附件重载后可继续发送', async () => {
    test.setTimeout(240_000);
    const session = await startSession('kepcup-composer-restart-');
    const { page, home, llm } = session;
    try {
      await waitReady(page);
      await createBotAndOpenChat(page, '画图丙');
      const composer = page.locator('[data-testid="composer-input"]');
      await composer.fill('重启后应该还在的草稿');

      const imagePath = path.join(home, 'fixture.png');
      await writeFile(imagePath, PNG_BYTES);
      await attachImage(page, imagePath);

      // 等防抖落盘（300ms）完成再退出。
      await page.waitForTimeout(600);
      await session.app.close();
      await llm.stop();

      const llm2 = await startMockLlm();
      try {
        llm2.script('mock-main', [step().replyText('重启后收到')]);
        const relaunched = await launchApp({ home, llmUrl: llm2.url, keystore: 'file' });
        try {
          await waitReady(relaunched.page);
          const recomposer = relaunched.page.locator('[data-testid="composer-input"]');
          await expect(recomposer).toHaveText('重启后应该还在的草稿', { timeout: 15_000 });
          // 附件 chip 重载；预览字节经 attachments.get 重建后渲染缩略图。
          await expect(
            relaunched.page.locator('[data-testid="pending-attachment-ready"]'),
          ).toBeVisible();
          await expect(
            relaunched.page.locator('[data-testid="pending-attachment-image"] img'),
          ).toBeVisible({ timeout: 15_000 });

          // 重载后的草稿可正常发送：文本 + 附件一起发出。
          await recomposer.press('Meta+Enter');
          await expect(
            relaunched.page.locator('[data-testid="attachment-image"]').first(),
          ).toBeVisible({ timeout: 30_000 });
          await expect(
            relaunched.page.locator('[data-testid="bot-bubble"]').filter({ hasText: '重启后收到' }),
          ).toBeVisible({ timeout: 60_000 });
        } finally {
          await relaunched.app.close();
        }
      } finally {
        await llm2.stop();
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('@ 提及：切换会话回来仍是提及节点（原生 JSON 草稿缓存）', async () => {
    test.setTimeout(120_000);
    const session = await startSession('kepcup-composer-mention-');
    const { page, llm } = session;
    try {
      await waitReady(page);
      await createBotAndOpenChat(page, '提及甲');
      await createBotAndOpenChat(page, '提及乙');

      const composer = page.locator('[data-testid="composer-input"]');
      await composer.click();
      await composer.pressSequentially('@提及甲');
      await expect(page.locator('[data-testid="mention-popup"] button').first()).toBeVisible();
      await composer.press('Enter');
      await expect(page.locator('[data-testid="composer-mention"]')).toHaveText('@提及甲');
      await composer.pressSequentially(' 记得这件事');

      // 切到甲的会话再切回：@ 提及仍是 mention 节点（高亮显示、退格整段
      // 删除），不退化为普通文本——草稿缓存走编辑器原生 JSON。
      await openConversation(page, '提及甲');
      await expect(composer).toHaveText('');
      await openConversation(page, '提及乙');
      await expect(page.locator('[data-testid="composer-mention"]')).toHaveText('@提及甲');
      await expect(composer).toContainText('记得这件事');

      // 发送后消息条目里 @XXX 正确显示（气泡内提及高亮 + markdown 原文给 AI）。
      llm.script('mock-main', [step().replyText('记住了')]);
      await composer.press('Meta+Enter');
      await expect(
        page.locator('[data-testid="user-bubble"]').first().locator('[data-testid="user-mention"]'),
      ).toHaveText('@提及甲', { timeout: 15_000 });
    } finally {
      await closeSession(session);
    }
  });

  test('markdown 列表：`1.`/`-` 加空格自动转列表，回车续行，空项回车退出', async () => {
    test.setTimeout(120_000);
    const session = await startSession('kepcup-composer-list-');
    const { page } = session;
    try {
      await waitReady(page);
      await createBotAndOpenChat(page, '列表甲');

      const composer = page.locator('[data-testid="composer-input"]');
      await composer.click();
      // 输入 `1. ` 触发输入规则：整行转为有序列表（不发送）。
      await composer.pressSequentially('1. 第一步');
      await expect(composer.locator('ol > li')).toHaveCount(1);
      // 列表项内回车：续行出新列表项（不发送）。
      await composer.press('Enter');
      await expect(composer.locator('ol > li')).toHaveCount(2);
      await expect(page.locator('[data-testid="draft-drawer"]')).toHaveCount(0);
      // 空项回车：退出列表（回到普通段落），同样不发送。
      await composer.press('Enter');
      await expect(composer.locator('ol > li')).toHaveCount(1);
      await expect(page.locator('[data-testid="draft-drawer"]')).toHaveCount(0);
      // 无序列表：`- ` + 空格同样自动转换、回车续行。
      await composer.pressSequentially('- 待办甲');
      await expect(composer.locator('ul > li')).toHaveCount(1);
      await composer.press('Enter');
      await expect(composer.locator('ul > li')).toHaveCount(2);
      await composer.press('Enter');
      await expect(composer.locator('ul > li')).toHaveCount(1);
      // 发送后用户气泡收到 markdown 原文（列表即标准 markdown，AI 可理解）。
      await composer.press('Meta+Enter');
      const bubble = page.locator('[data-testid="user-bubble"]').first();
      await expect(bubble).toContainText('第一步', { timeout: 15_000 });
      await expect(bubble).toContainText('待办甲');
    } finally {
      await closeSession(session);
    }
  });
});
