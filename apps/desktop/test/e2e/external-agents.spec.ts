import { mkdtemp, rm } from 'node:fs/promises';
import { rmHomeTolerant } from './helpers/home-cleanup';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page, _electron } from '@playwright/test';
import {
  agentTurn,
  FAKE_ACP_AGENT_BIN,
  readFakeAgentRecord,
  startMockLlm,
  step,
  writeFakeAgentScript,
  type FakeAgentObservation,
  type FakeAgentScript,
  type MockLlmServer,
  type MockLlmStep,
} from '@kepcup/testkit';
import { createBotAndOpenChat } from './helpers/create-bot';

/**
 * 外部智能体（D72，todo/acp-external-agents.md §9.1 e2e）：testkit 的剧本化假
 * ACP 智能体经 core 的 e2e seam（KEPCUP_FAKE_ACP_AGENT_*，仅测试构建）挂在目录
 * 的 `fake` 条目上，子进程以 Electron 的 Node 运行。覆盖：设置页目录启用、Bot
 * 切换到智能体（任务执行引擎）与能力包、`agent_tool` 审批卡、对话内 Agent
 * 设置卡、onboarding 无外部智能体路径且管家访谈在内置引擎上跑。
 *
 * 任务由内置对话轮经 `start_task` 派出（2026-11 修订：对话与后台恒内置，没有
 * 无模型降级路径），任务报告不再原文进对话——由唤醒的对话轮转述。
 */

interface Session {
  app: ElectronApplication;
  page: Page;
  home: string;
  outside: string;
  llm: MockLlmServer;
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
  const llm = await startMockLlm();
  const app = await _electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      TZ: 'Asia/Shanghai',
      KEPCUP_HOME: home,
      NODE_ENV: 'test',
      KEPCUP_KEYSTORE: 'file',
      KEPCUP_FILE_KEYSTORE_PATH: path.join(home, '.test-master-key'),
      ...(options.onboarding === true ? {} : { KEPCUP_ONBOARDING: 'off' }),
      KEPCUP_MOCK_LLM_URL: llm.url,
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
    llm,
    record: () => readFakeAgentRecord(recordFile),
    close: async () => {
      await app.close();
      await llm.stop();
      await rmHomeTolerant(home);
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
  // 「模型」「智能体」合并为「模型与智能体」一个左栏条目，内部分页切换。
  if (section === 'models' || section === 'agents') {
    await page.locator('[data-testid="settings-nav-models"]').click();
    if (section === 'agents') {
      await page.locator('[data-testid="models-agents-tab-agents"]').click();
    }
    return;
  }
  await page.locator(`[data-testid="settings-nav-${section}"]`).click();
}

async function closeSettings(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-testid="settings-page"]')).toHaveCount(0);
}

/**
 * 设置页「智能体」：左栏选中该智能体 → 目录卡片启用（安装确认卡）→ 就绪。
 * 「全局配置」条目已随 2026-11 修订移除（后台整理恒内置，无需在此关闭）。
 */
async function enableFakeAgent(page: Page, agentId = 'fake'): Promise<void> {
  await openSettings(page, 'agents');
  const section = page.locator('[data-testid="agents-section"]');
  await expect(section).toBeVisible();
  await page.locator(`[data-testid="agents-nav-agent-${agentId}"]`).click();
  const card = page.locator(`[data-testid="agent-card-${agentId}"]`);
  await expect(card).toBeVisible({ timeout: 15_000 });
  await page.locator(`[data-testid="agent-enable-${agentId}"]`).click();
  await expect(page.locator('[data-testid="agent-install-dialog"]')).toBeVisible();
  await page.locator('[data-testid="agent-install-confirm"]').click();
  await expect(page.locator(`[data-testid="agent-status-${agentId}"]`)).toHaveText('就绪', {
    timeout: 30_000,
  });
  // 左栏「可用」绿点。
  await expect(page.locator(`[data-testid="agents-nav-available-${agentId}"]`)).toBeVisible();
  await closeSettings(page);
}

async function openProfileTab(page: Page): Promise<void> {
  if (!(await page.locator('[data-testid="right-panel"]').isVisible())) {
    await page.locator('[data-testid="right-panel-toggle"]').click();
  }
  // 统一二级菜单：已在某个详情里先点返回回菜单。
  const back = page.locator('[data-testid="bot-detail-back"]');
  if (await back.isVisible()) await back.click();
  // 任务执行引擎下拉在菜单的「模型与智能体」行里：点行下钻。
  await page.locator('[data-testid="bot-config-row-model"]').click();
  await expect(
    page.locator('[data-testid="bot-detail-model"] [data-testid="bot-task-engine-select"]'),
  ).toBeVisible();
}

