import { expect, type Page } from '@playwright/test';
import { botProfile } from '@kepcup/testkit';

type Rpc = (method: string, input?: unknown) => Promise<unknown>;

/** 经测试缝 `__kepcupRpc` 调 core（renderer `main.ts` 在测试模式下挂到 window）。 */
export function rpc(page: Page, method: string, input?: unknown): Promise<unknown> {
  return page.evaluate(
    ([m, i]) => (window as unknown as { __kepcupRpc: Rpc }).__kepcupRpc(m as string, i),
    [method, input] as const,
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 收起「+」面板的全屏 backdrop。面板的自动展开是启动恢复的异步尾巴，可能在
 * 一次检查之后才出现，所以在重试里反复「看见就点掉」，直到它确实不在。
 */
export async function dismissStartPanel(page: Page, timeout = 15_000): Promise<void> {
  const backdrop = page.locator('[data-testid="start-chat-backdrop"]');
  await expect(async () => {
    if (await backdrop.isVisible()) await backdrop.click({ timeout: 2_000 }).catch(() => {});
    await expect(backdrop).toHaveCount(0, { timeout: 1_000 });
  }).toPass({ timeout });
}

/**
 * 在左栏按会话名**精确**匹配（预览行里可能出现别的 Bot 的名字）点开会话，并等
 * 它成为当前会话。点击放在重试里：backdrop 若在点击前一刻冒出来会拦截点击。
 */
export async function openConversationByName(page: Page, name: string): Promise<void> {
  const item = page
    .locator('[data-testid^="conversation-item-"]')
    .filter({
      has: page.locator('[data-testid="conversation-name"]', {
        hasText: new RegExp(`^${escapeRegExp(name)}$`),
      }),
    })
    .first();
  await expect(item).toBeVisible({ timeout: 15_000 });
  const activeName = page.locator(
    '[data-testid^="conversation-item-"][data-active="true"] [data-testid="conversation-name"]',
  );
  await expect(async () => {
    await dismissStartPanel(page, 5_000);
    await item.click({ timeout: 2_000 });
    // 窄屏下进入详情层后左栏列表整个卸载，看不到 data-active；此时以列表项消失
    // 且 chat-view 出现为准。
    await expect
      .poll(
        async () =>
          (await activeName.count()) > 0
            ? await activeName.first().innerText()
            : (await item.count()) === 0 &&
                (await page.locator('[data-testid="chat-view"]').isVisible())
              ? name
              : null,
        { timeout: 2_000 },
      )
      .toBe(name);
  }).toPass({ timeout: 15_000 });
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

  // RPC openDirect 只 upsert 左栏，不经过 chat.select——点会话项进入对话。
  await openConversationByName(page, name);
  await expect(page.locator('[data-testid="chat-view"]')).toBeVisible({ timeout: 15_000 });
  await dismissStartPanel(page);

  return { botId: created.bot.id, conversationId: opened.conversation.id };
}
