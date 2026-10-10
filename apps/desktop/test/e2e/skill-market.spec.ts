import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page, _electron } from '@playwright/test';
import { startMockLlm } from '@kepcup/testkit';

/**
 * 技能市场 e2e：左栏底部「技能市场」入口 → marketplace 弹框 → 点「添加」
 * 安装为公共技能（public_skills：一次安装所有 Bot 可用，无审批卡片）→ 按钮
 * 翻转为「已添加」→ 右栏技能面板出现且 active、带「公共」徽标。预置目录用
 * 夹具（与 skills.spec 的本地 git 夹具同理，绝不触网、无模型调用）。
 */

async function writePresetDir(root: string): Promise<string> {
  const presetDir = path.join(root, 'presets');
  await mkdir(path.join(presetDir, 'market-demo'), { recursive: true });
  await writeFile(
    path.join(presetDir, 'catalog.json'),
    JSON.stringify({
      version: 1,
      presets: [
        {
          id: 'market-demo',
          dir: 'market-demo',
          section: 'starter',
          displayName: '市场演示',
          summary: '端到端夹具技能',
          icon: 'puzzle',
          version: '1.0.0',
          tryIt: '把素材丢给我',
        },
      ],
    }),
  );
  await writeFile(
    path.join(presetDir, 'market-demo', 'SKILL.md'),
    '---\nname: market-demo\ndescription: 技能市场端到端夹具技能\n---\n正文',
  );
  return presetDir;
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
  const startBackdrop = page.locator('[data-testid="start-chat-backdrop"]');
  if (await startBackdrop.isVisible()) {
    await startBackdrop.click({ timeout: 2_000 }).catch(() => {});
  }
}

async function createBotAndOpenChat(page: Page, name: string): Promise<void> {
  await page.locator('[data-testid="new-chat-button"]').click();
  await page.locator('[data-testid="bot-create-form"]').click();
  await expect(page.locator('[data-testid="bot-create-dialog"]')).toBeVisible();
  await page.locator('[data-testid="bot-create-dialog"] [data-testid="bot-name-input"]').fill(name);
  await page.locator('[data-testid="bot-create-save"]').click();
  await expect(page.locator('[data-testid="chat-view"]')).toBeVisible({ timeout: 15_000 });
  const backdrop = page.locator('[data-testid="start-chat-backdrop"]');
  if (await backdrop.isVisible()) await backdrop.click();
  await expect(backdrop).toHaveCount(0);
}

test('skill market: sidebar entry → dialog → add installs a PUBLIC skill → Skills tab shows it active with the public badge', async () => {
  test.setTimeout(240_000);
  const llm = await startMockLlm();
  const home = await mkdtemp(path.join(tmpdir(), 'kepcup-e2e-market-'));
  const presetDir = await writePresetDir(home);
  let app: ElectronApplication | null = null;
  try {
    app = await _electron.launch({
      args: ['.'],
      env: {
        ...process.env,
        KEPCUP_HOME: home,
        NODE_ENV: 'test',
        KEPCUP_KEYSTORE: 'file',
        KEPCUP_ONBOARDING: 'off',
        KEPCUP_FILE_KEYSTORE_PATH: path.join(home, '.test-master-key'),
        KEPCUP_MOCK_LLM_URL: llm.url,
        KEPCUP_PRESET_SKILLS: presetDir,
      },
    });
    const page = await app.firstWindow();
    await waitReady(page);
    await createBotAndOpenChat(page, '阿市');

    // 左栏底部入口 → 弹框（公共作用域：没有目标 Bot 选择器）。
    await page.locator('[data-testid="skill-market-button"]').click();
    const dialog = page.locator('[data-testid="skill-market-dialog"]');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('[data-testid="skill-market-bot-select"]')).toHaveCount(0);

    // 办公起步包分区 + 条目渲染（图标位 / 一句话 / 本地即可标签）。
    const item = dialog.locator('[data-testid="skill-market-item-market-demo"]');
    await expect(item).toBeVisible({ timeout: 30_000 });
    await expect(item).toContainText('市场演示');
    await expect(item).toContainText('端到端夹具技能');
    await expect(item).toContainText('本地即可');

    // 搜索命中与空态。
    await dialog.locator('[data-testid="skill-market-search"]').fill('找不到的词');
    await expect(dialog.locator('[data-testid="skill-market-empty"]')).toBeVisible();
    await dialog.locator('[data-testid="skill-market-search"]').fill('市场演示');

    // 点弹框外部（遮罩）不关闭：管理面板只留 ✕ 与 Esc（onInteractOutside preventDefault）。
    await page.mouse.click(20, 300);
    await expect(dialog).toBeVisible();

    // 添加 → 安装为公共技能（无审批卡片），按钮翻转为已添加。
    await item.locator('[data-testid="skill-market-add-market-demo"]').click();
    await expect(item.locator('[data-testid="skill-market-added-market-demo"]')).toBeVisible({
      timeout: 30_000,
    });

    // 关闭重开：全局安装态持久（从 core 重新加载）。
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden({ timeout: 15_000 });
    await page.locator('[data-testid="skill-market-button"]').click();
    await expect(item).toBeVisible({ timeout: 30_000 });
    await expect(item.locator('[data-testid="skill-market-added-market-demo"]')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden({ timeout: 15_000 });

    // 右栏技能面板：条目存在、active、公共作用域（skills.changed 驱动的同一数据源）。
    if (!(await page.locator('[data-testid="right-panel-tabs"]').isVisible())) {
      await page.locator('[data-testid="right-panel-toggle"]').click();
    }
    await page.locator('[data-testid="right-panel-tabs"]').locator('text=Skills').click();
    await expect(page.locator('[data-testid="skills-tab"]')).toBeVisible();
    const skillItem = page.locator('[data-testid="skill-item-market-demo"]');
    await expect(skillItem).toBeVisible({ timeout: 30_000 });
    await expect(skillItem).toHaveAttribute('data-skill-status', 'active');
    await expect(skillItem).toHaveAttribute('data-skill-kind', 'imported');
    await expect(skillItem).toHaveAttribute('data-skill-scope', 'public');
    await expect(skillItem.locator('[data-testid="skill-scope"]')).toContainText('公共');
  } finally {
    await app?.close();
    await llm.stop();
    await rm(home, { recursive: true, force: true });
  }
});
