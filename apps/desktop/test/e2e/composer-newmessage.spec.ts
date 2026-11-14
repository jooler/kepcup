import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type Page, _electron } from '@playwright/test';
import { startMockLlm, step, type MockLlmServer } from '@kepcup/testkit';
import { createBotAndOpenChat } from './helpers/create-bot';
import { rmHomeTolerant } from './helpers/home-cleanup';

/**
 * 输入框草稿保护：键入期间收到 Bot 新消息，输入内容必须原样保留。
 *
 * 回归背景（D120 共享草稿）：发送后 core 的 draftCleared 回声把共享草稿置成
 * 空快照，Composer 的 revision 效果因追踪 view.conversation（每条新消息都会
 * 被 markRead / conversation.updated 整体替换）随新消息重跑；空文档形状又与
 * TipTap 空编辑器的 getJSON 不等（content:[] vs 空段落），逐字节比较永远
 * 不等，每次重跑都 setContent 清空——正在键入的草稿随第一条 Bot 回复丢失。
 */

async function startSession(prefix: string): Promise<{
  page: Page;
  llm: MockLlmServer;
  home: string;
  close: () => Promise<void>;
}> {
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
  return {
    page,
    llm,
    home,
    close: async () => {
      await app.close();
      await llm.stop();
      await rmHomeTolerant(home);
    },
  };
}

test('typing while a bot message arrives keeps composer content', async () => {
  test.setTimeout(240_000);
  const session = await startSession('kepcup-composer-keep-e2e-');
  const { page, llm } = session;
  try {
    await expect(page.locator('[data-testid="app-shell"]')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('[data-testid="ping-result"]')).toContainText('ping ✓', {
      timeout: 60_000,
    });
    await createBotAndOpenChat(page, '草稿守护');

    // 第一轮回复挂起：用户发送后 Bot 迟迟不回，用户继续在输入框键入。
    const firstTurn = step().hold().replyText('回复到达');
    llm.script('mock-main', [firstTurn]);

    await page.locator('[data-testid="composer-input"]').pressSequentially('第一条消息');
    await page.locator('[data-testid="composer-input"]').press('Enter');
    await expect(page.locator('[data-testid="user-bubble"]').first()).toBeVisible({
      timeout: 30_000,
    });

    // 回复挂起期间键入草稿。
    await page.locator('[data-testid="composer-input"]').pressSequentially('KEEP_DRAFT_123');
    const input = page.locator('[data-testid="composer-input"]');
    await expect(input).toContainText('KEEP_DRAFT_123', { timeout: 5_000 });

    // 放行首轮：Bot 消息（message.created）在键入后到达。
    firstTurn.release();
    await expect(
      page.locator('[data-testid="bot-bubble"]').filter({ hasText: '回复到达' }),
    ).toBeVisible({ timeout: 60_000 });

    // Bot 消息落进列表后，输入框内容必须原样保留。
    await expect(input).toContainText('KEEP_DRAFT_123', { timeout: 10_000 });
  } finally {
    await session.close();
  }
});
