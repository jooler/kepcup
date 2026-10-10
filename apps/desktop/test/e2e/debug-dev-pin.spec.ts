import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page, _electron } from '@playwright/test';
import { startMockLlm, step, type MockLlmServer } from '@kepcup/testkit';

// Throwaway spec: reproduce the dev-renderer pin failure. Requires the
// renderer dev server on :5173 (`pnpm dev` running separately); launches the
// BUILT main with ELECTRON_RENDERER_URL so Vite serves the renderer live.

let electron: ElectronApplication | null = null;

test('debug dev-mode pin', async () => {
  test.setTimeout(180_000);
  const llm = await startMockLlm();
  const home = await mkdtemp(path.join(tmpdir(), 'kepcup-e2e-devpin-'));
  try {
    electron = await _electron.launch({
      args: ['.'],
      env: {
        ...process.env,
        KEPCUP_HOME: home,
        NODE_ENV: 'test',
        KEPCUP_KEYSTORE: 'file',
        KEPCUP_ONBOARDING: 'off',
        KEPCUP_FILE_KEYSTORE_PATH: path.join(home, '.test-master-key'),
        KEPCUP_MOCK_LLM_URL: llm.url,
        ELECTRON_RENDERER_URL: 'http://localhost:5174',
      },
    });
    const page = await electron.firstWindow();
    page.on('console', (msg) => {
      const text = msg.text();
      if (text.includes('stickies') || text.includes('Pin') || msg.type() === 'error') {
        console.log('[console]', msg.type(), text.slice(0, 300));
      }
    });
    page.on('pageerror', (err) => console.log('[pageerror]', err.message.slice(0, 300)));

    await expect(page.locator('[data-testid="app-shell"]')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('[data-testid="ping-result"]')).toContainText('ping ✓', {
      timeout: 60_000,
    });
    await page.locator('[data-testid="new-chat-button"]').click();
    await page.locator('[data-testid="bot-create-form"]').click();
    await page.locator('[data-testid="bot-create-dialog"] [data-testid="bot-name-input"]').fill('小艾');
    await page.locator('[data-testid="bot-create-save"]').click();
    await expect(page.locator('[data-testid="chat-view"]')).toBeVisible({ timeout: 15_000 });
    const backdrop = page.locator('[data-testid="start-chat-backdrop"]');
    if (await backdrop.isVisible()) await backdrop.click();

    llm.script('mock-main', [step().replyText('这是一段可以被钉住的回复内容')]);
    const composer = page.locator('[data-testid="composer-input"]');
    await composer.fill('说点什么');
    await composer.press('Meta+Enter');
    await expect(page.locator('[data-testid="bot-bubble"]').first()).toContainText('可以被钉住', {
      timeout: 30_000,
    });

    await page.evaluate(() => {
      const bubble = document.querySelector('[data-testid="bot-bubble"]');
      const node = document.createTreeWalker(bubble!, NodeFilter.SHOW_TEXT).nextNode()!;
      const range = document.createRange();
      range.selectNodeContents(node);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
    });
    const toolbarVisible = await page.locator('[data-testid="selection-toolbar"]').isVisible();
    console.log('[devpin] toolbar visible:', toolbarVisible);
    if (toolbarVisible) {
      await page.locator('[data-testid="pin-conversation"]').click();
      await page.waitForTimeout(800);
      console.log('[devpin] card count:', await page.locator('[data-testid="stickie-card"]').count());
    }
  } finally {
    await electron?.close();
    await llm.stop();
    await rm(home, { recursive: true, force: true });
  }
});
