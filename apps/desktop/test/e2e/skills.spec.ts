import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page, _electron } from '@playwright/test';
import { createSkillRepo, skillFiles, startMockLlm, type MockLlmServer } from '@kepcup/testkit';

/**
 * P08 e2e (docs/dev/phases/P08-skills.md 测试要求「端到端」): the import flow
 * with the skill_import approval card (scan results rendered: source / commit /
 * compatibility / deps / risks), and the right-panel Skills tab (list driven by
 * skills.changed, view SKILL.md, two-step uninstall, enable / disable, and the
 * multi-skill candidate pick).
 * Repos are LOCAL git fixtures created with the system git (testkit
 * createSkillRepo) — the import never touches the real network; no model call
 * happens in these tests (import/approve are pure RPC + approval flows).
 */

interface LaunchedApp {
  app: ElectronApplication;
  page: Page;
  home: string;
}

async function launchApp(options: { home: string; llmUrl: string }): Promise<LaunchedApp> {
  const app = await _electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      KEPCUP_HOME: options.home,
      NODE_ENV: 'test',
      KEPCUP_KEYSTORE: 'file',
      // P13-B e2e seam: 非引导用例不出现首启向导（packaged 产物恒为 on）。
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
  // 等启动恢复收尾：chat-view（恢复了对话）/ 空态引导面板 / 首启向导三者
  // 之一都只在 bootstrap 完成后出现。ping ✓ 早于 bootstrap 结束，慢机器上
  // 直接往下走会与异步尾巴竞态。「+」面板的全屏 backdrop 会拦截后续一切
  // 点击，收尾后确保它已收起（面板只开一次，收掉后不会再出现）。
  await expect(
    page
      .locator('[data-testid="chat-view"]')
      .or(page.locator('[data-testid="start-chat-panel"]'))
      .or(page.locator('[data-testid="onboarding"]')),
  ).toBeVisible({ timeout: 60_000 });
  const startBackdrop = page.locator('[data-testid="start-chat-backdrop"]');
  if (await startBackdrop.isVisible()) {
    // 可能有更高层的模态（如首启沙箱准备向导）盖住 backdrop：收不掉就交给
    // 各测试自己的既有处理（它们大多自带 try-click 收尾），不在这里硬等。
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

  // 「+」面板的自动展开是启动恢复的异步尾巴，可能落在建 Bot 之后（慢机器）；
  // 其全屏 backdrop 会拦截后续一切点击，进入测试主体前确保它已收起。
  const backdrop = page.locator('[data-testid="start-chat-backdrop"]');
  if (await backdrop.isVisible()) await backdrop.click();
  await expect(backdrop).toHaveCount(0);
}

async function openSkillsTab(page: Page): Promise<void> {
  // 右栏默认收起：需要时经顶部药丸展开（toggle 语义，不能盲点）。
  if (!(await page.locator('[data-testid="right-panel-tabs"]').isVisible())) {
    await page.locator('[data-testid="right-panel-toggle"]').click();
  }
  await page.locator('[data-testid="right-panel-tabs"]').locator('text=Skills').click();
  await expect(page.locator('[data-testid="skills-tab"]')).toBeVisible();
}

async function importViaDialog(page: Page, sourceUrl: string): Promise<void> {
  await page.locator('[data-testid="skills-import"]').click();
  const dialog = page.locator('[data-testid="skills-import-dialog"]');
  await expect(dialog).toBeVisible();
  await page.locator('[data-testid="skills-import-url"]').fill(sourceUrl);
  await page.locator('[data-testid="skills-import-submit"]').click();
}

test('import flow: approval card shows scan results; approval lands in the Skills tab; view and uninstall', async () => {
  test.setTimeout(240_000);
  const repo = await createSkillRepo(
    skillFiles('deploy-check', '部署前检查清单技能：执行部署前先按步骤自查', {
      'deploy-check/scripts/upload.sh': '#!/usr/bin/env bash\ncurl -s https://example.com/health\n',
    }),
  );
  const session = await startSession('kepcup-e2e-skills-');
  const { page } = session;
  try {
    await waitReady(page);
    await createBotAndOpenChat(page, '阿技');
    await openSkillsTab(page);
    await expect(page.locator('[data-testid="skills-empty"]')).toBeVisible({ timeout: 15_000 });

    // Import via the dialog (file:// form of the local fixture repo).
    await importViaDialog(page, repo.fileUrl);
    await expect(page.locator('[data-testid="skills-import-dialog"]')).toBeHidden({
      timeout: 60_000,
    });

    // The skill_import card renders the scan results in the approval dock.
    const card = page.locator('[data-testid^="approval-card-"][data-approval-kind="skill_import"]');
    await expect(card).toBeVisible({ timeout: 60_000 });
    await expect(card.locator('[data-testid="approval-skill-name"]')).toHaveText('deploy-check');
    await expect(card.locator('[data-testid="approval-skill-description"]')).toContainText(
      '部署前检查清单',
    );
    await expect(card.locator('[data-testid="approval-skill-source"]')).toContainText('skill-repo');
    await expect(card.locator('[data-testid="approval-skill-commit"]')).toHaveText(
      repo.commitOid().slice(0, 10),
    );
    await expect(card.locator('[data-testid="approval-skill-compat"]')).toContainText('兼容');
    await expect(card.locator('[data-testid="approval-skill-deps"]')).toContainText('bash');
    await expect(card.locator('[data-testid="approval-skill-permissions"]')).toContainText(
      '未声明',
    );
    await expect(card.locator('[data-testid="approval-skill-risks"]')).toContainText('curl');

    // Approve → folded record + system message; skills.changed refreshes the tab.
    await card.locator('[data-testid="approval-approve"]').click();
    const record = page.locator('[data-testid^="approval-record-"]');
    await expect(record).toBeVisible({ timeout: 60_000 });
    await expect(record).toContainText('技能导入请求');

    const item = page
      .locator('[data-testid^="skill-item-"][data-skill-kind]')
      .filter({ hasText: 'deploy-check' });
    await expect(item).toBeVisible({ timeout: 30_000 });
    await expect(item).toHaveAttribute('data-skill-status', 'active');
    await expect(item).toHaveAttribute('data-skill-kind', 'imported');
    await expect(item.locator('[data-testid="skill-kind"]')).toContainText('导入');
    await expect(item.locator('[data-testid="skill-status"]')).toContainText('已启用');
    await expect(item.locator('[data-testid="skill-compat"]')).toContainText('兼容');

    // View SKILL.md (skills.read): the full markdown incl. frontmatter.
    await item.locator('[data-testid="skill-view-deploy-check"]').click();
    const readDialog = page.locator('[data-testid="skills-read-dialog"]');
    await expect(readDialog).toBeVisible();
    await expect(readDialog.locator('[data-testid="skills-read-content"]')).toContainText(
      '# deploy-check',
    );
    await expect(readDialog.locator('[data-testid="skills-read-content"]')).toContainText(
      '部署前检查清单',
    );
    await readDialog.locator('[data-testid="skills-read-close"]').click();

    // Uninstall with the two-step confirm; the list returns to empty.
    await item.locator('[data-testid="skill-uninstall-deploy-check"]').click();
    await expect(page.locator('[data-testid="skills-uninstall-dialog"]')).toBeVisible();
    await page.locator('[data-testid="skills-uninstall-confirm"]').click();
    await expect(page.locator('[data-testid="skills-empty"]')).toBeVisible({ timeout: 30_000 });
  } finally {
    await closeSession(session);
    await repo.cleanup();
  }
});

test('skills tab: multi-skill candidate pick, then enable / disable', async () => {
  test.setTimeout(240_000);
  const repo = await createSkillRepo({
    ...skillFiles('alpha-skill', '技能一：演示多技能仓库'),
    ...skillFiles('beta-skill', '技能二：演示多技能仓库'),
  });
  const session = await startSession('kepcup-e2e-skills-toggle-');
  const { page } = session;
  try {
    await waitReady(page);
    await createBotAndOpenChat(page, '阿停');
    await openSkillsTab(page);

    // Import without a subdirectory → the repository holds two skills, so the
    // dialog lists the candidates and the user picks one.
    await importViaDialog(page, repo.repoDir);
    const candidates = page.locator('[data-testid="skills-import-candidates"]');
    await expect(candidates).toBeVisible({ timeout: 60_000 });
    await expect(
      candidates.locator('[data-testid="skills-import-candidate-alpha-skill"]'),
    ).toBeVisible();
    await expect(
      candidates.locator('[data-testid="skills-import-candidate-beta-skill"]'),
    ).toBeVisible();
    await candidates.locator('[data-testid="skills-import-candidate-use-beta-skill"]').click();

    const card = page.locator('[data-testid^="approval-card-"][data-approval-kind="skill_import"]');
    await expect(card).toBeVisible({ timeout: 60_000 });
    await expect(card.locator('[data-testid="approval-skill-name"]')).toHaveText('beta-skill');
    await expect(card.locator('[data-testid="approval-skill-subdirectory"]')).toHaveText(
      'beta-skill',
    );
    await card.locator('[data-testid="approval-approve"]').click();

    const item = page
      .locator('[data-testid^="skill-item-"][data-skill-kind]')
      .filter({ hasText: 'beta-skill' });
    await expect(item).toBeVisible({ timeout: 30_000 });
    // Only the picked candidate was installed.
    await expect(page.locator('[data-testid="skill-item-alpha-skill"]')).toHaveCount(0);

    // Disable → status flips to 已停用 (skills.disable); the imported skill has
    // no history entry (only authored skills keep git history).
    await expect(item.locator('[data-testid="skill-history-beta-skill"]')).toHaveCount(0);
    await item.locator('[data-testid="skill-disable-beta-skill"]').click();
    await expect(item).toHaveAttribute('data-skill-status', 'disabled', { timeout: 30_000 });
    await expect(item.locator('[data-testid="skill-status"]')).toContainText('已停用');

    // Re-enable.
    await item.locator('[data-testid="skill-enable-beta-skill"]').click();
    await expect(item).toHaveAttribute('data-skill-status', 'active', { timeout: 30_000 });
    await expect(item.locator('[data-testid="skill-status"]')).toContainText('已启用');
  } finally {
    await closeSession(session);
    await repo.cleanup();
  }
});

test('P12: a skill declaring sandbox: enhanced is incompatible while the enhanced backend is missing, with the install hint', async () => {
  test.setTimeout(240_000);
  // frontmatter 声明 sandbox: enhanced（真实扫描判定；本机未装 Lima → 不兼容）。
  const files: Record<string, string> = {
    'vm-hardened/SKILL.md': [
      '---',
      'name: vm-hardened',
      'description: 需要增强沙箱的技能：在虚拟机级隔离中运行',
      'sandbox: enhanced',
      '---',
      '',
      '# vm-hardened',
    ].join('\n'),
    'vm-hardened/scripts/run.sh': '#!/usr/bin/env bash\necho enhanced-ok\n',
  };
  const repo = await createSkillRepo(files);
  const session = await startSession('kepcup-e2e-skills-enhanced-');
  const { page } = session;
  try {
    await waitReady(page);
    await createBotAndOpenChat(page, '阿强');
    await openSkillsTab(page);
    await expect(page.locator('[data-testid="skills-empty"]')).toBeVisible({ timeout: 15_000 });

    await importViaDialog(page, repo.fileUrl);
    const card = page.locator('[data-testid^="approval-card-"][data-approval-kind="skill_import"]');
    await expect(card).toBeVisible({ timeout: 60_000 });
    await card.locator('[data-testid="approval-approve"]').click();

    // 增强级未安装：条目 incompatible + 可安装提示（enhancedInstallHint 契约）。
    const item = page
      .locator('[data-testid^="skill-item-"][data-skill-kind]')
      .filter({ hasText: 'vm-hardened' });
    await expect(item).toBeVisible({ timeout: 30_000 });
    await expect(item).toHaveAttribute('data-skill-status', 'incompatible', { timeout: 30_000 });
    await expect(item.locator('[data-testid="skill-compat"]')).toContainText('不兼容');
    const hint = item.locator('[data-testid="skill-enhanced-hint"]');
    await expect(hint).toBeVisible();
    await expect(hint).toContainText('增强沙箱');
  } finally {
    await closeSession(session);
    await repo.cleanup();
  }
});
