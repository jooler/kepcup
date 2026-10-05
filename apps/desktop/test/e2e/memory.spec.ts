import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page, _electron } from '@playwright/test';
import { startMockLlm, step, type MockLlmServer } from '@kepcup/testkit';

/**
 * P07 e2e (docs/dev/phases/P07-memory.md 测试要求「端到端」): the right-panel
 * memory tab (view / search / edit / private toggle / evidence jump / delete),
 * the "deleted source conversation" evidence state, the settings profile page
 * (curation-produced entry, card preview, edit, delete) and the usage & budget
 * page (per bot/loop/day tokens, budget edit, exceeded hint).
 * Mock data flows through the REAL core stack: the scripted model calls the
 * remember tool; the profile entry comes from the real curation loop
 * (KEPCUP_PROFILE_CURATION_DELAY_MS collapses its merge delay).
 */

function emptyReflection() {
  return {
    runSummary: '无新记忆',
    memories: [],
    profileProposals: [],
    wikiSuggestions: [],
    skillSuggestion: null,
  };
}

interface LaunchedApp {
  app: ElectronApplication;
  page: Page;
  home: string;
}

async function launchApp(options: {
  home: string;
  llmUrl: string;
  curationDelayMs?: string;
}): Promise<LaunchedApp> {
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
      ...(options.curationDelayMs !== undefined
        ? { KEPCUP_PROFILE_CURATION_DELAY_MS: options.curationDelayMs }
        : {}),
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

async function startSession(prefix: string, curationDelayMs?: string): Promise<Session> {
  const llm = await startMockLlm();
  const home = await mkdtemp(path.join(tmpdir(), prefix));
  const launched = await launchApp({ home, llmUrl: llm.url, curationDelayMs });
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

async function openSettings(page: Page): Promise<void> {
  // 空态启动时「+」面板可能自动展开：先收起再走菜单。
  try {
    await page.locator('[data-testid="start-chat-backdrop"]').click({ timeout: 1_500 });
  } catch {
    // 面板没有展开。
  }
  await page.locator('[data-testid="user-menu-trigger"]').click();
  await page.locator('[data-testid="menu-settings"]').click();
  await expect(page.locator('[data-testid="settings-page-content"]')).toBeVisible();
}

async function openMemoryTab(page: Page): Promise<void> {
  // 右栏默认收起：需要时经顶部药丸展开（toggle 语义，不能盲点）。
  if (!(await page.locator('[data-testid="right-panel-tabs"]').isVisible())) {
    await page.locator('[data-testid="right-panel-toggle"]').click();
  }
  await page.locator('[data-testid="right-panel-tabs"]').locator('text=记忆').click();
  await expect(page.locator('[data-testid="memory-tab"]')).toBeVisible();
}

/** Registers one empty-reflection step per completed response run. */
function scriptReflection(llm: MockLlmServer, count = 1): void {
  llm.script(
    'mock-light',
    Array.from({ length: count }, () => step().replyJson(emptyReflection())),
  );
}

test('memory tab: view, search, edit, private toggle, evidence jump, delete', async () => {
  test.setTimeout(240_000);
  // 60s curation delay: the remember's profile proposal never fires a model
  // call inside this test (nothing consumes mock-main behind our back).
  const session = await startSession('kepcup-e2e-memory-', '60000');
  const { page, llm } = session;
  try {
    await waitReady(page);
    await createBotAndOpenChat(page, '阿忆');

    llm.script('mock-main', [
      step()
        .expect((req) => req.lastUserText().includes('记住'))
        .replyToolCall('remember', {
          content: '用户下周三要交周报',
          kind: 'commitment',
          due_at: '2026-10-07T18:00:00Z',
        }),
      step()
        .expect((req) => req.lastUserText().includes('记住'))
        .replyText('记住了，到时候我会提醒你'),
    ]);
    scriptReflection(llm);

    const composer = page.locator('[data-testid="composer-input"]');
    await composer.fill('记住我下周三要交周报');
    await composer.press('ControlOrMeta+Enter');
    await expect(page.locator('[data-testid="bot-bubble"]').first()).toContainText('记住了', {
      timeout: 30_000,
    });

    // --- view: grouped under 承诺 with the evidence link ---------------------
    await openMemoryTab(page);
    const tab = page.locator('[data-testid="memory-tab"]');
    // The li carries data-memory-kind; its children (memory-item-content etc.)
    // share the testid prefix, so anchor item locators on the attribute.
    const item = tab.locator('[data-testid^="memory-item-"][data-memory-kind]').first();
    await expect(item).toBeVisible({ timeout: 15_000 });
    await expect(item).toHaveAttribute('data-memory-kind', 'commitment');
    await expect(item.locator('[data-testid="memory-item-content"]')).toContainText(
      '下周三要交周报',
    );
    await expect(tab.getByRole('heading')).toContainText('承诺');

    // --- search filter --------------------------------------------------------
    await page.locator('[data-testid="memory-search"]').fill('完全不匹配的词');
    await expect(tab.locator('[data-testid="memory-search-empty"]')).toBeVisible();
    await page.locator('[data-testid="memory-search"]').fill('周报');
    await expect(tab.locator('[data-testid^="memory-item-"][data-memory-kind]')).toHaveCount(1);
    await page.locator('[data-testid="memory-search"]').fill('');

    // --- evidence jump: highlights the message in the conversation ------------
    const evidence = item.locator('[data-testid^="memory-evidence-"]');
    await expect(evidence).toBeVisible();
    const messageId = await evidence.getAttribute('data-message-id');
    expect(messageId).toBeTruthy();
    await evidence.click();
    await expect(page.locator(`[data-testid="message-${messageId}"]`)).toHaveAttribute(
      'data-highlighted',
      'true',
      { timeout: 15_000 },
    );

    // --- private_to_bot toggle (bits-ui checkbox = button[role=checkbox]) -----
    await expect(
      page.locator('[role="checkbox"][data-testid^="memory-private-"]').first(),
    ).toBeVisible();
    await page.locator('[role="checkbox"][data-testid^="memory-private-"]').first().click();
    await expect(page.locator('[data-testid="memory-item-private"]')).toBeVisible({
      timeout: 15_000,
    });

    // --- edit content -----------------------------------------------------------
    await page.locator('[data-testid^="memory-edit-"]').first().click();
    const editInput = page.locator('[data-testid="memory-edit-input"]');
    await expect(editInput).toBeVisible();
    await editInput.fill('用户下周三（10 月 7 日）要交周报');
    await page.locator('[data-testid="memory-edit-save"]').click();
    await expect(page.locator('[data-testid="memory-item-content"]')).toContainText('10 月 7 日', {
      timeout: 15_000,
    });

    // --- delete: two-step confirm, item turns retracted ------------------------
    await page.locator('[data-testid^="memory-delete-"]').first().click();
    await expect(page.locator('[data-testid="memory-delete-dialog"]')).toBeVisible();
    await page.locator('[data-testid="memory-delete-confirm"]').click();
    const row = page.locator('[data-testid^="memory-item-"][data-memory-kind]').first();
    await expect(row).toHaveAttribute('data-memory-status', 'retracted', { timeout: 15_000 });
    await expect(row.locator('[data-testid="memory-item-status"]')).toContainText('已撤回');
    await expect(page.locator('[data-testid^="memory-delete-"]')).toHaveCount(0);
  } finally {
    await closeSession(session);
  }
});

test('evidence of a deleted conversation shows 来源对话已删除', async () => {
  test.setTimeout(240_000);
  const session = await startSession('kepcup-e2e-memory-deleted-', '60000');
  const { page, llm } = session;
  try {
    await waitReady(page);
    await createBotAndOpenChat(page, '阿乙');
    // A second bot so the group can be created (needs >= 2 members).
    await page.locator('[data-testid="new-chat-button"]').click();
    await page.locator('[data-testid="bot-create-form"]').click();
    await page
      .locator('[data-testid="bot-create-dialog"] [data-testid="bot-name-input"]')
      .fill('阿丙');
    await page.locator('[data-testid="bot-create-save"]').click();
    await expect(page.locator('[data-testid="chat-view"]')).toBeVisible({ timeout: 15_000 });

    await page.locator('[data-testid="new-chat-button"]').click();
    await page.locator('[data-testid="start-chat-create-group"]').click();
    // 对话内创建（19/D60）：名称 → 主要事务 → 成员 → 目录（跳过）。
    const card = (step: string) =>
      page.locator(`[data-testid="group-setup-card"][data-step="${step}"]`);
    await expect(card('title')).toBeVisible({ timeout: 15_000 });
    await card('title').locator('[data-testid="group-setup-input"]').fill('产品组');
    await card('title').locator('[data-testid="group-setup-submit"]').click();
    await expect(card('purpose')).toBeVisible({ timeout: 15_000 });
    await card('purpose').locator('[data-testid="group-setup-input"]').fill('协作处理产品事务');
    await card('purpose').locator('[data-testid="group-setup-submit"]').click();
    await expect(card('members')).toBeVisible({ timeout: 15_000 });
    for (const name of ['阿乙', '阿丙']) {
      await card('members')
        .locator('label', { hasText: name })
        .locator('button[role="checkbox"]')
        .click();
    }
    await card('members').locator('[data-testid="group-setup-submit"]').click();
    await expect(card('project')).toBeVisible({ timeout: 15_000 });
    await card('project').locator('[data-testid="group-setup-skip"]').click();
    await expect(
      page.locator('[data-testid="conversation-name"]', { hasText: '产品组' }),
    ).toBeVisible({ timeout: 15_000 });

    // 阿乙 remembers something in the group (evidence lives in the group).
    llm.script('mock-main', [
      step()
        .expect((req) => req.lastUserText().includes('记住'))
        .replyToolCall('remember', { content: '团队每周五发布新版本', kind: 'fact' }),
      step()
        .expect((req) => req.lastUserText().includes('记住'))
        .replyText('好的，我记下了'),
    ]);
    scriptReflection(llm);
    const composer = page.locator('[data-testid="composer-input"]');
    await composer.click();
    await composer.pressSequentially('@阿乙');
    await page
      .locator('[data-testid="mention-popup"] button')
      .filter({ hasText: '阿乙' })
      .first()
      .click();
    await composer.pressSequentially(' 记住我们团队每周五发布新版本');
    await composer.press('ControlOrMeta+Enter');
    await expect(page.locator('[data-testid="bot-bubble"]').first()).toContainText('记下了', {
      timeout: 30_000,
    });

    // Delete the group conversation (group settings via the context menu).
    await page
      .locator('li', { hasText: '产品组' })
      .locator('[data-testid^="conversation-row-"]')
      .click({ button: 'right' });
    await page.locator('[data-testid="context-group-settings"]').click();
    await expect(page.locator('[data-testid="group-settings-dialog"]')).toBeVisible();
    await page.locator('[data-testid="group-delete-begin"]').click();
    await page.locator('[data-testid="group-delete-confirm"]').click();
    await expect(page.locator('[data-testid="chat-empty"]')).toBeVisible({ timeout: 15_000 });

    // Open 阿乙's direct chat; the memory survives with its group evidence.
    await page.locator('[data-testid^="conversation-item-"]', { hasText: '阿乙' }).first().click();
    await expect(page.locator('[data-testid="chat-view"]')).toBeVisible({ timeout: 15_000 });
    await openMemoryTab(page);
    const tab = page.locator('[data-testid="memory-tab"]');
    const item = tab.locator('[data-testid^="memory-item-"][data-memory-kind]').first();
    await expect(item).toBeVisible({ timeout: 15_000 });
    await item.locator('[data-testid^="memory-evidence-"]').click();
    await expect(tab.locator('[data-testid="memory-evidence-deleted"]')).toContainText(
      '来源对话已删除',
      { timeout: 15_000 },
    );
  } finally {
    await closeSession(session);
  }
});

test('profile page: curation entry with contributor, card preview, edit, delete', async () => {
  test.setTimeout(300_000);
  // 300ms: the curation job fires right after each remember tool call.
  const session = await startSession('kepcup-e2e-profile-', '300');
  const { page, llm } = session;
  try {
    await waitReady(page);
    await createBotAndOpenChat(page, '小明');

    // Round 1: the remember creates the proposal; the curation request that
    // follows it reveals the real proposal id (we let that first curation
    // request fail — background jobs record the failure and move on).
    llm.script('mock-main', [
      step()
        .expect((req) => req.lastUserText().includes('我叫王小明'))
        .replyToolCall('remember', { content: '用户叫王小明，是一名前端工程师', kind: 'fact' }),
      step()
        .expect((req) => req.lastUserText().includes('我叫王小明'))
        .replyText('王小明你好，我记下了'),
    ]);
    scriptReflection(llm, 4);

    const composer = page.locator('[data-testid="composer-input"]');
    await composer.fill('我叫王小明，是一名前端工程师');
    await composer.press('ControlOrMeta+Enter');
    await expect(page.locator('[data-testid="bot-bubble"]').first()).toContainText('记下了', {
      timeout: 30_000,
    });

    // The curation request body renders the pending proposal with its id.
    let proposalId = '';
    await expect
      .poll(
        () => {
          const curation = llm
            .requestsFor('mock-main')
            .find((req) => req.lastUserText().includes('<pending_proposals>'));
          proposalId = curation?.lastUserText().match(/id=([A-Za-z0-9_]+) op=add/)?.[1] ?? '';
          return proposalId;
        },
        { timeout: 30_000, intervals: [500] },
      )
      .toBeTruthy();

    // Round 2: another remember re-triggers the curation loop; this time the
    // scripted output applies the known proposal and recompiles the card.
    llm.script('mock-main', [
      step()
        .expect((req) => req.lastUserText().includes('简洁'))
        .replyToolCall('remember', { content: '用户喜欢简洁的回复', kind: 'preference' }),
      step()
        .expect((req) => req.lastUserText().includes('简洁'))
        .replyText('好的，以后我会注意简洁'),
      step()
        .expect((req) => req.lastUserText().includes('<pending_proposals>'))
        .replyJson({
          operations: [
            {
              op: 'add',
              proposalId,
              category: 'basic',
              content: '用户叫王小明，是一名前端工程师',
            },
          ],
          card: '用户叫王小明，是一名前端工程师。',
        }),
    ]);
    scriptReflection(llm, 4);
    await composer.fill('请以后回复得简洁一些');
    await composer.press('ControlOrMeta+Enter');
    await expect(page.locator('[data-testid="bot-bubble"]').nth(1)).toContainText('简洁', {
      timeout: 30_000,
    });

    await openSettings(page);
    await page.locator('[data-testid="settings-nav-profile"]').click();
    const section = page.locator('[data-testid="settings-profile"]');
    await expect(section).toBeVisible();

    // The curation-produced entry appears under 基本信息 with its contributor.
    const entry = section.locator('[data-testid^="profile-item-"]').first();
    await expect(async () => {
      await section.locator('[data-testid="profile-refresh"]').click();
      await expect(entry).toBeVisible({ timeout: 3000 });
    }).toPass({ timeout: 60_000, intervals: [500, 1000] });
    await expect(entry.locator('[data-testid="profile-item-content"]')).toContainText('王小明');
    await expect(entry.locator('[data-testid="profile-item-contributed"]')).toContainText('小明');
    await expect(section.getByRole('heading').filter({ hasText: '基本信息' })).toBeVisible();

    // Card preview compiled by the curation loop.
    await expect(section.locator('[data-testid="profile-card-content"]')).toContainText('王小明');

    // Edit: direct write, no proposal involved.
    await entry.locator('[data-testid^="profile-edit-"]').click();
    await page.locator('[data-testid="profile-edit-input"]').fill('用户叫王小明，是资深前端工程师');
    await page.locator('[data-testid="profile-edit-save"]').click();
    await expect(section.locator('[data-testid="profile-item-content"]')).toContainText(
      '资深前端工程师',
      { timeout: 15_000 },
    );

    // Delete: direct retract, the entry leaves the list.
    await section.locator('[data-testid^="profile-delete-"]').first().click();
    await expect(page.locator('[data-testid="profile-delete-dialog"]')).toBeVisible();
    await page.locator('[data-testid="profile-delete-confirm"]').click();
    await expect(section.locator('[data-testid="profile-empty"]')).toBeVisible({ timeout: 15_000 });
  } finally {
    await closeSession(session);
  }
});

test('usage page: per bot/loop/day tokens, budget edit, exceeded hint', async () => {
  test.setTimeout(240_000);
  const session = await startSession('kepcup-e2e-usage-', '60000');
  const { page, llm } = session;
  try {
    await waitReady(page);
    await createBotAndOpenChat(page, '阿量');

    llm.script('mock-main', [
      step().replyText('回复完成', { prompt_tokens: 400, completion_tokens: 100 }),
    ]);
    // The reflection right after the run burns 5500 background tokens.
    llm.script('mock-light', [
      step().replyJson(emptyReflection(), { prompt_tokens: 5000, completion_tokens: 500 }),
    ]);

    const composer = page.locator('[data-testid="composer-input"]');
    await composer.fill('做一件小事');
    await composer.press('ControlOrMeta+Enter');
    await expect(page.locator('[data-testid="bot-bubble"]').first()).toContainText('回复完成', {
      timeout: 30_000,
    });

    await openSettings(page);
    await page.locator('[data-testid="settings-nav-usage"]').click();
    const section = page.locator('[data-testid="settings-usage"]');
    await expect(section).toBeVisible();
    const botRow = section.locator('[data-testid^="usage-bot-"]').first();

    // Usage grouped per bot / loop type / day (reflection finishes right after
    // the run — poll through the refresh button; the reflection row lands a
    // beat after the response row, so the poll must cover it too, otherwise a
    // slow background job leaves the section on stale data).
    await expect(async () => {
      await section.locator('[data-testid="usage-refresh"]').click();
      await expect(botRow).toBeVisible({ timeout: 3000 });
      const pollRows = botRow.locator('[data-testid="usage-entry-row"]');
      await expect(pollRows.filter({ hasText: '对话响应' })).toHaveCount(1);
      await expect(pollRows.filter({ hasText: '反思' })).toHaveCount(1);
    }).toPass({ timeout: 60_000, intervals: [500, 1000] });
    await expect(botRow.locator('[data-testid="usage-bot-name"]')).toContainText('阿量');
    const rows = botRow.locator('[data-testid="usage-entry-row"]');
    await expect(rows.first()).toHaveAttribute('data-date', /\d{4}-\d{2}-\d{2}/);
    await expect(
      rows.filter({ hasText: '对话响应' }).locator('[data-testid="usage-entry-tokens"]'),
    ).toHaveText('400 / 100');

    // Budget: the default 200000 is shown; saving a new limit persists.
    const budgetInput = page.locator('[data-testid="budget-input"]');
    await expect(budgetInput).toHaveValue('200000');
    await budgetInput.fill('1');
    await page.locator('[data-testid="budget-save"]').click();
    await expect(budgetInput).toHaveValue('1', { timeout: 15_000 });

    // 今日后台用量（5500）>= 1 → the per-bot exceeded hint appears (任务 12).
    await section.locator('[data-testid="usage-refresh"]').click();
    await expect(section.locator('[data-testid="usage-exceeded"]')).toBeVisible({
      timeout: 15_000,
    });
  } finally {
    await closeSession(session);
  }
});
