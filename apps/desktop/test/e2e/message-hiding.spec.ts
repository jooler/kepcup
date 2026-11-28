import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page, _electron } from '@playwright/test';
import { startMockLlm, step, type MockLlmServer } from '@kepcup/testkit';
import { createBotAndOpenChat } from './helpers/create-bot';
import { rmHomeTolerant } from './helpers/home-cleanup';

const HIDDEN_ORIGINAL = 'HIDDEN_ORIGINAL_9f3ac1';
const HIDDEN_PLACEHOLDER = '该消息已被您隐藏';
const VISIBILITY_DB = 'kepcup.message-visibility';
const VISIBILITY_HIDDEN_STORE = 'hidden';
const VISIBILITY_LEGACY_KEY = 'kepcup.message-visibility.v2';
const DRAFTS_DB = 'kepcup.composer-drafts';
const DRAFTS_STORE = 'drafts';

interface IdbEntry {
  key: string;
  value: unknown;
}

/** 只读已有库；库还不存在时不要 open，以免建成无 store 的 v1 空库挡住应用建表。 */
async function idbEntries(page: Page, dbName: string, storeName: string): Promise<IdbEntry[]> {
  return page.evaluate(
    ({ dbName, storeName }) =>
      (async () => {
        const listed = await indexedDB.databases();
        if (!listed.some((database) => database.name === dbName)) return [];
        return new Promise<IdbEntry[]>((resolve, reject) => {
          const request = indexedDB.open(dbName);
          request.onerror = () => reject(request.error ?? new Error('indexeddb open failed'));
          request.onsuccess = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(storeName)) {
              db.close();
              resolve([]);
              return;
            }
            const tx = db.transaction(storeName, 'readonly');
            const store = tx.objectStore(storeName);
            const keysRequest = store.getAllKeys();
            const valuesRequest = store.getAll();
            tx.oncomplete = () => {
              const keys = keysRequest.result;
              const values = valuesRequest.result;
              db.close();
              resolve(keys.map((key, index) => ({ key: String(key), value: values[index] })));
            };
            tx.onabort = () => {
              db.close();
              reject(tx.error ?? new Error('indexeddb transaction aborted'));
            };
          };
        });
      })(),
    { dbName, storeName },
  );
}

async function launchApp(
  home: string,
  llmUrl: string,
): Promise<{ app: ElectronApplication; page: Page }> {
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
      KEPCUP_MOCK_LLM_URL: llmUrl,
    },
  });
  return { app, page: await app.firstWindow() };
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
}

async function openMore(page: Page, bubble: ReturnType<Page['locator']>): Promise<void> {
  const row = bubble.locator('xpath=ancestor::div[@role="group"][1]');
  await row.hover();
  await row.locator('[data-testid="message-more"]').click();
  await expect(page.locator('[data-testid="message-more-menu"]')).toBeVisible();
}

