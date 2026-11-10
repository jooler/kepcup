import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
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
import { createBotAndOpenChat } from './helpers/create-bot';
import { rmHomeTolerant } from './helpers/home-cleanup';

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
      TZ: 'Asia/Shanghai',
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
  await rmHomeTolerant(session.home);
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

/** Forces the native directory picker to return `dir` (no real dialog in e2e). */
async function mockDirectoryPicker(app: ElectronApplication, dir: string): Promise<void> {
  await app.evaluate(({ dialog }, target) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
  }, dir);
}

function makeWorkdirDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
  writeFileSync(path.join(dir, 'README.md'), '# demo\n');
  return dir;
}

/** 工作目录在统一二级菜单的行里：展开右栏、回菜单、点行打开选择器。 */
async function openWorkdirSelector(page: Page): Promise<void> {
  if (!(await page.locator('[data-testid="right-panel"]').isVisible())) {
    await page.locator('[data-testid="right-panel-toggle"]').click();
  }
  // 统一二级菜单：已在某个详情里先点返回回菜单（幂等，可重复调用）。
  const back = page.locator('[data-testid="bot-detail-back"]');
  if (await back.isVisible()) await back.click();
  await page.locator('[data-testid="bot-config-row-workdir"]').click();
}

// D75 W3（docs/design/30-supervisor-and-tasks.md §4.3 / §6 / §2.4.6）：派任务 →
// 任务卡（状态 / 进度归属 / 追加行）→ 结果经对话轮转述 → 卡片上取消（工作区
// 改动摘要 / 回退已退役）→ 问题卡点选直注任务。

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
    // Its progress reached the task card (single status overlay: task loops
    // share `runs.last_progress`, per design 30 §6.1 — never stacked bubbles;
    // origin bubbles are reserved for results relayed by the turn).
    await expect(card.locator('[data-testid="task-progress"]')).toContainText('先写第一份笔记', {
      timeout: 30_000,
    });
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

    // A second task, cancelled from its card (D93：用户取消会唤醒 Bot 确认).
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
    await expect(page.locator('[data-testid="task-status"]').first()).toContainText('长任务', {
      timeout: 30_000,
    });
    // 用户取消会再走一轮 wake（user_cancelled）；先备好应答，避免抢占后续脚本。
    llm.script('mock-main', [step().inTurn().expect(isWake).replyText('好的，长任务已取消')]);
    await card2.locator('[data-testid="task-cancel"]').click();
    await expect(card2).toHaveAttribute('data-task-state', 'cancelled', { timeout: 30_000 });
    await expect(card2.locator('[data-testid="task-cancel-reason"]')).toContainText('用户取消');
    await expect(card2.locator('[data-testid="task-changes"]')).toHaveCount(0);
    await expect(card2.locator('[data-testid="task-revert"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="task-status"]')).toHaveCount(0, { timeout: 30_000 });
    await expect(botBubble(page, '好的，长任务已取消')).toBeVisible({ timeout: 30_000 });
    // 完成 wake（第一条任务）+ 取消 wake（第二条）共两轮。
    expect(llm.requestsFor('mock-main').filter(isWake)).toHaveLength(2);
  } finally {
    llm.releaseAll();
    await closeSession(session);
  }
});

