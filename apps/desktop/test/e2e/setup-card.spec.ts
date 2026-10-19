import { mkdtemp } from 'node:fs/promises';
import { rmHomeTolerant } from './helpers/home-cleanup';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { startMockLlm, step, type MockLlmServer } from '@kepcup/testkit';
import { createBotAndOpenChat } from './helpers/create-bot';

/**
 * 对话内设置引导（docs/design/18-inline-setup.md）：不设 KEPCUP_MOCK_LLM_URL
 * （seedMockLlm 不注册供应商、不设默认模型）模拟全新环境。两条路径：
 * ① 访谈回答触发响应 run → core 结构化失败（run.setup = main-model）→ 消息
 *    列表出现设置卡片（无失败横幅）；卡片内添加指向 mock LLM 的自定义厂商
 *    → 选默认模型确认 → 原 run 自动重试、访谈继续。
 * ② 发送门禁：正常 Bot 的消息发送被拦截（草稿保留、无失败 run）→ 卡片出现
 *    → 完成设置确认后草稿自动发出、Bot 回复。
 *    非访谈 Bot 经测试缝 `__kepcupRpc`（`createBotAndOpenChat`）创建，等价原「高级新建」。
 * ③ 测试连接闸门：卡片内「测试连接」失败 → 卡片停在第一段、保存禁用；
 *    重测通过 → 保存解锁但仍不自动跳段——切段只由「保存」进入。
 */

async function startSession(prefix: string): Promise<{
  page: Page;
  llm: MockLlmServer;
  home: string;
  close: () => Promise<void>;
}> {
  const llm = await startMockLlm();
  const home = await mkdtemp(path.join(tmpdir(), prefix));
  const { _electron } = await import('@playwright/test');
  const app = await _electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      KEPCUP_HOME: home,
      NODE_ENV: 'test',
      KEPCUP_KEYSTORE: 'file',
      KEPCUP_ONBOARDING: 'off',
      KEPCUP_FILE_KEYSTORE_PATH: path.join(home, '.test-master-key'),
      // 置空：seedMockLlm 跳过——全新环境（无供应商、无默认模型）。
      KEPCUP_MOCK_LLM_URL: '',
    },
  });
  const page = await app.firstWindow();
  await expect(page.locator('[data-testid="app-shell"]')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('[data-testid="ping-result"]')).toContainText('ping ✓', {
    timeout: 60_000,
  });
  await expect(page.locator('[data-testid="start-chat-panel"]')).toBeVisible({ timeout: 60_000 });
  const startBackdrop = page.locator('[data-testid="start-chat-backdrop"]');
  if (await startBackdrop.isVisible()) {
    await startBackdrop.click({ timeout: 2_000 }).catch(() => {});
  }
  return {
    page,
    llm,
    home,
    close: async () => {
      await app.close();
      await llm.stop();
      await rmHomeTolerant(home);
    },
  };
}

/** 在设置卡片内添加指向 mock LLM 的自定义厂商并保存（第一段 → 第二段）。 */
async function addMockProviderViaCard(page: Page, llm: MockLlmServer): Promise<void> {
  const card = page.locator('[data-testid="setup-card"]');
  await card.locator('[data-testid="setup-card-target"]').selectOption('custom');
  await card.locator('[data-testid="setup-card-custom-id"]').fill('mock');
  await card.locator('[data-testid="setup-card-custom-name"]').fill('Mock LLM');
  await card.locator('[data-testid="setup-card-custom-base-url"]').fill(llm.url);
  await card.locator('[data-testid="custom-key-input"]').fill('sk-setup-card-e2e');
  await card.locator('[data-testid="setup-card-custom-models"]').fill('mock-main');
  await card.locator('[data-testid="setup-card-save"]').click();
}