test('Bot message hiding is local, masks quotes/previews, survives restart, and preserves model context', async () => {
  test.setTimeout(300_000);
  const llm: MockLlmServer = await startMockLlm();
  const home = await mkdtemp(path.join(tmpdir(), 'kepcup-e2e-message-hiding-'));
  let launched = await launchApp(home, llm.url);
  try {
    await waitReady(launched.page);
    const { page } = launched;
    const { conversationId } = await createBotAndOpenChat(page, '隐藏测试');
    const composer = page.locator('[data-testid="composer-input"]');

    llm.script('mock-main', [step().replyText(HIDDEN_ORIGINAL)]);
    await composer.fill('生成一条稍后隐藏的回复');
    await composer.press('Enter');
    const firstBubble = page.locator('[data-testid="bot-bubble"]').first();
    await expect(firstBubble).toContainText(HIDDEN_ORIGINAL, { timeout: 30_000 });

    // Quote from the new More menu, then create a user message that quotes the Bot.
    await openMore(page, firstBubble);
    await expect(page.locator('[data-testid="more-message-quote"]')).toBeVisible();
    await expect(page.locator('[data-testid="more-message-pin"]')).toBeVisible();
    await expect(page.locator('[data-testid="more-message-hide"]')).toBeVisible();
    await page.locator('[data-testid="more-message-quote"]').click();
    await expect(page.locator('[data-testid="reply-preview"]')).toContainText(HIDDEN_ORIGINAL);
    await composer.fill('引用这条隐藏消息');
    llm.script('mock-main', [step().replyText('第二条可见回复')]);
    await composer.press('Enter');
    const secondBubble = page.locator('[data-testid="bot-bubble"]').nth(1);
    const secondRow = page.locator('[data-testid^="message-"][role="group"]').filter({
      has: page.locator('[data-testid="bot-bubble"]').filter({ hasText: '第二条可见回复' }),
    });
    await expect(secondBubble).toContainText('第二条可见回复', { timeout: 30_000 });

    // More owns Quote, Pin, and Hide; copy/reaction remain separate hover actions.
    await openMore(page, secondBubble);
    await page.locator('[data-testid="more-message-pin"]').click();
    await expect(page.locator('[data-testid="stickie-card"]')).toContainText('第二条可见回复');
    await page.locator('[data-testid="stickie-close"]').click();
    await openMore(page, secondBubble);
    await page.locator('[data-testid="more-message-quote"]').click();
    await expect(page.locator('[data-testid="reply-preview"]')).toContainText('第二条可见回复');
    await page.locator('[data-testid="reply-cancel"]').click();
    await openMore(page, secondBubble);
    await page.locator('[data-testid="more-message-hide"]').click();
    await expect(page.locator('[data-testid="hidden-message"]')).toHaveCount(1);
    await page.locator('[data-testid="hidden-message"]').click({ button: 'right' });
    await page.locator('[data-testid="context-message-show"]').click();
    await expect(secondBubble).toContainText('第二条可见回复');

    // Narrow layouts keep the context menu instead of hover actions.
    const viewport = page.viewportSize() ?? { width: 1100, height: 800 };
    await page.setViewportSize({ width: 480, height: 800 });
    await expect(page.locator('[data-testid="message-actions"]')).toHaveCount(0);
    await secondBubble.click({ button: 'right' });
    await expect(page.locator('[data-testid="context-message-quote"]')).toBeVisible();
    await page.locator('[data-testid="context-message-quote"]').click();
    await expect(page.locator('[data-testid="reply-preview"]')).toBeVisible();
    await page.locator('[data-testid="reply-cancel"]').click();
    await page.setViewportSize(viewport);

    // Hiding while a reply is active clears both the composer and persisted snapshot.
    await firstBubble.click({ button: 'right' });
    await page.locator('[data-testid="context-message-quote"]').click();
    await expect(page.locator('[data-testid="reply-preview"]')).toContainText(HIDDEN_ORIGINAL);
    await firstBubble.click({ button: 'right' });
    await page.locator('[data-testid="context-message-hide"]').click();
    await expect(page.locator('[data-testid="reply-preview"]')).toHaveCount(0);

    const hidden = page.locator('[data-testid="hidden-message"]').first();
    await expect(hidden).toHaveText(HIDDEN_PLACEHOLDER);
    await expect(hidden).toHaveCSS('opacity', '0.5');
    await expect(hidden).toHaveCSS('padding-top', '4px');
    await expect(hidden).toHaveCSS('padding-bottom', '4px');
    await expect(hidden.locator('svg.lucide-eye-closed')).toHaveCount(1);
    await expect(page.locator('[data-testid="bot-bubble"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="chat-view"]')).not.toContainText(HIDDEN_ORIGINAL);

    const replyRow = page.locator('[data-testid^="message-"][role="group"]').filter({
      has: page.locator('[data-testid="user-bubble"]').filter({ hasText: '引用这条隐藏消息' }),
    });
    const maskedQuote = replyRow.locator('[data-testid="quoted-line"]');
    await expect(maskedQuote).toHaveAttribute('data-quoted-hidden', 'true');
    await expect(maskedQuote).not.toContainText(HIDDEN_ORIGINAL);
    await expect(replyRow.locator('[data-testid^="quoted-media-"]')).toHaveCount(0);

    await hidden.focus();
    await hidden.press('Shift+F10');
    const hiddenMenu = page.locator('[data-testid="message-context-menu"]');
    await expect(hiddenMenu.locator('button')).toHaveCount(1);
    await expect(hiddenMenu).toContainText('显示此消息');
    await expect(page.locator('[data-testid="context-message-hide"]')).toHaveCount(0);
    await page.locator('[data-testid="message-context-backdrop"]').dispatchEvent('click');

    // Hide the latest message too so the persisted sidebar preview is exercised.
    await secondRow.click({ button: 'right' });
    await page.locator('[data-testid="context-message-hide"]').click();
    await expect(page.locator('[data-testid="hidden-message"]')).toHaveCount(2);

    const messageId = await hidden.getAttribute('data-message-id');
    expect(messageId).not.toBeNull();
    await expect
      .poll(async () => {
        const legacy = await page.evaluate(
          (key) => localStorage.getItem(key),
          VISIBILITY_LEGACY_KEY,
        );
        const entries = await idbEntries(page, VISIBILITY_DB, VISIBILITY_HIDDEN_STORE);
        const raw = JSON.stringify(entries);
        return (
          legacy === null &&
          raw.includes(messageId as string) &&
          !raw.includes(HIDDEN_ORIGINAL)
        );
      })
      .toBe(true);
    await expect
      .poll(async () => {
        const entries = await idbEntries(page, DRAFTS_DB, DRAFTS_STORE);
        const draft = entries.find((entry) => entry.key === conversationId)?.value as
          | { reply: { id: string } | null }
          | undefined;
        return draft?.reply ?? null;
      })
      .toBeNull();

    const conversationItem = page
      .locator('[data-testid^="conversation-item-"]')
      .filter({ hasText: '隐藏测试' });
    await expect(conversationItem.locator('[data-testid="conversation-preview"]')).toHaveText(
      HIDDEN_PLACEHOLDER,
    );

    // Restart the same Electron profile and data home.
    await launched.app.close();
    launched = await launchApp(home, llm.url);
    await waitReady(launched.page);
    const restarted = launched.page;
    await expect(restarted.locator('[data-testid="hidden-message"]').first()).toHaveText(
      HIDDEN_PLACEHOLDER,
    );
    await expect(restarted.locator('[data-testid="chat-view"]')).not.toContainText(HIDDEN_ORIGINAL);
    await expect(restarted.locator('[data-testid="reply-preview"]')).toHaveCount(0);
    await expect(
      restarted
        .locator('[data-testid^="conversation-item-"]')
        .filter({ hasText: '隐藏测试' })
        .locator('[data-testid="conversation-preview"]'),
    ).toHaveText(HIDDEN_PLACEHOLDER);

    // The next model request still contains the original hidden Bot text.
    llm.script('mock-main', [
      step()
        .expect((request) => JSON.stringify(request.body.messages).includes(HIDDEN_ORIGINAL))
        .replyText('后续请求仍读取隐藏原文'),
    ]);
    const restartedComposer = restarted.locator('[data-testid="composer-input"]');
    await restartedComposer.fill('继续对话');
    await restartedComposer.press('Enter');
    await expect(restarted.locator('[data-testid="bot-bubble"]').last()).toContainText(
      '后续请求仍读取隐藏原文',
      { timeout: 30_000 },
    );
    expect(llm.requestBodiesContain(HIDDEN_ORIGINAL)).toBe(true);

    const keyboardHidden = restarted.locator('[data-testid="hidden-message"]').first();
    await keyboardHidden.focus();
    await keyboardHidden.press('Enter');
    const keyboardShow = restarted.locator('[data-testid="context-message-show"]');
    await keyboardShow.focus();
    await keyboardShow.press('Enter');
    await expect(restarted.locator('[data-testid="bot-bubble"]').first()).toContainText(
      HIDDEN_ORIGINAL,
    );
  } finally {
    await launched.app.close().catch(() => undefined);
    await llm.stop();
    await rmHomeTolerant(home);
  }
});
