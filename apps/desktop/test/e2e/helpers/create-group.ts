import { expect, type Page } from '@playwright/test';
import { groupTitleFromMemberNames } from '@kepcup/shared';

/**
 * 新建群聊：顶部输入里点选成员，空回车创建。群名默认是成员名用逗号拼接；
 * 测试若要一个自定义标题，创建后再从右栏改名。
 */
export async function createGroupViaUi(
  page: Page,
  title: string,
  memberNames: string[],
): Promise<void> {
  await page.locator('[data-testid="new-chat-button"]').click();
  await page.locator('[data-testid="start-chat-create-group"]').click();
  const menu = page.locator('[data-testid="group-compose-menu"]');
  await expect(menu).toBeVisible({ timeout: 15_000 });
  for (const name of memberNames) {
    await menu.locator('button', { hasText: name }).first().click();
  }
  await page.locator('[data-testid="group-compose-input"]').press('Enter');

  const autoTitle = groupTitleFromMemberNames(memberNames);
  await expect(
    page.locator('[data-testid="conversation-name"]', { hasText: autoTitle }),
  ).toBeVisible({ timeout: 15_000 });
  if (title === autoTitle) return;

  if (!(await page.locator('[data-testid="group-info"]').isVisible())) {
    await page.locator('[data-testid="right-panel-toggle"]').click();
  }
  const titleInput = page.locator('[data-testid="group-info-title"]');
  await titleInput.fill(title);
  await titleInput.press('Enter');
  await expect(page.locator('[data-testid="conversation-name"]', { hasText: title })).toBeVisible({
    timeout: 15_000,
  });
}