test('setup card on interview answer: structured failure, provider form in the card, auto retry continues the interview', async () => {
  test.setTimeout(240_000);
  const session = await startSession('kepcup-e2e-setup-card-');
  const { page, llm } = session;
  try {
    // 对话式新建：问候 + 固定首问（确定性下发，无需模型）。
    await page.locator('[data-testid="new-chat-button"]').click();
    await page.locator('[data-testid="start-chat-create-bot"]').click();
    const firstCard = page.locator('[data-testid="setup-question-card"]').first();
    await expect(firstCard).toBeVisible({ timeout: 30_000 });

    // 回答首问 → 先被目录闸门扣下（19/D59，无 run）→ 跳过目录后响应 run
    // 无模型可用 → 结构化失败 + 设置卡片（无失败横幅）。
    llm.script('mock-main', [step().replyText('模型已配置，我们继续。')]);
    // 首问是多选卡：勾一项再提交。
    await firstCard.locator('[data-testid="setup-question-check-0"]').click();
    await firstCard.locator('[data-testid="setup-question-submit"]').click();
    const pathCard = page.locator('[data-testid="setup-path-card"]');
    await expect(pathCard).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid="composer-readonly"]')).toBeVisible();
    await pathCard.locator('[data-testid="setup-path-skip"]').click();
    await expect(pathCard).toHaveAttribute('data-answered', 'true');
    const setupCard = page.locator('[data-testid="setup-card"]');
    await expect(setupCard).toBeVisible({ timeout: 30_000 });
    await expect(setupCard.locator('[data-testid="setup-card-title"]')).toContainText('模型');
    await expect(page.locator('[data-testid="run-failed-banner"]')).toHaveCount(0);
    // 第一段：卡片内就是供应商表单（无已配置厂商）。
    await expect(setupCard.locator('[data-testid="setup-card-target"]')).toBeVisible();

    // 卡片内添加厂商（指向 mock LLM）→ 第二段选默认模型。
    await addMockProviderViaCard(page, llm);
    await expect(page.locator('[data-testid="setup-card-default-model"]')).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator('[data-testid="setup-card-default-model"]')).toHaveValue(
      'custom:mock/mock-main',
    );
    await page.locator('[data-testid="setup-card-confirm"]').click();

    // 原 run 自动重试：访谈继续，Bot 回复；卡片消失。
    await expect(
      page.locator('[data-testid="bot-bubble"]').filter({ hasText: '模型已配置' }).first(),
    ).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('[data-testid="setup-card"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="run-failed-banner"]')).toHaveCount(0);
  } finally {
    await session.close();
  }
});

