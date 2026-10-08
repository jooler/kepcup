import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page, _electron } from '@playwright/test';
import {
  agentTurn,
  FAKE_ACP_AGENT_BIN,
  readFakeAgentRecord,
  writeFakeAgentScript,
  type FakeAgentObservation,
  type FakeAgentScript,
} from '@kepcup/testkit';

/**
 * 外部智能体（D72，todo/acp-external-agents.md §9.1 e2e）：testkit 的剧本化假
 * ACP 智能体经 core 的 e2e seam（KEPCUP_FAKE_ACP_AGENT_*，仅测试构建）挂在目录
 * 的 `fake` / `fake-sub` 条目上，子进程以 Electron 的 Node 运行。不配内置模型
 * （KEPCUP_MOCK_LLM_URL=''）——只有智能体的新用户。覆盖：设置页目录启用 +
 * 后台任务、Bot 切换到智能体与能力包、`agent_tool` 审批卡、对话内 Agent 设置
 * 卡、onboarding「我有订阅」分支。
 */

interface Session {
  app: ElectronApplication;
  page: Page;
  home: string;
  outside: string;
  record: () => FakeAgentObservation;
  close: () => Promise<void>;
}

async function startSession(
  prefix: string,
  script: FakeAgentScript | ((outside: string) => FakeAgentScript),
  options: { onboarding?: boolean } = {},
): Promise<Session> {
  const home = await mkdtemp(path.join(tmpdir(), prefix));
  // Outside the data directory (agent_tool cards ask for paths out there).
  const outside = await mkdtemp(path.join(tmpdir(), `${prefix}outside-`));
  const scriptFile = path.join(home, 'fake-acp-agent.json');
  const recordFile = path.join(home, 'fake-acp-agent.jsonl');
  writeFakeAgentScript(scriptFile, typeof script === 'function' ? script(outside) : script);
  const app = await _electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      KEPCUP_HOME: home,
      NODE_ENV: 'test',
      KEPCUP_KEYSTORE: 'file',
      KEPCUP_FILE_KEYSTORE_PATH: path.join(home, '.test-master-key'),
      ...(options.onboarding === true ? {} : { KEPCUP_ONBOARDING: 'off' }),
      // 无内置模型：seedMockLlm 跳过。
      KEPCUP_MOCK_LLM_URL: '',
      KEPCUP_FAKE_ACP_AGENT_BIN: FAKE_ACP_AGENT_BIN,
      KEPCUP_FAKE_ACP_AGENT_SCRIPT: scriptFile,
      KEPCUP_FAKE_ACP_AGENT_RECORD: recordFile,
    },
  });
  const page = await app.firstWindow();
  return {
    app,
    page,
    home,
    outside,
    record: () => readFakeAgentRecord(recordFile),
    close: async () => {
      await app.close();
      await rm(home, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    },
  };
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

async function openSettings(page: Page, section: string): Promise<void> {
  await page.locator('[data-testid="user-menu-trigger"]').click();
  await page.locator('[data-testid="menu-settings"]').click();
  await expect(page.locator('[data-testid="settings-page-content"]')).toBeVisible();
  await page.locator(`[data-testid="settings-nav-${section}"]`).click();
}

async function closeSettings(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-testid="settings-dialog"]')).toHaveCount(0);
}

/**
 * 设置页「智能体」：开实验开关 → 目录卡片启用（安装确认卡）→ 就绪；后台任务
 * 关闭（假 Agent 的剧本只给对话用，反思 / 摘要不消耗它的回合）。
 */
async function enableFakeAgent(page: Page, agentId = 'fake'): Promise<void> {
  await openSettings(page, 'agents');
  const section = page.locator('[data-testid="agents-section"]');
  await expect(section).toBeVisible();
  const experimental = page.locator('[data-testid="agents-experimental"] button[role="checkbox"]');
  if ((await experimental.getAttribute('aria-checked')) !== 'true') await experimental.click();
  const card = page.locator(`[data-testid="agent-card-${agentId}"]`);
  await expect(card).toBeVisible({ timeout: 15_000 });
  await page.locator(`[data-testid="agent-enable-${agentId}"]`).click();
  await expect(page.locator('[data-testid="agent-install-dialog"]')).toBeVisible();
  await page.locator('[data-testid="agent-install-confirm"]').click();
  await expect(page.locator(`[data-testid="agent-status-${agentId}"]`)).toHaveText('就绪', {
    timeout: 30_000,
  });
  // 后台任务（P6）：选「关闭」并确认已保存。
  const background = page.locator('[data-testid="background-tasks-agent-select"]');
  await expect(background).toBeVisible();
  await background.selectOption('off');
  await expect(background).toHaveValue('off');
  await expect(page.locator('[data-testid="background-tasks-skill-authoring"]')).toHaveCount(0);
  await closeSettings(page);
}

