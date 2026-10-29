import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  expect,
  test,
  type ElectronApplication,
  type Page,
  _electron,
} from '@playwright/test';
import { startMockLlm, step, type MockLlmServer } from '@kepcup/testkit';
import { createBotAndOpenChat, dismissStartPanel, openConversationByName, rpc } from './helpers/create-bot';
import { rmHomeTolerant } from './helpers/home-cleanup';

/**
 * P5 盲测验收 e2e（todo/plugin-platform/P5-docs-market.md §3.5）：拿**未接触本仓库的开发者**
 * 仅凭 docs/guides/write-a-plugin.md 产出的 `.kepcup` 产物，走真实应用的完整链路——
 * 扩展中心本地安装（路径输入 → 检视 → 同意面板）→ 同意卡展示声明 config 字段 →
 * 安装引导弹框 → Bot「插件」区块启用 → 会话中 `<skills>` 生效。
 *
 * 产物经环境变量注入，缺省整组跳过（常规测试 / CI 不受影响）：
 *   KEPCUP_BLIND_ARTIFACT=/tmp/blind-test/work/github-repo-summary.kepcup
 *   KEPCUP_BLIND_PLUGIN_ID=io.github.blind.agent/github-repo-summary
 *   KEPCUP_BLIND_SKILL=github-repo-summary
 *   KEPCUP_BLIND_FIELD_TITLE=默认仓库列表
 */

const ARTIFACT = process.env.KEPCUP_BLIND_ARTIFACT ?? '';
const PLUGIN_ID = process.env.KEPCUP_BLIND_PLUGIN_ID ?? '';
const SKILL = process.env.KEPCUP_BLIND_SKILL ?? '';
const FIELD_TITLE = process.env.KEPCUP_BLIND_FIELD_TITLE ?? '';

test.skip(
  ARTIFACT === '' || PLUGIN_ID === '' || SKILL === '' || FIELD_TITLE === '',
  'blind-acceptance runs only with the KEPCUP_BLIND_* env vars set (P5 §3.5)',
);

interface Session {
  app: ElectronApplication;
  page: Page;
  home: string;
  llm: MockLlmServer;
}

async function startSession(prefix: string): Promise<Session> {
  const llm = await startMockLlm();
  const home = await mkdtemp(path.join(tmpdir(), prefix));
  const emptyBuiltin = path.join(home, '.empty-builtin-plugins');
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
      KEPCUP_BUILTIN_PLUGINS: emptyBuiltin,
    },
  });
  const page = await app.firstWindow();
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
  return { app, page, home, llm };
}

async function sendAndAwait(page: Page, text: string, reply: string): Promise<void> {
  const composer = page.locator('[data-testid="composer-input"]');
  await composer.fill(text);
  await composer.press('Enter');
  await expect(page.locator('[data-testid="bot-bubble"]').last()).toContainText(reply, {
    timeout: 30_000,
  });
}

test('blind acceptance: artifact installs, consent shows config field, enables and injects', async () => {
  test.setTimeout(300_000);
  const session = await startSession('kepcup-e2e-blind-acceptance-');
  const { app, page, home, llm } = session;
  try {
    const bot = await createBotAndOpenChat(page, '盲测甲');

    // —— 扩展中心 → 已安装 → 从文件安装（UI 全流程：路径输入 → 检视 → 同意面板）——
    await page.locator('[data-testid="extension-center-button"]').click();
    const dialog = page.locator('[data-testid="extension-center-dialog"]');
    await expect(dialog).toBeVisible();
    await dialog.locator('[data-testid="extension-center-tab-installed"]').click();
    await expect(dialog.locator('[data-testid="extension-installed"]')).toBeVisible();
    await dialog.locator('[data-testid="plugins-install-file"]').click();
    const installDialog = page.locator('[data-testid="plugins-install-dialog"]');
    await expect(installDialog).toBeVisible();
    await installDialog.locator('[data-testid="plugins-install-path"]').fill(ARTIFACT);
    await installDialog.locator('[data-testid="plugins-install-inspect"]').click();

    // —— 同意卡：developer 警示 + 技能 + 声明的 config 字段（P5 §3.5 通过标准②）——
    await expect(
      installDialog.locator('[data-testid="plugins-consent-developer-warn"]'),
    ).toBeVisible({ timeout: 30_000 });
    await expect(installDialog).toContainText(SKILL);
    const configSection = installDialog.locator('[data-testid="plugins-consent-plugin-config"]');
    await expect(configSection).toBeVisible();
    await expect(configSection).toContainText(FIELD_TITLE);

    await installDialog.locator('[data-testid="plugins-install-confirm"]').click();
    await expect(installDialog).toBeHidden({ timeout: 30_000 });

    // —— 安装成功引导弹框（P4）：出现并关闭（启用走 Bot 区块，见下）——
    const hint = page.locator('[data-testid="plugins-install-hint"]');
    await expect(hint).toBeVisible({ timeout: 15_000 });
    await hint.locator('[data-testid="plugins-install-hint-done"]').click();
    await expect(hint).toBeHidden();

    // 已装网格出现插件卡（developer「未审核」徽标）。
    const card = dialog.locator(`[data-testid="plugins-card-${PLUGIN_ID}"]`);
    await expect(card).toBeVisible({ timeout: 30_000 });
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    // —— Bot「插件」区块启用（P5 §3.5 通过标准③）——
    await page.reload();
    await expect(page.locator('[data-testid="ping-result"]')).toContainText('ping ✓', {
      timeout: 60_000,
    });
    await openConversationByName(page, '盲测甲');
    await dismissStartPanel(page);
    if (!(await page.locator('[data-testid="right-panel"]').isVisible())) {
      await page.locator('[data-testid="right-panel-toggle"]').click();
    }
    const back = page.locator('[data-testid="bot-detail-back"]');
    if (await back.isVisible()) await back.click();
    await page.locator('[data-testid="bot-config-row-plugins"]').click();
    const section = page.locator('[data-testid="bot-plugins"]');
    await expect(section).toBeVisible({ timeout: 15_000 });
    const toggle = section.locator(`[data-testid="bot-plugins-toggle-${PLUGIN_ID}"]`);
    await expect(toggle).toBeVisible({ timeout: 15_000 });
    await expect(toggle).toHaveAttribute('data-state', 'unchecked');
    llm.script('mock-main', [step().replyText('盲测回复')]);
    await toggle.click();
    await expect(toggle).toHaveAttribute('data-state', 'checked', { timeout: 15_000 });

    // —— 会话中生效：`<skills>` 注入盲测产物里的技能（P5 §3.5 通过标准④）——
    await sendAndAwait(page, '盲测一句话', '盲测回复');
    const requests = llm.requests().filter((request) => request.model === 'mock-main');
    const latest = requests[requests.length - 1];
    expect(latest).toBeDefined();
    expect(JSON.stringify(latest!.body.messages)).toContain(SKILL);

    const got = (await rpc(page, 'bots.get', { id: bot.botId })) as {
      bot: { profile: { runtime: { plugin_ids?: string[] } } };
    };
    expect(got.bot.profile.runtime.plugin_ids).toEqual([PLUGIN_ID]);
  } finally {
    await app.close();
    await llm.stop();
    await rmHomeTolerant(home);
  }
});