test('setup card: failed test connection neither advances the card nor lets save through; save is the only way forward', async () => {
  test.setTimeout(240_000);
  const session = await startSession('kepcup-e2e-setup-test-fail-');
  const { page, llm } = session;
  try {
    // 与上一条同路：访谈首问 → 跳过目录 → main-model 设置卡片第一段。
    await page.locator('[data-testid="new-chat-button"]').click();
    await page.locator('[data-testid="start-chat-create-bot"]').click();
    const firstCard = page.locator('[data-testid="setup-question-card"]').first();
    await expect(firstCard).toBeVisible({ timeout: 30_000 });
    // 首问是多选卡：勾一项再提交。
    await firstCard.locator('[data-testid="setup-question-check-0"]').click();
    await firstCard.locator('[data-testid="setup-question-submit"]').click();
    const pathCard = page.locator('[data-testid="setup-path-card"]');
    await expect(pathCard).toBeVisible({ timeout: 15_000 });
    await pathCard.locator('[data-testid="setup-path-skip"]').click();
    const setupCard = page.locator('[data-testid="setup-card"]');
    await expect(setupCard).toBeVisible({ timeout: 30_000 });
    await expect(setupCard.locator('[data-testid="setup-card-target"]')).toBeVisible();

    // 填一个指向死端口的自定义接口（连接拒绝）→ 点「测试连接」。
    const card = page.locator('[data-testid="setup-card"]');
    await card.locator('[data-testid="setup-card-target"]').selectOption('custom');
    await card.locator('[data-testid="setup-card-custom-id"]').fill('mock');
    await card.locator('[data-testid="setup-card-custom-name"]').fill('Mock LLM');
    await card.locator('[data-testid="setup-card-custom-base-url"]').fill('http://127.0.0.1:9');
    await card.locator('[data-testid="custom-key-input"]').fill('sk-setup-card-e2e');
    await card.locator('[data-testid="setup-card-custom-models"]').fill('mock-main');
    await card.locator('[data-testid="setup-card-test"]').click();
    // 失败：卡片停在第一段（不自动跳段），保存被禁用并给出提示。
    await expect(page.locator('[data-testid="setup-card-default-model"]')).toHaveCount(0);
    await expect(card.locator('[data-testid="setup-card-save-blocked"]')).toBeVisible();
    await expect(card.locator('[data-testid="setup-card-save"]')).toBeDisabled();

    // 修正地址后重测通过：保存解除禁用；成功同样不自动跳段，仍停在第一段。
    // 两步脚本：第一步给「测试连接」的最小对话探测消费，第二步留给确认后
    // 的原 run 重试（script() 是整体替换队列）。
    await card.locator('[data-testid="setup-card-custom-base-url"]').fill(llm.url);
    llm.script('mock-main', [step().replyText('ok'), step().replyText('模型已配置，我们继续。')]);
    await card.locator('[data-testid="setup-card-test"]').click();
    await expect(card.locator('[data-testid="setup-card-save-blocked"]')).toHaveCount(0);
    await expect(card.locator('[data-testid="setup-card-save"]')).toBeEnabled();
    await expect(page.locator('[data-testid="setup-card-default-model"]')).toHaveCount(0);

    // 用户自己点「保存」→ 第二段选默认模型 → 确认 → 原 run 自动重试。
    await card.locator('[data-testid="setup-card-save"]').click();
    await expect(page.locator('[data-testid="setup-card-default-model"]')).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator('[data-testid="setup-card-default-model"]')).toHaveValue(
      'custom:mock/mock-main',
    );
    await page.locator('[data-testid="setup-card-confirm"]').click();
    await expect(
      page.locator('[data-testid="bot-bubble"]').filter({ hasText: '模型已配置' }).first(),
    ).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('[data-testid="setup-card"]')).toHaveCount(0);
  } finally {
    await session.close();
  }
});

test('send gate holds the message: no failed run, card completes setup, resend sends it', async () => {
  test.setTimeout(240_000);
  const session = await startSession('kepcup-e2e-setup-gate-');
  const { page, llm } = session;
  try {
    // 非访谈直聊（测试缝，等价原「高级新建」）：无模型时发送应被门禁拦住。
    await createBotAndOpenChat(page, '小门');

    // 发送被门禁拦截：内容留在输入框、无用户气泡、无失败 run、卡片出现。
    llm.script('mock-main', [step().replyText('模型已配置，我们继续。')]);
    const composer = page.locator('[data-testid="composer-input"]');
    await composer.fill('帮我看看今天的安排');
    await composer.press('Enter');
    const setupCard = page.locator('[data-testid="setup-card"]');
    await expect(setupCard).toBeVisible({ timeout: 15_000 });
    await expect(composer).toHaveText('帮我看看今天的安排');
    await expect(page.locator('[data-testid="user-bubble"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="run-failed-banner"]')).toHaveCount(0);

    // 卡片内完成设置 → 再按一次发送 → Bot 回复 → 卡片消失。
    await addMockProviderViaCard(page, llm);
    await expect(page.locator('[data-testid="setup-card-default-model"]')).toBeVisible({
      timeout: 15_000,
    });
    await page.locator('[data-testid="setup-card-confirm"]').click();
    // 等卡片收起（设置写入 + 门禁撤销完成后）再手动重发。
    await expect(page.locator('[data-testid="setup-card"]')).toHaveCount(0, { timeout: 15_000 });
    await composer.press('Enter');
    await expect(page.locator('[data-testid="user-bubble"]')).toHaveCount(1, { timeout: 30_000 });
    await expect(
      page.locator('[data-testid="bot-bubble"]').filter({ hasText: '模型已配置' }).first(),
    ).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('[data-testid="setup-card"]')).toHaveCount(0);
  } finally {
    await session.close();
  }
});
