import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page, _electron } from '@playwright/test';
import { startMockLlm, type MockLlmServer } from '@kepcup/testkit';

/**
 * 输入框单行 / 沉底布局（composer-multiline.ts）：按「单行布局下放不放得下」
 * 判定，以测得的宽度而不是字符数滞回——宽字形换行后换成更长但更窄的文字要能
 * 回单行；换行后的满宽布局不得来回闪。
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


/** 连续若干帧采样药丸的布局标记（data-multiline）。 */
async function sampleLayout(page: Page, frames: number): Promise<string[]> {
  return page.evaluate(async (count) => {
    const pill = document.querySelector<HTMLElement>('[data-testid="composer-pill"]');
    const values: string[] = [];
    for (let i = 0; i < count; i++) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      values.push(pill?.dataset.multiline ?? 'missing');
    }
    return values;
  }, frames);
}

test.describe('输入框单行 / 沉底布局', () => {
  test('宽字形换行后换成更长的窄字符能回单行，换行状态不闪', async () => {
    test.setTimeout(180_000);
    const session = await startSession('kepcup-composer-layout-');
    const { page } = session;
    try {
      await waitReady(page);
      await createBotAndOpenChat(page, '排版甲');
      const composer = page.locator('[data-testid="composer-input"]');
      const pill = page.locator('[data-testid="composer-pill"]');
      await expect(pill).toHaveAttribute('data-multiline', 'false');

      // 逐步加长汉字，找到刚好换行（进入沉底）的长度 n。
      let n = 0;
      for (let count = 4; count <= 400; count += 2) {
        await composer.fill('汉'.repeat(count));
        const settled = await sampleLayout(page, 3);
        if (settled.at(-1) === 'true') {
          n = count;
          break;
        }
      }
      expect(n).toBeGreaterThan(0);
      // 进入沉底后在满宽下一行放得下，也必须稳定保持沉底（不闪回单行）。
      expect(await sampleLayout(page, 20)).toEqual(Array(20).fill('true'));

      // 换成 2n 个窄字符：字数更多，但一行放得下 → 回单行并保持。
      await composer.fill('i'.repeat(n * 2));
      await expect(pill).toHaveAttribute('data-multiline', 'false');
      expect(await sampleLayout(page, 20)).toEqual(Array(20).fill('false'));
      const height = await composer.evaluate((el) => el.getBoundingClientRect().height);
      expect(height).toBeLessThanOrEqual(48);

      // 再换回会换行的汉字：重新进入沉底。
      await composer.fill('汉'.repeat(n));
      await expect(pill).toHaveAttribute('data-multiline', 'true');
    } finally {
      await closeSession(session);
    }
  });
});