test('a workdir write task cancelled from its card leaves disk changes and no revert UI', async () => {
  test.setTimeout(240_000);
  const session = await startSession('kepcup-e2e-tasks-workdir-');
  const { page, app, llm } = session;
  const workdir = makeWorkdirDir('kepcup-e2e-tasks-proj-');
  try {
    await waitReady(page);
    await createBotAndOpenChat(page, '小项任');
    await mockDirectoryPicker(app, workdir);
    await openWorkdirSelector(page);
    // 待确认的目录设置弹框 → 保存正式绑定。
    await expect(page.locator('[data-testid="workdir-settings-dialog"]')).toBeVisible({
      timeout: 15_000,
    });
    await page.locator('[data-testid="workdir-save"]').click();
    await expect(
      page.locator('[data-testid="system-message"]').filter({ hasText: '工作目录已绑定' }),
    ).toHaveCount(1, { timeout: 15_000 });
    await expect(page.locator('[data-testid="workdir-settings-dialog"]')).not.toBeVisible();

    const held = step().inTask().hold().replyText('不会走到这里');
    llm.script('mock-main', [
      startTask('改工作目录', true),
      step().inTurn().replyText('好的，开始改工作目录'),
      step().inTask().replyToolCall('write', { path: 'demo.txt', content: 'demo' }),
      held,
    ]);
    await send(page, '改工作目录');
    const card = taskCard(page, '改工作目录');
    await expect(card).toHaveAttribute('data-task-state', 'running', { timeout: 60_000 });
    await expect.poll(() => held.consumed, { timeout: 30_000 }).toBe(true);
    expect(existsSync(path.join(workdir, 'demo.txt'))).toBe(true);

    await card.locator('[data-testid="task-cancel"]').click();
    await expect(card).toHaveAttribute('data-task-state', 'cancelled', { timeout: 30_000 });
    await expect(card.locator('[data-testid="task-changes"]')).toHaveCount(0);
    await expect(card.locator('[data-testid="task-revert"]')).toHaveCount(0);
    expect(existsSync(path.join(workdir, 'demo.txt'))).toBe(true);
    expect(readFileSync(path.join(workdir, 'README.md'), 'utf8')).toBe('# demo\n');
  } finally {
    llm.releaseAll();
    rmSync(workdir, { recursive: true, force: true });
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

// D115/D116/D117（docs/design/56）：任务详情页注入坞直注 → steer 气泡；Bot 详情
// 三 tab（详情 / 组件 / 任务）——任务 tab 列出该 Bot 的任务、行点击进详情页。
test('inject dock steers a running task; bot detail tabs list its tasks', async () => {
  test.setTimeout(240_000);
  const session = await startSession('kepcup-e2e-tasks-steer-');
  const { page, llm } = session;
  try {
    await waitReady(page);
    await createBotAndOpenChat(page, '小控');

    const held = step().inTask().hold().replyToolCall('read', { path: 'notes/a.md' });
    const final = step()
      .inTask()
      .expect((req) => JSON.stringify(req.body).includes('加个日期'))
      .replyText('RESULT 直注完成');
    // 单脚本：held 之后的 final / wake 一直留在队列里（再次 script() 会整体替换，
    // 会把未消费的 final 顶掉）。
    llm.script('mock-main', [
      startTask('直注任务', false),
      step().inTurn().replyText('好的，直注任务开始'),
      held,
      final,
      step().inTurn().expect(isWake).replyText('直注任务做完了'),
    ]);
    await send(page, '直注任务');
    const card = taskCard(page, '直注任务');
    await expect(card).toHaveAttribute('data-task-state', 'running', { timeout: 60_000 });
    await expect.poll(() => held.consumed, { timeout: 30_000 }).toBe(true);

    // D116 修订：任务详情页只占中间对话区——右栏打开着进任务页，应保持可见。
    if (!(await page.locator('[data-testid="right-panel"]').isVisible())) {
      await page.locator('[data-testid="right-panel-toggle"]').click();
    }
    await expect(page.locator('[data-testid="right-panel"]')).toBeVisible();

    // Open the task detail page: the inject dock sits at the very bottom.
    await card.click();
    await expect(page.locator('[data-testid="task-run-view"]')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid="right-panel"]')).toBeVisible();
    const injectInput = page.locator('[data-testid="task-run-inject-input"]');
    await expect(injectInput).toBeVisible();
    await injectInput.fill('加个日期');
    await page.locator('[data-testid="task-run-inject-send"]').click();
    // Delivered: the steer bubble appears in the timeline.
    await expect(page.locator('[data-testid="task-run-steer-text"]')).toContainText('加个日期', {
      timeout: 30_000,
    });

    // The task finishes; the dock hides on the terminal state, the report shows.
    held.release();
    await expect(page.locator('[data-testid="task-run-report"]')).toContainText('RESULT 直注完成', {
      timeout: 60_000,
    });
    await expect(page.locator('[data-testid="task-run-inject"]')).toHaveCount(0);

    // Back to the chat, open the bot detail: default tab is 详情.
    await page.locator('[data-testid="task-run-back"]').click();
    if (!(await page.locator('[data-testid="right-panel"]').isVisible())) {
      await page.locator('[data-testid="right-panel-toggle"]').click();
    }
    await expect(page.locator('[data-testid="right-panel-tabs"]')).toBeVisible();
    await expect(page.locator('[data-testid="right-panel-tab-detail"]')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.locator('[data-testid="right-panel-tab-tasks-badge"]')).toHaveCount(0);

    // 任务 tab: the finished task is listed; clicking the row reopens its page.
    await page.locator('[data-testid="right-panel-tab-tasks"]').click();
    const row = page.locator('[data-testid^="bot-task-item-"]').first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toContainText('直注任务');
    await row.click();
    await expect(page.locator('[data-testid="task-run-view"]')).toBeVisible({ timeout: 15_000 });
    await page.locator('[data-testid="task-run-back"]').click();

    // 组件 tab: no widgets yet → the empty state.
    await page.locator('[data-testid="right-panel-tab-widgets"]').click();
    await expect(page.locator('[data-testid="bot-widgets-tab-empty"]')).toBeVisible({
      timeout: 15_000,
    });
    await page.locator('[data-testid="right-panel-tab-detail"]').click();
    await expect(page.locator('[data-testid="bot-menu"]')).toBeVisible();
  } finally {
    llm.releaseAll();
    await closeSession(session);
  }
});
