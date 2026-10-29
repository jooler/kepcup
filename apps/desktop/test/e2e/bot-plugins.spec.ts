import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page,
  _electron,
} from '@playwright/test';
import { buildPluginFixture, startMockLlm, step, type MockLlmServer } from '@kepcup/testkit';
import { createBotAndOpenChat, dismissStartPanel, openConversationByName, rpc } from './helpers/create-bot';
import { createProjectViaUi } from './helpers/create-project';
import { rmHomeTolerant } from './helpers/home-cleanup';

/**
 * D105 P2 注入模型 e2e（todo/plugin-platform/P2-injection.md 验收）：
 * - Bot 详情「插件」区块：启用开关写 `plugins.setBotPlugins`；未启用的插件技能
 *   不进 `<skills>`（mock LLM 记录的请求断言），启用后进入，停用后同步消失；
 * - 项目组「插件」分区：叠加授权只在本项目会话生效（成员 Bot 私聊不受影响、
 *   个人 plugin_ids 不被改写）。
 */

const PLUGIN_ID = 'io.github.tester/inject-fx';
const SKILL = 'plg-inject';

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

async function closeSession(session: Session): Promise<void> {
  await session.app.close();
  await session.llm.stop();
  await rmHomeTolerant(session.home);
}

async function makeFixture(): Promise<{ path: string; sha256: string }> {
  const built = await buildPluginFixture({
    dir: await mkdtemp(path.join(tmpdir(), 'kepcup-e2e-bot-plugins-fx-')),
    manifest: { id: PLUGIN_ID },
    skills: [{ name: SKILL, description: '注入验证技能' }],
  });
  return { path: built.path, sha256: built.sha256 };
}

async function installPlugin(page: Page): Promise<void> {
  const fixture = await makeFixture();
  await rpc(page, 'plugins.install', {
    source: { kind: 'file', path: fixture.path },
    sha256: fixture.sha256,
    userConfig: {},
  });
}

/** 主模型最近的请求里，`<skills>` 段是否含插件技能。 */
async function skillInjected(llm: MockLlmServer, skill: string): Promise<boolean> {
  const requests = llm.requests().filter((request) => request.model === 'mock-main');
  const latest = requests[requests.length - 1];
  if (latest === undefined) throw new Error('no mock-main request recorded');
  return JSON.stringify(latest.body.messages).includes(`<skill>${skill}</skill>`) ||
    JSON.stringify(latest.body.messages).includes(skill);
}

async function sendAndAwait(page: Page, text: string, reply: string): Promise<void> {
  const composer = page.locator('[data-testid="composer-input"]');
  await composer.fill(text);
  await composer.press('Enter');
  await expect(page.locator('[data-testid="bot-bubble"]').last()).toContainText(reply, {
    timeout: 30_000,
  });
}

async function openBotPluginsSection(page: Page): Promise<Locator> {
  if (!(await page.locator('[data-testid="right-panel"]').isVisible())) {
    await page.locator('[data-testid="right-panel-toggle"]').click();
  }
  const back = page.locator('[data-testid="bot-detail-back"]');
  if (await back.isVisible()) await back.click();
  await page.locator('[data-testid="bot-config-row-plugins"]').click();
  const section = page.locator('[data-testid="bot-plugins"]');
  await expect(section).toBeVisible({ timeout: 15_000 });
  return section;
}