/** Bot 运行配置：任务执行引擎下拉改选智能体（首次切换弹让渡说明；`apps` 包
 * 勾选时还有一张一次性 ACP 说明卡，遮罩会挡住后续一切点击——都要关掉）。 */
async function switchBotToAgent(page: Page, agentId = 'fake'): Promise<void> {
  await openProfileTab(page);
  const profile = page.locator('[data-testid="bot-detail-model"]');
  await profile.locator('[data-testid="bot-task-engine-select"]').selectOption(`@agent:${agentId}`);
  const dialog = page.locator('[data-testid="bot-agent-switch-dialog"]');
  if (await dialog.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await page.locator('[data-testid="bot-agent-switch-confirm"]').click();
  }
  const notice = page.locator('[data-testid="apps-acp-notice"]');
  if (await notice.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await page.locator('[data-testid="apps-acp-notice-confirm"]').click();
    await expect(page.locator('[data-slot="dialog-overlay"]')).toHaveCount(0);
  }
  await expect(profile.locator('[data-testid="bot-agent-settings"]')).toBeVisible();
  // 右栏表单自动保存（500ms 防抖）：等它落盘再发消息。
  await page.waitForTimeout(1_500);
}

/** 直发（无待发送队列）。先点进编辑器并确认文本已写入，再用快捷键发送，
 * 避免从设置页返回后 Enter 打在空输入上。 */
async function send(page: Page, text: string): Promise<void> {
  const composer = page.locator('[data-testid="composer-input"]');
  await composer.click();
  await composer.fill(text);
  await expect(composer).toContainText(text);
  await composer.press('ControlOrMeta+Enter');
}

const botBubble = (page: Page, text: string) =>
  page.locator('[data-testid="bot-bubble"]').filter({ hasText: text }).first();

/**
 * 任务链路的可见结果：对话气泡是唤醒对话轮的转述（RELAY…），智能体原文在
 * 任务详情的执行报告里（§6.1：报告不原文进对话）。
 */
async function expectAgentReport(page: Page, agentText: string): Promise<void> {
  await expect(botBubble(page, 'RELAY')).toBeVisible({ timeout: 60_000 });
  await page.locator('[data-testid="task-open-run"]').first().click();
  await expect(page.locator('[data-testid="task-run-report"]')).toContainText(agentText, {
    timeout: 15_000,
  });
}

/**
 * mock 主模型的派发剧本：对话轮 start_task 派任务 → 任务把 agentText 写进执行
 * 报告 → 唤醒的对话轮转述（2026-11 修订：不再有无模型降级，任务必须由轮派出）。
 */
function dispatchAndRelay(agentText: string, writes = false): MockLlmStep[] {
  return [
    step()
      .inTurn()
      .replyToolCall('start_task', {
        title: '处理请求',
        instruction: '按用户的消息完成这件事',
        source_message_ids: [],
        writes,
      }),
    step().inTurn().replyText('ACK 我交给外援'),
    step().inTask().replyText(agentText),
    step().inTurn().replyText(`RELAY ${agentText}`),
  ];
}