async function createBot(page: Page, name: string): Promise<void> {
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

async function openProfileTab(page: Page): Promise<void> {
  if (!(await page.locator('[data-testid="right-panel-tabs"]').isVisible())) {
    await page.locator('[data-testid="right-panel-toggle"]').click();
  }
  await page.locator('[data-testid="right-panel-tabs"]').locator('text=配置').click();
  await expect(page.locator('[data-testid="profile-tab"]')).toBeVisible();
}

/** Bot 运行配置：主模型下拉改选智能体（首次切换弹让渡说明）。 */
async function switchBotToAgent(page: Page, agentId = 'fake'): Promise<void> {
  await openProfileTab(page);
  const profile = page.locator('[data-testid="profile-tab"]');
  await profile.locator('[data-testid="bot-model-select"]').selectOption(`@agent:${agentId}`);
  const dialog = page.locator('[data-testid="bot-agent-switch-dialog"]');
  if (await dialog.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await page.locator('[data-testid="bot-agent-switch-confirm"]').click();
  }
  await expect(profile.locator('[data-testid="bot-agent-settings"]')).toBeVisible();
  // 右栏表单自动保存（500ms 防抖）：等它落盘再发消息。
  await page.waitForTimeout(1_500);
}

/** Enter on text queues a draft; Enter on the empty input sends the queue. */
async function send(page: Page, text: string): Promise<void> {
  const composer = page.locator('[data-testid="composer-input"]');
  await composer.fill(text);
  await composer.press('Enter');
  await expect(page.locator('[data-testid="draft-text"]').filter({ hasText: text })).toHaveCount(1);
  await composer.press('Enter');
}

const botBubble = (page: Page, text: string) =>
  page.locator('[data-testid="bot-bubble"]').filter({ hasText: text }).first();

test('settings catalog: enable the agent, background tasks; bot switches to it with capability packs', async () => {
  test.setTimeout(240_000);
  const session = await startSession('kepcup-e2e-agents-', {
    turns: [agentTurn().mcpList().text('你好，我是外援。')],
  });
  const { page } = session;
  try {
    await waitReady(page);
    await enableFakeAgent(page);
    await createBot(page, '外援');
    await switchBotToAgent(page);

    // 能力包：core 灰显必选；勾掉「图像生成」后工具数随之变化（自动保存）。
    const profile = page.locator('[data-testid="profile-tab"]');
    await expect(profile.locator('[data-testid="bot-agent-capability-core"]')).toBeDisabled();
    const imageGen = profile.locator('[data-testid="bot-agent-capability-image_generation"]');
    const countBefore = await profile.locator('[data-testid="bot-agent-tool-count"]').innerText();
    if ((await imageGen.getAttribute('aria-checked')) === 'true') {
      await imageGen.click();
      await expect(profile.locator('[data-testid="bot-agent-tool-count"]')).not.toHaveText(
        countBefore,
      );
    }
    await expect(imageGen).toHaveAttribute('aria-checked', 'false');
    await page.waitForTimeout(1_500);

    // 对话由智能体驱动：回复来自假 Agent；宿主桥上看不到被取消的包。
    await send(page, '在吗');
    await expect(botBubble(page, '你好，我是外援。')).toBeVisible({ timeout: 60_000 });
    await expect
      .poll(() => session.record().mcp.find((entry) => entry.method === 'tools/list') !== undefined)
      .toBe(true);
    const listed = session.record().mcp.find((entry) => entry.method === 'tools/list')!
      .result as Array<{ name: string }>;
    expect(listed.map((tool) => tool.name)).toContain('send_message');
    expect(listed.map((tool) => tool.name)).not.toContain('generate_image');
  } finally {
    await session.close();
  }
});

test('agent_tool approval card: an out-of-workspace write asks the user; approval reaches the agent', async () => {
  test.setTimeout(240_000);
  const session = await startSession('kepcup-e2e-agent-tool-', (outside) => {
    const target = path.join(outside, 'note.txt');
    return {
      turns: [
        agentTurn()
          .permission('w1', `Write ${target}`, { kind: 'edit', locations: [target] })
          .text('写好了。'),
      ],
    };
  });
  const { page } = session;
  try {
    await waitReady(page);
    await enableFakeAgent(page);
    await createBot(page, '外援');
    await switchBotToAgent(page);

    await send(page, '帮我在外面写个文件');
    const card = page.locator('[data-testid^="approval-card-"]').first();
    await expect(card).toBeVisible({ timeout: 60_000 });
    await expect(card.locator('[data-testid="approval-agent-tool-paths"]')).toContainText(
      'note.txt',
    );
    await card.locator('[data-testid="approval-approve"]').click();
    await expect(botBubble(page, '写好了。')).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => JSON.stringify(session.record().permissions)).toContain('allow');
  } finally {
    await session.close();
  }
});

