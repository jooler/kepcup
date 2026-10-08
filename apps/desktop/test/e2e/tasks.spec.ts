import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page, _electron } from '@playwright/test';
import {
  isTaskRequest,
  startMockLlm,
  step,
  type MockChatRequest,
  type MockLlmServer,
} from '@kepcup/testkit';

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
  return { ...launched, home, llm };
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

/** Forces the native directory picker to return `dir` (no real dialog in e2e). */
async function mockDirectoryPicker(app: ElectronApplication, dir: string): Promise<void> {
  await app.evaluate(({ dialog }, target) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
  }, dir);
}

function makeProjectDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
  writeFileSync(path.join(dir, 'README.md'), '# demo\n');
  return dir;
}

/** 项目选择器已移入右栏「配置」tab：右栏收起时先展开再切 tab，然后打开选择器。 */
async function openProjectSelector(page: Page): Promise<void> {
  if (!(await page.locator('[data-testid="right-panel-tabs"]').isVisible())) {
    await page.locator('[data-testid="right-panel-toggle"]').click();
  }
  await page.locator('[data-testid="right-panel-tabs"]').locator('text=配置').click();
  await page.locator('[data-testid="project-selector-trigger"]').click();
}

// D75 W3（docs/design/30-supervisor-and-tasks.md §4.3 / §6 / §2.4.6）：派任务 →
// 任务卡（状态 / 进度归属 / 追加行）→ 结果经对话轮转述 → 卡片上取消（工作区
// 如实说明不能回退；项目可整次回退）→ 问题卡点选直注任务。

const turnWith = (fragment: string) => (req: MockChatRequest) =>
  !isTaskRequest(req) && req.lastUserText().includes(fragment);
const isWake = (req: MockChatRequest) =>
  !isTaskRequest(req) && req.lastUserText().includes('<trigger reason="task"');

function startTask(title: string, writes: boolean) {
  return step()
    .inTurn()
    .expect(turnWith(title))
    .replyToolCall('start_task', {
      title,
      instruction: `${title}（按用户的消息完成）`,
      source_message_ids: [],
      writes,
    });
}

async function send(page: Page, text: string): Promise<void> {
  const composer = page.locator('[data-testid="composer-input"]');
  await composer.fill(text);
  await composer.press('ControlOrMeta+Enter');
}

function botBubble(page: Page, text: string) {
  return page.locator('[data-testid="bot-bubble"]').filter({ hasText: text });
}

function taskCard(page: Page, title: string) {
  return page.locator('[data-testid^="task-card-"]').filter({ hasText: title });
}

async function taskIdOf(page: Page, title: string): Promise<string> {
  const testId = await taskCard(page, title).getAttribute('data-testid');
  return (testId ?? '').replace('task-card-', '');
}

test('start a task → task card → progress attributed → inject line → result relayed; cancel from the card', async () => {
  test.setTimeout(240_000);
  const session = await startSession('kepcup-e2e-tasks-');
  const { page, llm } = session;
  try {
    await waitReady(page);
    await createBotAndOpenChat(page, '小任');

    // The task parks on a tool call; the inject reaches it with that tool's
    // result, and its final text (the result) comes after.
    const held = step().inTask().hold().replyToolCall('read', { path: 'notes/a.md' });
    const final = step()
      .inTask()
      .expect((req) => JSON.stringify(req.body).includes('顺便加上日期'))
      .replyText('RESULT 笔记整理好了，共一份，含日期');
    llm.script('mock-main', [
      startTask('整理笔记', true),
      step().inTurn().replyText('好的，我去整理笔记'),
      step()
        .inTask()
        .replyTextAndToolCall('先写第一份笔记', 'write', { path: 'notes/a.md', content: 'A' }),
      held,
    ]);
    await send(page, '整理笔记');

    // The card appears with the turn's ack; the task runs.
    const card = taskCard(page, '整理笔记');
    await expect(card).toBeVisible({ timeout: 60_000 });
    await expect(botBubble(page, '好的，我去整理笔记')).toBeVisible({ timeout: 30_000 });
    await expect(card).toHaveAttribute('data-task-state', 'running', { timeout: 30_000 });
    // Its progress reached the conversation, attributed to the task.
    await expect(botBubble(page, '先写第一份笔记')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-testid="task-origin"]').first()).toContainText(
      '任务「整理笔记」的进度',
    );
    await expect.poll(() => held.consumed, { timeout: 30_000 }).toBe(true);
    const taskId = await taskIdOf(page, '整理笔记');
    expect(taskId).toMatch(/^run_/);

    // A new message: the turn forwards it to the task; the card shows the line.
    llm.script('mock-main', [
      step()
        .inTurn()
        .expect(turnWith('顺便加上日期'))
        .replyToolCall('inject_task', { task_id: taskId, text: '顺便加上日期' }),
      step().inTurn().replyText('已把加日期转给整理笔记的任务'),
      final,
      step().inTurn().expect(isWake).replyText('笔记整理好了，加了日期'),
    ]);
    await send(page, '顺便加上日期');
    await expect(card.locator('[data-testid="task-inject"]')).toContainText('顺便加上日期', {
      timeout: 30_000,
    });
    await expect(card.locator('[data-testid="task-inject"]')).toHaveAttribute(
      'data-delivery',
      'delivered',
    );

    // The task finishes: its result is relayed by a turn, the card turns completed.
    held.release();
    await expect(botBubble(page, '笔记整理好了，加了日期')).toBeVisible({ timeout: 60_000 });
    await expect(card).toHaveAttribute('data-task-state', 'completed', { timeout: 30_000 });
    // The task's final text itself never became a visible message.
    await expect(botBubble(page, 'RESULT 笔记整理好了')).toHaveCount(0);

    // A second task, cancelled from its card: no wake, the workspace summary.
    const held2 = step().inTask().hold().replyText('不会走到这里');
    llm.script('mock-main', [
      startTask('长任务', true),
      step().inTurn().replyText('好的，长任务开始'),
      step().inTask().replyToolCall('write', { path: 'notes/b.md', content: 'B' }),
      held2,
    ]);
    await send(page, '来个长任务');
    const card2 = taskCard(page, '长任务');
    await expect(card2).toHaveAttribute('data-task-state', 'running', { timeout: 60_000 });
    await expect.poll(() => held2.consumed, { timeout: 30_000 }).toBe(true);
    // The status line shows the task's activity (no cancel there).
    await expect(page.locator('[data-testid="run-status"]').first()).toContainText('长任务', {
      timeout: 30_000,
    });
    await card2.locator('[data-testid="task-cancel"]').click();
    await expect(card2).toHaveAttribute('data-task-state', 'cancelled', { timeout: 30_000 });
    await expect(card2.locator('[data-testid="task-cancel-reason"]')).toContainText('用户取消');
    const changes = card2.locator('[data-testid="task-changes"]');
    await expect(changes).toContainText('无法整次回退');
    await expect(changes).toContainText('notes/b.md');
    await expect(card2.locator('[data-testid="task-revert"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="run-status"]')).toHaveCount(0, { timeout: 30_000 });
    // Cancelling never wakes the bot: still only the one waking turn (the first task's).
    await page.waitForTimeout(1_500);
    expect(llm.requestsFor('mock-main').filter(isWake)).toHaveLength(1);
  } finally {
    llm.releaseAll();
    await closeSession(session);
  }
});

