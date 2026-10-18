import { expect, type Page } from '@playwright/test';
import { projectTitleFromMemberNames } from '@kepcup/shared';

/**
 * 新建项目组（双轮，「+」→ 新建项目组）：第一轮点负责人，第二轮点其余成
 * 员，空回车创建。默认标题 = `projectTitleFromMemberNames([负责人, …其余成员])`
 * （排第一位的是负责人）；测试要自定义标题时，创建后经 ⚙ 详情页改名。
 * `memberNames` 的第一个默认是负责人（`leadName`）。
 */
export async function createProjectViaUi(
  page: Page,
  title: string,
  memberNames: string[],
  leadName = memberNames[0] ?? '',
): Promise<void> {
  await page.locator('[data-testid="new-chat-button"]').click();
  await page.locator('[data-testid="start-chat-create-project"]').click();
  const menu = page.locator('[data-testid="project-compose-menu"]');
  await expect(menu).toBeVisible({ timeout: 15_000 });
  const phase = page.locator('[data-testid="project-compose-phase"]');

  // 第一轮：点负责人，进入第二轮（成员多选）。
  await menu.locator('button', { hasText: leadName }).first().click();
  await expect(phase).toHaveAttribute('data-phase', 'members', { timeout: 5_000 });

  // 第二轮：除负责人外的每个成员点选；空回车创建。
  for (const name of memberNames) {
    if (name === leadName) continue;
    await menu.locator('button', { hasText: name }).first().click();
  }
  await page.locator('[data-testid="project-compose-input"]').press('Enter');

  const autoTitle = projectTitleFromMemberNames([
    leadName,
    ...memberNames.filter((name) => name !== leadName),
  ]);
  // 顶栏不再显示项目名，标题经侧栏当前会话名断言。
  const activeName = page.locator(
    '[data-testid^="conversation-item-"][data-active="true"] [data-testid="conversation-name"]',
  );
  await expect(activeName).toContainText(autoTitle, { timeout: 15_000 });
  if (title === autoTitle) return;

  // 自定义标题：经 ⚙ 打开详情页改名（回车保存），再回沟通。
  await page.locator('[data-testid="project-settings-button"]').click();
  const titleInput = page.locator('[data-testid="project-title-input"]');
  await expect(titleInput).toBeVisible({ timeout: 15_000 });
  await titleInput.fill(title);
  await titleInput.press('Enter');
  await expect(activeName).toContainText(title, { timeout: 15_000 });
  await page.locator('[data-testid="project-tab-chat"]').click();
  await expect(page.locator('[data-testid="project-view"]')).toHaveAttribute(
    'data-view',
    'chat',
    { timeout: 15_000 },
  );
}