test('settings catalog: enable the agent, background tasks; bot switches to it with capability packs', async () => {
  test.setTimeout(240_000);
  const session = await startSession('kepcup-e2e-agents-', {
    turns: [agentTurn().mcpList().text('你好，我是外援。')],
  });
  const { page, llm } = session;
  try {
    await waitReady(page);
    await enableFakeAgent(page);
    await createBotAndOpenChat(page, '外援');
    await switchBotToAgent(page);
    llm.script('mock-main', dispatchAndRelay('你好，我是外援。'));

    // 能力包：core 灰显必选；勾掉「图像生成」后工具数随之变化（自动保存）。
    const profile = page.locator('[data-testid="bot-detail-model"]');
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

    // 内置对话轮派出任务，假 Agent 的原文在执行报告里；宿主桥上看不到被取消的包。
    await send(page, '在吗');
    await expectAgentReport(page, '你好，我是外援。');
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
  const { page, llm } = session;
  try {
    await waitReady(page);
    await enableFakeAgent(page);
    await createBotAndOpenChat(page, '外援');
    await switchBotToAgent(page);
    // 越出工作区的写入必须是写任务，否则只读 run 会在权限桥里自动拒绝，不出审批卡。
    llm.script('mock-main', dispatchAndRelay('写好了。', true));

    await send(page, '帮我在外面写个文件');
    const card = page.locator('[data-testid^="approval-card-"]').first();
    await expect(card).toBeVisible({ timeout: 60_000 });
    await expect(card.locator('[data-testid="approval-agent-tool-paths"]')).toContainText(
      'note.txt',
    );
    await card.locator('[data-testid="approval-approve"]').click();
    await expectAgentReport(page, '写好了。');
    await expect.poll(() => JSON.stringify(session.record().permissions)).toContain('allow');
  } finally {
    await session.close();
  }
});

test('in-chat agent setup card: a disabled agent holds the message; enabling in the card lets the resend through', async () => {
  test.setTimeout(240_000);
  const session = await startSession('kepcup-e2e-agent-setup-', {
    turns: [agentTurn().text('设置好了，我来了。')],
  });
  const { page, llm } = session;
  try {
    await waitReady(page);
    await enableFakeAgent(page);
    await createBotAndOpenChat(page, '外援');
    await switchBotToAgent(page);
    llm.script('mock-main', dispatchAndRelay('设置好了，我来了。'));

    // 设置页停用（有 Bot 在用 → 确认框）。
    await openSettings(page, 'agents');
    await page.locator('[data-testid="agents-nav-agent-fake"]').click();
    const card = page.locator('[data-testid="agent-card-fake"]');
    await card.getByRole('button', { name: '停用' }).click();
    await page.locator('[data-testid="agent-confirm"]').click();
    await expect(page.locator('[data-testid="agent-status-fake"]')).toHaveText('未启用', {
      timeout: 15_000,
    });
    await closeSettings(page);
    await expect(page.locator('[data-testid="chat-view"]')).toBeVisible();
    await page.locator('[data-testid="composer-input"]').click();

    // 发送门禁：任务引擎未启用时不发出——草稿留在输入框、无用户气泡、
    // 无失败 run，对话里出现 Agent 设置卡（原因：未启用）。
    await send(page, '在吗');
    const setup = page.locator('[data-testid="setup-card"]');
    await expect(setup).toBeVisible({ timeout: 15_000 });
    await expect(setup.locator('[data-testid="setup-card-agent-reason"]')).toBeVisible();
    await expect(page.locator('[data-testid="composer-input"]')).toContainText('在吗');
    await expect(page.locator('[data-testid="user-bubble"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="run-failed-banner"]')).toHaveCount(0);

    // 卡片内启用 → 就绪后自动收卡；门禁路径不会自动发出草稿，再发一次。
    await setup.locator('[data-testid="agent-enable-fake"]').click();
    await page.locator('[data-testid="agent-install-confirm"]').click();
    await expect(page.locator('[data-testid="setup-card"]')).toHaveCount(0, { timeout: 30_000 });
    await send(page, '在吗');
    await expect(page.locator('[data-testid="user-bubble"]').filter({ hasText: '在吗' })).toBeVisible(
      { timeout: 30_000 },
    );
    await expectAgentReport(page, '设置好了，我来了。');
  } finally {
    await session.close();
  }
});

test('onboarding: no external-agent path; the butler interview runs on the built-in engine', async () => {
  test.setTimeout(240_000);
  const session = await startSession(
    'kepcup-e2e-agent-onb-',
    { turns: [agentTurn().text('这条不该被调用。')] },
    { onboarding: true },
  );
  const { page } = session;
  try {
    await waitReady(page);
    const wizard = page.locator('[data-testid="onboarding"]');
    await expect(wizard).toBeVisible({ timeout: 30_000 });
    await page.locator('[data-testid="onboarding-start"]').click();
    await expect(wizard).toHaveAttribute('data-step', 'model');

    // 2026-11 修订：向导没有「我有订阅」与跳过——模型步必配。mock 厂商只
    // 种子了目录与默认模型，Key 仍要在这一步录入。
    await expect(page.locator('[data-testid="onboarding-subscription-open"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="onboarding-model-skip"]')).toHaveCount(0);
    await page.locator('[data-testid="onboarding-provider-select"]').selectOption('custom:mock');
    await page.locator('[data-testid="onboarding-key-input"]').fill('sk-onboarding-e2e');
    await page.locator('[data-testid="onboarding-model-save"]').click();

    await expect(wizard).toHaveAttribute('data-step', 'permissions');
    await page.locator('[data-testid="onboarding-next"]').click();
    await expect(wizard).toHaveAttribute('data-step', 'sandbox');
    await page.locator('[data-testid="onboarding-next"]').click();
    await expect(wizard).toHaveAttribute('data-step', 'bot');
    await expect(page.locator('[data-testid="onboarding-butler-agent-note"]')).toHaveCount(0);
    await page.locator('[data-testid="onboarding-butler-start"]').click();
    await expect(wizard).toBeHidden({ timeout: 15_000 });
    await expect(page.locator('[data-testid="chat-view"]')).toBeVisible({ timeout: 15_000 });

    // 组队访谈在内置引擎上跑：假智能体进程从未被拉起。
    await page.waitForTimeout(3_000);
    expect(session.record().prompts).toHaveLength(0);
    expect(session.record().sessions).toHaveLength(0);
  } finally {
    await session.close();
  }
});