test('a project write task cancelled from its card offers the whole-run revert', async () => {
  test.setTimeout(240_000);
  const session = await startSession('kepcup-e2e-tasks-project-');
  const { page, app, llm } = session;
  const project = makeProjectDir('kepcup-e2e-tasks-proj-');
  try {
    await waitReady(page);
    await createBotAndOpenChat(page, '小项任');
    await mockDirectoryPicker(app, project);
    await openProjectSelector(page);
    await page.locator('[data-testid="project-pick-new"]').click();
    await expect(
      page.locator('[data-testid="system-message"]').filter({ hasText: '项目已绑定' }),
    ).toHaveCount(1, { timeout: 15_000 });
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="project-picker-dialog"]')).not.toBeVisible();

    const held = step().inTask().hold().replyText('不会走到这里');
    llm.script('mock-main', [
      startTask('改项目', true),
      step().inTurn().replyText('好的，开始改项目'),
      step().inTask().replyToolCall('write', { path: 'demo.txt', content: 'demo' }),
      held,
    ]);
    await send(page, '改项目');
    const card = taskCard(page, '改项目');
    await expect(card).toHaveAttribute('data-task-state', 'running', { timeout: 60_000 });
    await expect.poll(() => held.consumed, { timeout: 30_000 }).toBe(true);
    expect(existsSync(path.join(project, 'demo.txt'))).toBe(true);

    await card.locator('[data-testid="task-cancel"]').click();
    await expect(card).toHaveAttribute('data-task-state', 'cancelled', { timeout: 30_000 });
    // The checkpoint summary lands once the lease is released (after-snapshot).
    await expect(card.locator('[data-testid="task-changes"]')).toContainText('新增 1', {
      timeout: 30_000,
    });
    await card.locator('[data-testid="task-revert"]').click();
    await expect(card.locator('[data-testid="task-changes-reverted"]')).toBeVisible({
      timeout: 30_000,
    });
    expect(existsSync(path.join(project, 'demo.txt'))).toBe(false);
    expect(readFileSync(path.join(project, 'README.md'), 'utf8')).toBe('# demo\n');
  } finally {
    llm.releaseAll();
    rmSync(project, { recursive: true, force: true });
    await closeSession(session);
  }
});

test('a task question card: picking an option goes straight into the task', async () => {
  test.setTimeout(240_000);
  const session = await startSession('kepcup-e2e-tasks-question-');
  const { page, llm } = session;
  try {
    await waitReady(page);
    await createBotAndOpenChat(page, '小问任');

    llm.script('mock-main', [
      startTask('选方案', false),
      step().inTurn().replyText('好的，我去看看方案'),
      step()
        .inTask()
        .replyToolCall('ask_user', { question: '用哪个方案？', options: ['A 方案', 'B 方案'] }),
      step()
        .inTask()
        .expect((req) => JSON.stringify(req.body).includes('用户的回答：B 方案'))
        .replyText('RESULT 按 B 方案准备好了'),
      step().inTurn().expect(isWake).replyText('按 B 方案准备好了'),
    ]);
    await send(page, '选方案');

    const question = page.locator('[data-testid="task-question-card"]');
    await expect(question).toBeVisible({ timeout: 60_000 });
    await expect(question.locator('[data-testid="task-question-text"]')).toContainText(
      '用哪个方案？',
    );
    await expect(taskCard(page, '选方案').getByText('等待你回答它的问题')).toBeVisible({
      timeout: 30_000,
    });
    await question.locator('[data-testid="task-question-option-1"]').click();
    await expect(question).toHaveAttribute('data-answered', 'true', { timeout: 30_000 });
    await expect(question.locator('[data-testid="task-question-answer"]')).toContainText('B 方案');
    await expect(botBubble(page, '按 B 方案准备好了')).toBeVisible({ timeout: 60_000 });
    await expect(taskCard(page, '选方案')).toHaveAttribute('data-task-state', 'completed', {
      timeout: 30_000,
    });
  } finally {
    llm.releaseAll();
    await closeSession(session);
  }
});