test('in-chat agent setup card: a disabled agent holds the draft; enabling in the card sends it', async () => {
  test.setTimeout(240_000);
  const session = await startSession('kepcup-e2e-agent-setup-', {
    turns: [agentTurn().text('设置好了，我来了。')],
  });
  const { page } = session;
  try {
    await waitReady(page);
    await enableFakeAgent(page);
    await createBot(page, '外援');
    await switchBotToAgent(page);

    // 设置页停用（有 Bot 在用 → 确认框）。
    await openSettings(page, 'agents');
    const card = page.locator('[data-testid="agent-card-fake"]');
    await card.getByRole('button', { name: '停用' }).click();
    await page.locator('[data-testid="agent-confirm"]').click();
    await expect(page.locator('[data-testid="agent-status-fake"]')).toHaveText('未启用', {
      timeout: 15_000,
    });
    await closeSettings(page);

    // 发送门禁：草稿保留、出现 Agent 设置卡（原因：未启用）。
    await send(page, '在吗');
    const setup = page.locator('[data-testid="setup-card"]');
    await expect(setup).toBeVisible({ timeout: 30_000 });
    await expect(setup.locator('[data-testid="setup-card-agent-reason"]')).toBeVisible();
    await expect(page.locator('[data-testid="run-failed-banner"]')).toHaveCount(0);

    // 卡片内启用 → 就绪 → 自动续跑（草稿发出、Bot 回复）。
    await setup.locator('[data-testid="agent-enable-fake"]').click();
    await page.locator('[data-testid="agent-install-confirm"]').click();
    await expect(botBubble(page, '设置好了，我来了。')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('[data-testid="setup-card"]')).toHaveCount(0);
  } finally {
    await session.close();
  }
});

test('onboarding subscription branch: enable an agent, the butler runs on it', async () => {
  test.setTimeout(240_000);
  const session = await startSession(
    'kepcup-e2e-agent-onb-',
    { turns: [agentTurn().text('管家在，有什么可以帮你？')] },
    { onboarding: true },
  );
  const { page } = session;
  try {
    await waitReady(page);
    const wizard = page.locator('[data-testid="onboarding"]');
    await expect(wizard).toBeVisible({ timeout: 30_000 });
    await page.locator('[data-testid="onboarding-start"]').click();
    await expect(wizard).toHaveAttribute('data-step', 'model');

    // 「我有订阅」：先说明（实验功能）→ 开启 → 目录里只列订阅登录的 Agent。
    await page.locator('[data-testid="onboarding-subscription-open"]').click();
    await expect(page.locator('[data-testid="onboarding-subscription"]')).toBeVisible();
    await page.locator('[data-testid="onboarding-subscription-enable"]').click();
    const subCard = page.locator('[data-testid="agent-card-fake-sub"]');
    await expect(subCard).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid="agent-card-fake"]')).toHaveCount(0);
    await subCard.locator('[data-testid="agent-enable-fake-sub"]').click();
    await page.locator('[data-testid="agent-install-confirm"]').click();
    await page.locator('[data-testid="onboarding-agent-choose-fake-sub"]').check();
    const save = page.locator('[data-testid="onboarding-subscription-save"]');
    await expect(save).toBeEnabled({ timeout: 15_000 });
    await save.click();

    await expect(wizard).toHaveAttribute('data-step', 'permissions');
    await page.locator('[data-testid="onboarding-next"]').click();
    await expect(wizard).toHaveAttribute('data-step', 'sandbox');
    await page.locator('[data-testid="onboarding-next"]').click();
    await expect(wizard).toHaveAttribute('data-step', 'bot');
    await expect(page.locator('[data-testid="onboarding-butler-agent-note"]')).toContainText(
      'Fake Subscription',
    );
    await page.locator('[data-testid="onboarding-butler-start"]').click();
    await expect(wizard).toBeHidden({ timeout: 15_000 });
    await expect(page.locator('[data-testid="chat-view"]')).toBeVisible({ timeout: 15_000 });

    // 管家由智能体驱动（未进入内置引擎的组队访谈）：对话得到假 Agent 的回复。
    await send(page, '你好');
    await expect(botBubble(page, '管家在，有什么可以帮你？')).toBeVisible({ timeout: 60_000 });
    expect(session.record().prompts.some((prompt) => prompt.text.includes('你好'))).toBe(true);
  } finally {
    await session.close();
  }
});