test('bot plugins: add / remove gates the <skills> injection', async () => {
  test.setTimeout(240_000);
  const session = await startSession('kepcup-e2e-bot-plugins-');
  const { page, llm } = session;
  try {
    const bot = await createBotAndOpenChat(page, '插件甲');
    await installPlugin(page);
    await page.reload();
    await expect(page.locator('[data-testid="ping-result"]')).toContainText('ping ✓', {
      timeout: 60_000,
    });
    await openConversationByName(page, '插件甲');
    await dismissStartPanel(page);

    // 「插件」区块：默认没有添加任何插件（已装插件只在「添加」弹框里列出）。
    const section = await openBotPluginsSection(page);
    await expect(section.locator(`[data-testid="bot-plugins-${PLUGIN_ID}"]`)).toHaveCount(0);
    await expect(section.locator('[data-testid="bot-plugins-none-added"]')).toBeVisible();

    // 未添加：技能不进 <skills>。
    llm.script('mock-main', [step().replyText('回复一')]);
    await sendAndAwait(page, '第一句', '回复一');
    expect(await skillInjected(llm, SKILL)).toBe(false);

    // 添加弹框：已装插件卡片 + 添加到 Bot（幂等，已添加显示绿色状态）。
    await section.locator('[data-testid="bot-plugins-add"]').click();
    const dialog = page.locator('[data-testid="bot-plugins-add-dialog"]');
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await dialog.locator('[data-testid="bot-plugins-add-search"]').fill(PLUGIN_ID);
    const addButton = dialog.locator(`[data-testid="bot-plugins-add-to-bot-${PLUGIN_ID}"]`);
    await expect(addButton).toContainText('添加到 Bot');
    await addButton.click();
    await expect(addButton).toContainText('已添加给该 Bot', { timeout: 15_000 });
    await dialog.locator('[data-testid="bot-plugins-add-done"]').click();

    // 已添加：插件出现在列表里，技能进入 <skills>（profile 只改 plugin_ids）。
    const row = section.locator(`[data-testid="bot-plugins-${PLUGIN_ID}"]`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(
      row.locator(`[data-testid="bot-plugins-kind-skill-${PLUGIN_ID}"]`),
    ).toBeVisible();
    llm.script('mock-main', [step().replyText('回复二')]);
    await sendAndAwait(page, '第二句', '回复二');
    expect(await skillInjected(llm, SKILL)).toBe(true);
    const got = (await rpc(page, 'bots.get', { id: bot.botId })) as {
      bot: { profile: { runtime: { plugin_ids?: string[] } } };
    };
    expect(got.bot.profile.runtime.plugin_ids).toEqual([PLUGIN_ID]);

    // 移除：技能同步消失。
    llm.script('mock-main', [step().replyText('回复三')]);
    await row.locator(`[data-testid="bot-plugins-remove-${PLUGIN_ID}"]`).click();
    await expect(row).toHaveCount(0, { timeout: 15_000 });
    await sendAndAwait(page, '第三句', '回复三');
    expect(await skillInjected(llm, SKILL)).toBe(false);
  } finally {
    await closeSession(session);
  }
});

test('project plugins: overlay authorizes inside the project conversation only', async () => {
  test.setTimeout(240_000);
  const session = await startSession('kepcup-e2e-project-plugins-');
  const { page, llm } = session;
  try {
    const bot = await createBotAndOpenChat(page, '项目甲');
    await createBotAndOpenChat(page, '项目乙');
    await installPlugin(page);
    await page.reload();
    await expect(page.locator('[data-testid="ping-result"]')).toContainText('ping ✓', {
      timeout: 60_000,
    });
    await createProjectViaUi(page, '插件项目', ['项目甲', '项目乙']);

    // 项目设置「插件」分区：叠加授权开关（成员 Bot 个人 plugin_ids 保持未设）。
    await page.locator('[data-testid="project-settings-button"]').click();
    await expect(page.locator('[data-testid="project-settings-page"]')).toBeVisible();
    await page.locator('[data-testid="project-settings-nav-plugins"]').click();
    await expect(page.locator('[data-testid="project-settings-section-plugins"]')).toBeVisible();
    const toggle = page.locator(`[data-testid="project-plugins-toggle-${PLUGIN_ID}"]`);
    await expect(toggle).toBeVisible({ timeout: 15_000 });
    await toggle.click();
    await expect(toggle).toHaveAttribute('data-state', 'checked', { timeout: 15_000 });
    const got = (await rpc(page, 'bots.get', { id: bot.botId })) as {
      bot: { profile: { runtime: { plugin_ids?: string[] } } };
    };
    expect(got.bot.profile.runtime.plugin_ids).toBeUndefined();

    // 回到项目会话（设置页是 master-detail，占住主区）。
    await openConversationByName(page, '插件项目');

    // 项目会话：@ 项目甲 —— 叠加授权生效（技能进入 <skills>）。
    const composer = page.locator('[data-testid="composer-input"]');
    llm.script('mock-main', [
      step()
        .expect((r) => JSON.stringify(r.body.messages).includes('名字：项目甲'))
        .replyText('项目内收到'),
    ]);
    await composer.click();
    await composer.pressSequentially('@项目甲');
    await page
      .locator('[data-testid="mention-popup"] button')
      .filter({ hasText: '项目甲' })
      .first()
      .click();
    await composer.pressSequentially(' 看看技能');
    await composer.press('Meta+Enter');
    await expect(page.locator('[data-testid="bot-bubble"]').last()).toContainText('项目内收到', {
      timeout: 30_000,
    });
    expect(await skillInjected(llm, SKILL)).toBe(true);

    // 同一 Bot 的私聊：叠加授权不生效。
    await openConversationByName(page, '项目甲');
    await dismissStartPanel(page);
    llm.script('mock-main', [step().replyText('私聊收到')]);
    await sendAndAwait(page, '私聊一句', '私聊收到');
    expect(await skillInjected(llm, SKILL)).toBe(false);
  } finally {
    await closeSession(session);
  }
});
