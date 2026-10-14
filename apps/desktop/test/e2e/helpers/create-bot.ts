import { expect, type Page } from '@playwright/test';
import { botProfile } from '@kepcup/testkit';

type Rpc = (method: string, input?: unknown) => Promise<unknown>;

/** 经测试缝 `__kepcupRpc` 调 core（与 handover / mcp-apps 同路）。 */
export function rpc(page: Page, method: string, input?: unknown): Promise<unknown> {
  return page.evaluate(
    ([m, i]) => (window as unknown as { __kepcupRpc: Rpc }).__kepcupRpc(m as string, i),
    [method, input] as const,
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export type CreateBotOptions = {
  /** 写入 profile.identity.bio（默认 testkit 的「测试 Bot」）。 */
  bio?: string;
};

/**
 * 经 `__kepcupRpc` 创建**非访谈** Bot 并打开其直聊。
 *
 * 替代已移除的侧栏「高级新建」：`bots.create` 不带 `interview`，`setupState` 为
 * null，适合假定「可直聊普通 Bot」的用例。对话式新建（访谈）请继续走 UI 的
 * `start-chat-create-bot`（见 bot-setup / setup-card 访谈用例）。
 */
export async function createBotAndOpenChat(
  page: Page,
  name: string,
  options: CreateBotOptions = {},
): Promise<{ botId: string; conversationId: string }> {
  const profile = botProfile({ name });
  if (options.bio !== undefined) profile.identity.bio = options.bio;

  const created = (await rpc(page, 'bots.create', { profile })) as { bot: { id: string } };
  const opened = (await rpc(page, 'conversations.openDirect', { botId: created.bot.id })) as {
    conversation: { id: string };
  };

  const backdrop = page.locator('[data-testid="start-chat-backdrop"]');
  if (await backdrop.isVisible()) await backdrop.click().catch(() => {});

  // RPC openDirect 只 upsert 左栏，不经过 chat.select——点会话项进入对话。
  const item = page
    .locator('[data-testid^="conversation-item-"]')
    .filter({
      has: page.locator('[data-testid="conversation-name"]', {
        hasText: new RegExp(`^${escapeRegExp(name)}$`),
      }),
    })
    .first();
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();

  await expect(page.locator('[data-testid="chat-view"]')).toBeVisible({ timeout: 15_000 });
  await expect(
    page.locator(
      '[data-testid^="conversation-item-"][data-active="true"] [data-testid="conversation-name"]',
    ),
  ).toHaveText(name, { timeout: 15_000 });

  if (await backdrop.isVisible()) await backdrop.click().catch(() => {});
  await expect(backdrop).toHaveCount(0);

  return { botId: created.bot.id, conversationId: opened.conversation.id };
}
