import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page, _electron } from '@playwright/test';
import { startMockLlm, step, type MockLlmServer } from '@kepcup/testkit';
import { createBotAndOpenChat, openConversationByName, rpc } from './helpers/create-bot';
import { createGroupViaUi } from './helpers/create-group';
import { rmHomeTolerant } from './helpers/home-cleanup';

/**
 * 工作台（D90，docs/design/39-workbench.md）端到端：真实 Electron + 真实 core，模型用 mock LLM
 * 驱动。覆盖 todo/workbench.md §11 里界面可验证的部分——入口切换且不丢草稿、备忘全流程、
 * 闪念转事项 → 指派 → 立即开始 → 派发卡 → 待验收 → 完成、群派发（无人认领 / 指定负责 Bot）、
 * 定时派发（不受主动消息开关约束）、执行失败重试、Bot 自排卡。
 * 截图写到仓库根 `test-results/workbench-shots/`（不提交）。
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

const SHOT_DIR = path.resolve(process.cwd(), '../../test-results/workbench-shots');

async function shot(page: Page, name: string): Promise<void> {
  await mkdir(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) });
}

interface Session {
  app: ElectronApplication;
  page: Page;
  home: string;
  llm: MockLlmServer;
}

async function launchApp(home: string, llmUrl: string): Promise<ElectronApplication> {
  return _electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      KEPCUP_HOME: home,
      NODE_ENV: 'test',
      KEPCUP_KEYSTORE: 'file',
      KEPCUP_ONBOARDING: 'off',
      KEPCUP_FILE_KEYSTORE_PATH: path.join(home, '.test-master-key'),
      KEPCUP_MOCK_LLM_URL: llmUrl,
    },
  });
}

async function startSession(prefix: string): Promise<Session> {
  const llm = await startMockLlm();
  const home = await mkdtemp(path.join(tmpdir(), prefix));
  const app = await launchApp(home, llm.url);
  const page = await app.firstWindow();
  // resolveWindowOptions 把默认窗口钳制到显示器内：CI 的 Xvfb（默认 640×480）
  // 和部分 runner 的显示空间会让窗口落进 WorkbenchView 的 tab 形态（<760px），
  // memo-pane 不渲染。工作台用例统一钉 1280×840 内容尺寸，避免按显示器赌宽窄。
  await app.evaluate(({ BrowserWindow, screen }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return null;
    win.setSize(1280, 840);
    const bounds = win.getBounds();
    const workArea = screen.getPrimaryDisplay().workArea;
    return {
      bounds,
      workArea,
      scale: screen.getPrimaryDisplay().scaleFactor,
      maximized: win.isMaximized(),
    };
  });
  return { app, page, home, llm };
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
  await expect(
    page
      .locator('[data-testid="chat-view"]')
      .or(page.locator('[data-testid="start-chat-panel"]'))
      .or(page.locator('[data-testid="onboarding"]')),
  ).toBeVisible({ timeout: 60_000 });
  const startBackdrop = page.locator('[data-testid="start-chat-backdrop"]');
  if (await startBackdrop.isVisible())
    await startBackdrop.click({ timeout: 2_000 }).catch(() => {});
  // 设置「显示工作台」默认关闭（8b053df）：入口与分隔线隐藏，这里的用例都要先打开它。
  await rpc(page, 'settings.update', { workbenchEnabled: true });
  await expect(page.locator('[data-testid="workbench-nav"]')).toBeVisible({ timeout: 15_000 });
  // 双栏 seam（WorkbenchView.svelte）：runner 显示空间可以小到 1024×677，
  // 1280 窗口照样被钳；把 tab 形态强制为双栏，memo 侧断言与显示器解耦。
  // 要验证 tab 形态的用例自会 removeItem 覆盖这段。
  await page.evaluate(() => localStorage.setItem('kepcup.e2e.workbenchWide', '1'));
}

async function openWorkbench(page: Page): Promise<void> {
  await page.locator('[data-testid="workbench-nav"]').click();
  await expect(page.locator('[data-testid="workbench-view"]')).toBeVisible({ timeout: 15_000 });
}

/** 左栏点会话行（按 id）。 */
async function openRow(page: Page, conversationId: string): Promise<void> {
  await page.locator(`[data-testid="conversation-item-${conversationId}"]`).click();
  // chat.select 要连做多个 RPC（get/messages/runs 页）后才落 currentId，
  // 期间 chat-view 可见但仍是旧会话：必须等到行高亮切换，否则紧随其后的
  // fill 会打在旧会话的输入框里（慢机器上草稿会串号或被 setContent 丢弃）。
  await expect(page.locator(`[data-testid="conversation-item-${conversationId}"]`)).toHaveAttribute(
    'data-active',
    'true',
    { timeout: 15_000 },
  );
  await expect(page.locator('[data-testid="chat-view"]')).toBeVisible({ timeout: 15_000 });
}

/** datetime-local 输入框要的本地时间串。 */
function localInput(at: number): string {
  const d = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 抽屉里选执行者（Bot / 群，按显示名）。 */
async function pickAssignee(page: Page, name: string): Promise<void> {
  await page.locator('[data-testid="todo-assignee"]').click();
  await page.getByRole('option', { name, exact: true }).click();
}

async function quickAdd(page: Page, title: string): Promise<void> {
  const input = page.locator('[data-testid="todo-quick-add"]');
  await input.fill(title);
  await input.press('Enter');
  await expect(todoCard(page, title)).toBeVisible({ timeout: 15_000 });
}

function todoCard(page: Page, title: string) {
  return page.locator('[data-testid="todo-card"]').filter({
    has: page.locator('[data-testid="todo-card-title"]', { hasText: title }),
  });
}

function reflections(llm: MockLlmServer, n = 4): void {
  llm.script(
    'mock-light',
    Array.from({ length: n }, () => step().replyJson(emptyReflection())),
  );
}

test('workbench entry: switching keeps composer drafts, no conversation highlight while open', async () => {
  test.setTimeout(240_000);
  const session = await startSession('kepcup-e2e-wb-nav-');
  const { page } = session;
  try {
    await waitReady(page);
    const a = await createBotAndOpenChat(page, '阿甲');
    const b = await createBotAndOpenChat(page, '阿乙');

    // 甲的会话里留一份草稿，再切到乙。
    await openRow(page, a.conversationId);
    const composer = page.locator('[data-testid="composer-input"]');
    await composer.fill('甲的草稿还没发');
    await openRow(page, b.conversationId);
    await expect(composer).toHaveText('');
    await composer.fill('乙的草稿也没发');

    // 进工作台：主区换成工作台，侧栏没有任何对话选中高亮，入口自己高亮。
    await openWorkbench(page);
    await expect(page.locator('[data-testid="chat-view"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="workbench-nav"]')).toHaveAttribute(
      'data-active',
      'true',
    );
    await expect(
      page.locator('[data-testid^="conversation-item-"][data-active="true"]'),
    ).toHaveCount(0);
    await expect(page.locator('[data-testid="todo-pane"]')).toBeVisible();
    await expect(page.locator('[data-testid="memo-pane"]')).toBeVisible();
    await shot(page, '01-workbench-empty');

    // 回到刚才在看的会话（同一个 currentId）：草稿还在，高亮回来。
    await openRow(page, b.conversationId);
    await expect(composer).toHaveText('乙的草稿也没发');
    await expect(
      page.locator('[data-testid^="conversation-item-"][data-active="true"]'),
    ).toHaveCount(1);
    await expect(page.locator('[data-testid="workbench-nav"]')).not.toHaveAttribute(
      'data-active',
      'true',
    );

    // 从工作台点另一个会话：同样回到对话，那边的草稿也在。
    await openWorkbench(page);
    await openRow(page, a.conversationId);
    await expect(composer).toHaveText('甲的草稿还没发');
    await openRow(page, b.conversationId);
    await expect(composer).toHaveText('乙的草稿也没发');
  } finally {
    await closeSession(session);
  }
});

test('memos: add, edit, pin, search, delete and restore from recently deleted', async () => {
  test.setTimeout(240_000);
  const session = await startSession('kepcup-e2e-wb-memo-');
  const { page } = session;
  try {
    await waitReady(page);
    await openWorkbench(page);
    const input = page.locator('[data-testid="memo-input"]');
    await expect(page.locator('[data-testid="memo-empty"]')).toBeVisible({ timeout: 15_000 });

    // 回车保存、存完清空并保持焦点，可以连续记。
    await input.fill('买咖啡豆');
    await input.press('Enter');
    await expect(page.locator('[data-testid="memo-card"]')).toHaveCount(1, { timeout: 15_000 });
    await expect(input).toHaveValue('');
    await expect(input).toBeFocused();
    await input.pressSequentially('周五前交周报');
    await input.press('Shift+Enter');
    await input.pressSequentially('别忘了附上数据');
    await input.press('Enter');
    await expect(page.locator('[data-testid="memo-card"]')).toHaveCount(2);
    await input.fill('预约牙医');
    await input.press('Enter');
    await expect(page.locator('[data-testid="memo-card"]')).toHaveCount(3);

    const card = (text: string) =>
      page.locator('[data-testid="memo-card"]').filter({ hasText: text });
    // 最新的在最前。
    await expect(page.locator('[data-testid="memo-body"]').first()).toHaveText('预约牙医');
    // 多行备忘保留换行。
    await expect(card('周五前交周报').locator('[data-testid="memo-body"]')).toContainText(
      '别忘了附上数据',
    );

    // 编辑：点正文即改，防抖保存；Esc 放弃未保存改动。
    // 正文改掉后 hasText 就匹配不到了：用 cards 的 data-memo-id 稳住定位。
    const coffeeBody = card('买咖啡豆').locator('[data-testid="memo-body"]');
    await coffeeBody.click();
    await expect(coffeeBody).toBeFocused();
    await coffeeBody.fill('买咖啡豆和滤纸');
    // 等第一笔编辑落盘（500ms 防抖）：否则 Escape 回滚到的是旧值。
    await expect(coffeeBody).toContainText('买咖啡豆和滤纸', { timeout: 5_000 });
    await page.waitForTimeout(700);
    const coffeeCardId = await page
      .locator('[data-testid="memo-card"]')
      .filter({ has: page.locator('[data-testid="memo-body"]', { hasText: '买咖啡豆和滤纸' }) })
      .getAttribute('data-memo-id');
    expect(coffeeCardId).toMatch(/.+/);
    const coffeeCard = page.locator(`[data-memo-id="${coffeeCardId}"]`);
    const editedBody = coffeeCard.locator('[data-testid="memo-body"]');
    // Esc 放弃编辑。
    await editedBody.click();
    await editedBody.fill('不会保存的改动');
    await editedBody.press('Escape');
    await expect(coffeeCard.locator('[data-testid="memo-body"]')).toContainText('买咖啡豆和滤纸');
    await expect(page.locator('[data-testid="memo-body"]', { hasText: '不会保存的改动' })).toHaveCount(
      0,
    );

    // 置顶：被改过的「买咖啡豆和滤纸」排到最前并带 data-pinned。
    await coffeeCard.locator('[data-testid="memo-pin"]').click();
    await expect(page.locator('[data-testid="memo-card"]').first()).toHaveAttribute(
      'data-pinned',
      'true',
    );
    await expect(page.locator('[data-testid="memo-body"]').first()).toHaveText('买咖啡豆和滤纸');
    await shot(page, '02-workbench-memos');

    // 搜索：即时过滤，空结果给提示。
    const search = page.locator('[data-testid="memo-search"]');
    await search.fill('牙医');
    await expect(page.locator('[data-testid="memo-card"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="memo-body"]')).toHaveText('预约牙医');
    await search.fill('不存在的词');
    await expect(page.locator('[data-testid="memo-no-match"]')).toBeVisible();
    await search.fill('');
    await expect(page.locator('[data-testid="memo-card"]')).toHaveCount(3);

    // 删除 → 进最近删除 → 恢复。
    await card('预约牙医').locator('[data-testid="memo-delete"]').click();
    await expect(page.locator('[data-testid="memo-card"]')).toHaveCount(2);
    await page.locator('[data-testid="memo-trash"]').click();
    const trashItem = page.locator('[data-testid="memo-trash-item"]');
    await expect(trashItem).toHaveCount(1);
    await expect(trashItem).toContainText('预约牙医');
    await shot(page, '03-workbench-memo-trash');
    await trashItem.locator('[data-testid="memo-restore"]').click();
    await expect(page.locator('[data-testid="memo-trash-empty"]')).toBeVisible();
    await page.locator('[data-testid="memo-trash-back"]').click();
    await expect(page.locator('[data-testid="memo-card"]')).toHaveCount(3);
    await expect(card('预约牙医')).toBeVisible();
  } finally {
    await closeSession(session);
  }
});

test('memo → todo → assign a bot → start now → dispatch card → delivered → complete', async () => {
  test.setTimeout(300_000);
  const session = await startSession('kepcup-e2e-wb-flow-');
  const { page, llm } = session;
  try {
    await waitReady(page);
    const bot = await createBotAndOpenChat(page, '阿勤');
    // 另一个会话放前台：派发的私聊在工作台期间不是「正在看的」，回复要记未读。
    await createBotAndOpenChat(page, '阿闲');

    llm.script('mock-main', [
      step()
        .expect((r) => r.lastUserText().includes('和甲公司谈价'))
        .replyText('报价方案已整理：先报八折，底线九折。'),
    ]);
    reflections(llm);

    await openWorkbench(page);
    const input = page.locator('[data-testid="memo-input"]');
    await input.pressSequentially('下周和甲公司谈价');
    await input.press('Shift+Enter');
    await input.pressSequentially('带上去年的报价单');
    await input.press('Enter');
    await expect(page.locator('[data-testid="memo-card"]')).toHaveCount(1, { timeout: 15_000 });

    // 转为事项：抽屉预填，首行作标题，全文作说明。
    await page.locator('[data-testid="memo-to-todo"]').click();
    const drawer = page.locator('[data-testid="todo-drawer"]');
    await expect(drawer).toBeVisible();
    await expect(page.locator('[data-testid="todo-title"]')).toHaveValue('下周和甲公司谈价');
    await expect(page.locator('[data-testid="todo-notes"]')).toHaveValue(
      /下周和甲公司谈价\n带上去年的报价单/,
    );
    await expect(page.locator('[data-testid="todo-drawer-memo"]')).toBeVisible();
    // 没有执行者就不能选时间。
    await expect(page.locator('[data-testid="todo-when-now"]')).toBeDisabled();
    await shot(page, '04-todo-drawer-new');

    await pickAssignee(page, '阿勤');
    await page.locator('[data-testid="todo-when-now"]').click();
    await expect(page.locator('[data-testid="todo-when-next"]')).toContainText('立即派发');
    await shot(page, '05-todo-drawer-assigned-now');
    await page.locator('[data-testid="todo-save"]').click();
    await expect(drawer).toHaveCount(0, { timeout: 15_000 });

    // 备忘显示「已转事项」。
    await expect(page.locator('[data-testid="memo-converted"]')).toBeVisible();

    // 阿勤执行后交付 → 事项进入待验收（在阿勤的分道里）。
    const card = todoCard(page, '下周和甲公司谈价');
    await expect(card).toHaveAttribute('data-status', 'delivered', { timeout: 60_000 });
    const lane = page.locator('[data-testid="todo-lane"]').filter({
      has: page.locator('[data-testid="todo-lane-name"]', { hasText: '阿勤' }),
    });
    await expect(lane).toBeVisible();
    await expect(lane.locator('[data-testid="todo-lane-summary"]')).toContainText('待验收 1');
    await shot(page, '06-workbench-delivered');

    // 工作台期间该私聊在左栏记未读；点进去后清除。
    const row = page.locator(`[data-testid="conversation-item-${bot.conversationId}"]`);
    await expect(row.locator('[data-testid="unread-badge"]')).toBeVisible();
    await expect(row.locator('[data-testid="unread-badge"]')).toHaveText('1');

    // 「查看结果」：跳到对话里那条回复。
    await card.locator('[data-testid="todo-card-view-result"]').click();
    await expect(page.locator('[data-testid="chat-view"]')).toBeVisible({ timeout: 15_000 });
    await expect(row).toHaveAttribute('data-active', 'true');
    await expect(page.locator('[data-testid="unread-badge"]')).toHaveCount(0, { timeout: 15_000 });
    const dispatch = page.locator('[data-testid="dispatch-card"]');
    await expect(dispatch).toBeVisible();
    await expect(dispatch.locator('[data-testid="dispatch-card-title"]')).toHaveText(
      '下周和甲公司谈价',
    );
    await expect(dispatch.locator('[data-testid="dispatch-card-notes"]')).toContainText(
      '带上去年的报价单',
    );
    // 派发是工作台代发的，不渲染成普通用户气泡。
    await expect(page.locator('[data-testid="user-bubble"]')).toHaveCount(0);
    const reply = page.locator('[data-testid="bot-bubble"]').filter({ hasText: '报价方案已整理' });
    await expect(reply).toBeVisible();
    // 回复下方带事项标题标签。
    const tag = page.locator('[data-testid="todo-source"]');
    await expect(tag).toHaveText('下周和甲公司谈价');
    await shot(page, '07-chat-dispatch-card-and-reply');

    // 点标签回到工作台，定位到该事项（抽屉打开）→ 标记完成。
    await tag.click();
    await expect(page.locator('[data-testid="workbench-view"]')).toBeVisible({ timeout: 15_000 });
    await expect(drawer).toBeVisible();
    await expect(page.locator('[data-testid="todo-title"]')).toHaveValue('下周和甲公司谈价');
    // 执行记录：已交付，可跳到回复。
    await expect(page.locator('[data-testid="todo-run"]')).toHaveAttribute(
      'data-run-status',
      'delivered',
    );
    // 已开始的事项：时间只读显示实际派发时刻，没有可选的时间选择器。
    await expect(page.locator('[data-testid="todo-when-readonly"]')).toContainText('已于');
    await expect(page.locator('[data-testid="todo-when"]')).toHaveCount(0);
    await shot(page, '08-todo-drawer-delivered');
    await page.locator('[data-testid="todo-drawer-complete"]').click();
    // 已完成的事项收进「最近结束」（默认折叠）。
    await page.locator('[data-testid="todo-closed-toggle"]').click({ timeout: 15_000 });
    await expect(todoCard(page, '下周和甲公司谈价')).toHaveAttribute('data-status', 'done');
    await expect(
      page.locator('[data-testid="todo-lane"]').filter({ hasText: '下周和甲公司谈价' }),
    ).toHaveCount(0);
  } finally {
    await closeSession(session);
  }
});

test('group dispatch: nobody claims → back to draft; lead bot → @ route delivers', async () => {
  test.setTimeout(300_000);
  const session = await startSession('kepcup-e2e-wb-group-');
  const { page, llm } = session;
  try {
    await waitReady(page);
    await createBotAndOpenChat(page, '阿甲');
    await createBotAndOpenChat(page, '阿乙');
    await createGroupViaUi(page, '项目组', ['阿甲', '阿乙']);

    // 全员 triage 都不认领。
    llm.script('mock-light', [
      step()
        .expect((r) => r.lastUserText().includes('你的名片：阿甲'))
        .replyJson({ decision: 'not_mine', confidence: 0.5, reason: '不归我' }),
      step()
        .expect((r) => r.lastUserText().includes('你的名片：阿乙'))
        .replyJson({ decision: 'not_mine', confidence: 0.5, reason: '不归我' }),
    ]);

    await openWorkbench(page);
    await quickAdd(page, '整理竞品报告');
    await todoCard(page, '整理竞品报告').click();
    await expect(page.locator('[data-testid="todo-drawer"]')).toBeVisible();
    await pickAssignee(page, '项目组');
    // 选群后出现负责 Bot 选择器，默认「不指定」。
    await expect(page.locator('[data-testid="todo-lead-bot"]')).toContainText('不指定');
    await page.locator('[data-testid="todo-when-now"]').click();
    await shot(page, '09-todo-drawer-group');
    await page.locator('[data-testid="todo-save"]').click();
    await expect(page.locator('[data-testid="todo-drawer"]')).toHaveCount(0, { timeout: 15_000 });

    // 无人认领 → 退回草案，卡片显示原因，所在分道是未指派或群道的草案。
    const card = todoCard(page, '整理竞品报告');
    await expect(card.locator('[data-testid="todo-card-blocked"]')).toContainText('群里无人认领', {
      timeout: 60_000,
    });
    await expect(card).toHaveAttribute('data-status', 'draft');
    await shot(page, '10-todo-unclaimed');

    // 群对话里：工作台派发卡 + 无人认领提示。
    await card.locator('[data-testid="todo-card-start"]').scrollIntoViewIfNeeded();
    await page
      .locator('[data-testid^="conversation-item-"]')
      .filter({ hasText: '项目组' })
      .first()
      .click();
    await expect(page.locator('[data-testid="dispatch-card"]')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid="no-claim-bots"]')).toBeVisible({ timeout: 15_000 });

    // 回工作台：指定负责 Bot 阿甲，立即开始 → 走 @ 显式目标，阿甲回复 → 待验收。
    llm.script('mock-main', [
      step()
        .expect((r) => JSON.stringify(r.body.messages).includes('名字：阿甲'))
        .replyText('竞品报告已整理完。'),
    ]);
    reflections(llm);
    await openWorkbench(page);
    await todoCard(page, '整理竞品报告').click();
    await expect(page.locator('[data-testid="todo-drawer"]')).toBeVisible();
    await page.locator('[data-testid="todo-lead-bot"]').click();
    await page.getByRole('option', { name: '阿甲', exact: true }).click();
    await page.locator('[data-testid="todo-drawer-start"]').click();
    await expect(todoCard(page, '整理竞品报告')).toHaveAttribute('data-status', 'delivered', {
      timeout: 90_000,
    });
    await expect(
      todoCard(page, '整理竞品报告').locator('[data-testid="todo-card-blocked"]'),
    ).toHaveCount(0);
    await shot(page, '11-todo-group-delivered');
  } finally {
    await closeSession(session);
  }
});

test('scheduled todo: receipt card, next-fire display, fires on time even with proactive off', async () => {
  test.setTimeout(300_000);
  const session = await startSession('kepcup-e2e-wb-sched-');
  const { page, llm } = session;
  try {
    await waitReady(page);
    // 关闭主动消息：工作台派的活是用户的指令，照样派发（§4.4）。
    const bot = await createBotAndOpenChat(page, '阿时', { proactive: false });
    const got = (await rpc(page, 'bots.get', { id: bot.botId })) as {
      bot: { profile: { behavior: { proactive: boolean } } };
    };
    expect(got.bot.profile.behavior.proactive).toBe(false);

    llm.script('mock-main', [
      step()
        .expect((r) => r.lastUserText().includes('汇总周报'))
        .replyText('周报汇总好了。'),
    ]);
    reflections(llm);

    await openWorkbench(page);
    await quickAdd(page, '汇总周报');
    await todoCard(page, '汇总周报').click();
    await expect(page.locator('[data-testid="todo-drawer"]')).toBeVisible();
    await pickAssignee(page, '阿时');
    await expect(page.locator('[data-testid="todo-assignee"]')).toContainText('阿时');
    await page.locator('[data-testid="todo-when-once"]').click();
    await page
      .locator('[data-testid="todo-when-once-input"]')
      .fill(localInput(Date.now() + 3_600_000));
    await expect(page.locator('[data-testid="todo-when-next"]')).toContainText('下次');
    await shot(page, '12-todo-drawer-scheduled');
    await page.locator('[data-testid="todo-save"]').click();
    await expect(page.locator('[data-testid="todo-drawer"]')).toHaveCount(0, { timeout: 15_000 });

    const card = todoCard(page, '汇总周报');
    await expect(card).toHaveAttribute('data-status', 'scheduled');
    await expect(card.locator('[data-testid="todo-card-when"]')).toContainText(/今天|明天/);
    // 排期卡不显示「该 Bot 关闭了主动消息」之类的推迟警示——事项不受护栏约束。
    await expect(card.locator('[data-testid="todo-card-blocked"]')).toHaveCount(0);
    // 回执卡是用户在工作台自己的操作产生的：目标私聊在左栏不冒未读。
    await expect(
      page.locator(
        `[data-testid="conversation-item-${bot.conversationId}"] [data-testid="unread-badge"]`,
      ),
    ).toHaveCount(0);
    await shot(page, '13-workbench-scheduled');

    // 目标私聊里有回执卡（标题、时间、来源「工作台」）。
    await openRow(page, bot.conversationId);
    const receipt = page.locator('[data-testid="schedule-receipt"]');
    await expect(receipt).toContainText('汇总周报', { timeout: 15_000 });
    // 来源标注「工作台」（区别于 Bot 自己的安排）；回执卡不显示 Bot 自排的推迟警示。
    await expect(receipt.locator('[data-testid="schedule-receipt-workbench"]')).toBeVisible();
    await expect(receipt).toHaveAttribute('data-schedule-status', 'active');

    // 改期到几秒后（RPC 缝；真实时钟）：回执卡原地更新，到点派发。
    await openWorkbench(page);
    const todoId = await card.getAttribute('data-todo-id');
    await rpc(page, 'todos.update', {
      id: todoId,
      when: new Date(Date.now() + 6_000).toISOString(),
    });
    await openRow(page, bot.conversationId);
    await expect(page.locator('[data-testid="dispatch-card"]')).toBeVisible({ timeout: 60_000 });
    await expect(
      page.locator('[data-testid="bot-bubble"]').filter({ hasText: '周报汇总好了' }),
    ).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('[data-testid="schedule-receipt"]')).toHaveCount(1);
    await openWorkbench(page);
    await expect(todoCard(page, '汇总周报')).toHaveAttribute('data-status', 'delivered', {
      timeout: 30_000,
    });
  } finally {
    await closeSession(session);
  }
});

test('failed execution returns the todo to draft with the reason; start retries', async () => {
  test.setTimeout(300_000);
  const session = await startSession('kepcup-e2e-wb-fail-');
  const { page, llm } = session;
  try {
    await waitReady(page);
    await createBotAndOpenChat(page, '阿败');
    llm.script('mock-main', [
      step()
        .expect((r) => r.lastUserText().includes('整理发票'))
        .failWith(500, '模型服务暂时不可用'),
    ]);

    await openWorkbench(page);
    await quickAdd(page, '整理发票');
    await todoCard(page, '整理发票').locator('[data-testid="todo-card-assign"]').click();
    await pickAssignee(page, '阿败');
    await page.locator('[data-testid="todo-when-now"]').click();
    await page.locator('[data-testid="todo-save"]').click();
    await expect(page.locator('[data-testid="todo-drawer"]')).toHaveCount(0, { timeout: 15_000 });

    const card = todoCard(page, '整理发票');
    // 原始 `500: {"message":"…"}` 清洗成一行人话。
    await expect(card.locator('[data-testid="todo-card-blocked"]')).toContainText(
      '执行失败：模型服务出错（500）：模型服务暂时不可用',
      { timeout: 90_000 },
    );
    await expect(card).toHaveAttribute('data-status', 'draft');
    await shot(page, '14-todo-failed');

    // 重试：这一次成功。
    llm.script('mock-main', [
      step()
        .expect((r) => r.lastUserText().includes('整理发票'))
        .replyText('发票已整理。'),
    ]);
    reflections(llm);
    await card.locator('[data-testid="todo-card-start"]').click();
    await expect(todoCard(page, '整理发票')).toHaveAttribute('data-status', 'delivered', {
      timeout: 90_000,
    });
    await expect(
      todoCard(page, '整理发票').locator('[data-testid="todo-card-blocked"]'),
    ).toHaveCount(0);
  } finally {
    await closeSession(session);
  }
});

test('in progress: editing the notes tells the executor — an update card appears in the chat, the running turn is not interrupted', async () => {
  test.setTimeout(300_000);
  const session = await startSession('kepcup-e2e-wb-update-');
  const { page, llm } = session;
  try {
    await waitReady(page);
    await createBotAndOpenChat(page, '阿改');

    // 第一轮被挂起 = 事项处于进行中；更新消息要等它结束才进入下一轮（不打断）。
    llm.script('mock-main', [
      step()
        .expect((r) => r.lastUserText().includes('【工作台】整理合同'))
        .hold()
        .replyText('合同整理好了。'),
      step()
        .expect((r) => r.lastUserText().includes('事项更新：整理合同'))
        .replyText('收到更新，沿用当前做法。'),
    ]);
    reflections(llm);

    await openWorkbench(page);
    await quickAdd(page, '整理合同');
    await todoCard(page, '整理合同').locator('[data-testid="todo-card-assign"]').click();
    await pickAssignee(page, '阿改');
    await page.locator('[data-testid="todo-when-now"]').click();
    await page.locator('[data-testid="todo-save"]').click();
    const card = todoCard(page, '整理合同');
    await expect(card).toHaveAttribute('data-status', 'in_progress', { timeout: 30_000 });

    // 进行中的事项可以改说明；抽屉里提示会通知执行者。
    await card.click();
    const drawer = page.locator('[data-testid="todo-drawer"]');
    await expect(drawer).toBeVisible();
    await expect(page.locator('[data-testid="todo-notes-notify-hint"]')).toBeVisible();
    await page.locator('[data-testid="todo-notes"]').fill('只看 2026 年签的合同');
    await page.locator('[data-testid="todo-save"]').click();
    await expect(
      page.locator('[data-sonner-toast]').filter({ hasText: '将通知执行者' }),
    ).toBeVisible({
      timeout: 15_000,
    });
    await expect(drawer).toHaveCount(0, { timeout: 15_000 });

    // 去抖约 10 秒后，私聊里出现「事项更新」卡（变体），谁改的标「你修改了」。
    await card.locator('[data-testid="todo-card-open-chat"]').click();
    await expect(page.locator('[data-testid="chat-view"]')).toBeVisible({ timeout: 15_000 });
    const updateCard = page.locator('[data-testid="dispatch-card"][data-variant="update"]');
    await expect(updateCard).toBeVisible({ timeout: 60_000 });
    await expect(updateCard.locator('[data-testid="dispatch-card-label"]')).toContainText(
      '事项更新',
    );
    await expect(updateCard.locator('[data-testid="dispatch-card-updated-by"]')).toContainText(
      '你修改了',
    );
    await expect(updateCard.locator('[data-testid="dispatch-card-title"]')).toHaveText('整理合同');
    await expect(updateCard.locator('[data-testid="dispatch-card-notes"]')).toHaveText(
      '只看 2026 年签的合同',
    );
    // 卡里不显示正文末尾那行「（由用户修改；…）」。
    await expect(updateCard).not.toContainText('由用户修改');
    // 原来的派发卡仍在，两张是不同的变体。
    await expect(
      page.locator('[data-testid="dispatch-card"][data-variant="dispatch"]'),
    ).toHaveCount(1);
    await shot(page, '17-chat-update-card');

    // 第一轮没有被打断：放行后它正常回复，更新进入下一轮。
    llm.releaseAll();
    await expect(
      page.locator('[data-testid="bot-bubble"]').filter({ hasText: '合同整理好了' }),
    ).toBeVisible({ timeout: 60_000 });
    await expect(
      page.locator('[data-testid="bot-bubble"]').filter({ hasText: '收到更新，沿用当前做法' }),
    ).toBeVisible({ timeout: 60_000 });
  } finally {
    await closeSession(session);
  }
});

test('bot self-schedule shows in the bot lane with a source tag and can be cancelled', async () => {
  test.setTimeout(240_000);
  const session = await startSession('kepcup-e2e-wb-self-');
  const { page, llm } = session;
  try {
    await waitReady(page);
    await createBotAndOpenChat(page, '阿程');

    const when = new Date(Date.now() + 5 * 60_000).toISOString();
    llm.script('mock-main', [
      step()
        .expect((r) => r.lastUserText().includes('提醒'))
        .replyToolCall('schedule', { when, note: '提醒用户看报表', title: '看报表' }),
      step()
        .expect((r) => JSON.stringify(r.body).includes('已创建一次性定时任务'))
        .replyText('好的，到时提醒你'),
    ]);
    reflections(llm);
    const composer = page.locator('[data-testid="composer-input"]');
    await composer.fill('五分钟后提醒我看报表');
    await composer.press('ControlOrMeta+Enter');
    await expect(
      page.locator('[data-testid="bot-bubble"]').filter({ hasText: '到时提醒你' }),
    ).toBeVisible({ timeout: 30_000 });

    await openWorkbench(page);
    const lane = page.locator('[data-testid="todo-lane"]').filter({
      has: page.locator('[data-testid="todo-lane-name"]', { hasText: '阿程' }),
    });
    const self = lane.locator('[data-testid="self-schedule-card"]');
    await expect(self).toHaveCount(1, { timeout: 15_000 });
    await expect(self).toHaveAttribute('data-origin', 'tool');
    await expect(self.locator('[data-testid="self-schedule-source"]')).toHaveText('自排');
    await expect(self).toContainText('看报表');
    await expect(self.locator('[data-testid="self-schedule-when"]')).toContainText(/今天|明天/);
    await shot(page, '15-workbench-self-schedule');

    // 可取消（两步确认）。
    await self.locator('[data-testid="self-schedule-cancel"]').click();
    await self.locator('[data-testid="self-schedule-cancel-confirm"]').click();
    await expect(page.locator('[data-testid="self-schedule-card"]')).toHaveCount(0, {
      timeout: 15_000,
    });
  } finally {
    await closeSession(session);
  }
});

test('drawer: view from chat, dirty-close guard, repeat preset; deleting the executor returns todos to draft', async () => {
  test.setTimeout(300_000);
  const session = await startSession('kepcup-e2e-wb-extra-');
  const { page, llm } = session;
  try {
    await waitReady(page);
    const gone = await createBotAndOpenChat(page, '阿删');
    const keep = await createBotAndOpenChat(page, '阿查');

    llm.script('mock-main', [
      step()
        .expect((r) => r.lastUserText().includes('核对账目'))
        .replyText('账目核对完毕。'),
    ]);
    reflections(llm);

    await openWorkbench(page);
    await quickAdd(page, '核对账目');
    await todoCard(page, '核对账目').locator('[data-testid="todo-card-assign"]').click();
    await pickAssignee(page, '阿查');
    await page.locator('[data-testid="todo-when-now"]').click();
    await page.locator('[data-testid="todo-save"]').click();
    await expect(todoCard(page, '核对账目')).toHaveAttribute('data-status', 'delivered', {
      timeout: 60_000,
    });

    // 对话里的派发卡「在工作台查看」→ 工作台并打开该事项。
    await openRow(page, keep.conversationId);
    await page.locator('[data-testid="dispatch-card-view"]').click();
    await expect(page.locator('[data-testid="workbench-view"]')).toBeVisible({ timeout: 15_000 });
    const drawer = page.locator('[data-testid="todo-drawer"]');
    await expect(page.locator('[data-testid="todo-title"]')).toHaveValue('核对账目');
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);

    // 改了没存就关：先问「放弃并继续 / 继续编辑」。
    await todoCard(page, '核对账目').click();
    await page.locator('[data-testid="todo-notes"]').fill('补充说明');
    await page.locator('[data-testid="todo-drawer-close"]').click();
    await expect(page.locator('[data-testid="todo-discard"]')).toBeVisible();
    await page.locator('[data-testid="todo-discard-back"]').click();
    await expect(page.locator('[data-testid="todo-notes"]')).toHaveValue('补充说明');
    await page.locator('[data-testid="todo-drawer-close"]').click();
    await page.locator('[data-testid="todo-discard-continue"]').click();
    await expect(drawer).toHaveCount(0);

    // 周期事项：「重复」预设，卡片显示人话周期与下次时间。
    await quickAdd(page, '每日站会纪要');
    await todoCard(page, '每日站会纪要').click();
    await pickAssignee(page, '阿删');
    await page.locator('[data-testid="todo-when-repeat"]').click();
    await expect(page.locator('[data-testid="todo-when-next"]')).toContainText('下次');
    await page.locator('[data-testid="todo-save"]').click();
    await expect(drawer).toHaveCount(0, { timeout: 15_000 });
    const repeat = todoCard(page, '每日站会纪要');
    await expect(repeat).toHaveAttribute('data-status', 'scheduled');
    await expect(repeat.locator('[data-testid="todo-card-when"]')).toContainText('每天');
    await expect(repeat.locator('[data-testid="todo-card-when"]')).toContainText('下次');

    // 取消（两步确认）→ 进「最近结束」→ 恢复为草案。
    await quickAdd(page, '会被取消的事');
    await todoCard(page, '会被取消的事').click();
    await page.locator('[data-testid="todo-drawer-cancel"]').click();
    await page.locator('[data-testid="todo-drawer-cancel-confirm"]').click();
    await page.locator('[data-testid="todo-closed-toggle"]').click({ timeout: 15_000 });
    await expect(todoCard(page, '会被取消的事')).toHaveAttribute('data-status', 'cancelled');
    await todoCard(page, '会被取消的事').locator('[data-testid="todo-card-reopen"]').click();
    await expect(todoCard(page, '会被取消的事')).toHaveAttribute('data-status', 'draft');

    // 删除执行者 Bot：它名下的事项退回草案并说明原因（§11.5）。
    await rpc(page, 'bots.delete', { id: gone.botId });
    await expect(repeat).toHaveAttribute('data-status', 'draft', { timeout: 30_000 });
    await expect(repeat.locator('[data-testid="todo-card-blocked"]')).toBeVisible();
    await expect(
      page.locator('[data-testid="todo-lane"][data-lane-kind="unassigned"]').locator(repeat),
    ).toBeVisible();
  } finally {
    await closeSession(session);
  }
});

test('in progress shows the running state; restart keeps schedules and catches up a missed dispatch', async () => {
  test.setTimeout(300_000);
  const session = await startSession('kepcup-e2e-wb-restart-');
  let { app, page } = session;
  const { llm, home } = session;
  try {
    await waitReady(page);
    const bot = await createBotAndOpenChat(page, '阿重');

    // 进行中：执行者的回复被挂起，卡片是进行中、分道有「正在执行」圆点；放行后待验收。
    llm.script('mock-main', [
      step()
        .expect((r) => r.lastUserText().includes('慢活儿'))
        .hold()
        .replyText('慢活儿做完了。'),
    ]);
    reflections(llm);
    await openWorkbench(page);
    await quickAdd(page, '慢活儿');
    await todoCard(page, '慢活儿').locator('[data-testid="todo-card-assign"]').click();
    await pickAssignee(page, '阿重');
    await page.locator('[data-testid="todo-when-now"]').click();
    await page.locator('[data-testid="todo-save"]').click();
    const slow = todoCard(page, '慢活儿');
    await expect(slow).toHaveAttribute('data-status', 'in_progress', { timeout: 30_000 });
    await expect(page.locator('[data-testid="todo-lane-running"]')).toBeVisible({
      timeout: 30_000,
    });
    await expect(slow.locator('[data-testid="todo-card-open-chat"]')).toBeVisible();
    await shot(page, '16-workbench-in-progress');
    llm.releaseAll();
    await expect(slow).toHaveAttribute('data-status', 'delivered', { timeout: 30_000 });
    await expect(page.locator('[data-testid="todo-lane-running"]')).toHaveCount(0, {
      timeout: 30_000,
    });
    // 工作台开着时，当前会话（currentId）收到的回复也记未读；点它的行回到对话后清除。
    const botRow = page.locator(`[data-testid="conversation-item-${bot.conversationId}"]`);
    await expect(botRow.locator('[data-testid="unread-badge"]')).toHaveText('1');
    await botRow.click();
    await expect(page.locator('[data-testid="chat-view"]')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid="unread-badge"]')).toHaveCount(0, { timeout: 15_000 });
    await openWorkbench(page);
    await slow.locator('[data-testid="todo-card-complete"]').click();

    // 两个排期事项：几秒后的、一小时后的。随后关掉应用，让第一个在应用关闭期间到点。
    await rpc(page, 'todos.create', {
      title: '关机期间到点的事',
      assignee: { kind: 'bot', botId: bot.botId },
      when: new Date(Date.now() + 8_000).toISOString(),
    });
    await rpc(page, 'todos.create', {
      title: '一小时后的事',
      assignee: { kind: 'bot', botId: bot.botId },
      when: new Date(Date.now() + 3_600_000).toISOString(),
    });
    await app.close();
    // 迟到超过 SCHEDULE_LATE_BY_MIN_MS（60 秒）才会在派发卡上注明「延迟派发」。
    await new Promise((resolve) => setTimeout(resolve, 70_000));

    // 重启：错过的补发（派发卡注明延迟），未到点的仍是已排期（启动对账不能把它们退回草案）。
    llm.script('mock-main', [
      step()
        .expect((r) => r.lastUserText().includes('关机期间到点的事'))
        .replyText('补上了。'),
    ]);
    reflections(llm);
    app = await launchApp(home, llm.url);
    page = await app.firstWindow();
    await waitReady(page);
    await openWorkbench(page);
    await expect(todoCard(page, '关机期间到点的事')).toHaveAttribute('data-status', 'delivered', {
      timeout: 90_000,
    });
    await expect(todoCard(page, '一小时后的事')).toHaveAttribute('data-status', 'scheduled');
    await expect(
      todoCard(page, '一小时后的事').locator('[data-testid="todo-card-when"]'),
    ).toContainText(/今天|明天/);
    await openRow(page, bot.conversationId);
    const late = page
      .locator('[data-testid="dispatch-card"]')
      .filter({ hasText: '关机期间到点的事' });
    await expect(late).toBeVisible({ timeout: 15_000 });
    await expect(late.locator('[data-testid="dispatch-card-late"]')).toBeVisible();
    await shot(page, '17-chat-late-dispatch');
  } finally {
    await app.close().catch(() => {});
    await session.llm.stop();
    await rmHomeTolerant(home);
  }
});

/** 拉伸主窗口到指定内容尺寸（同 narrow-layout.spec）。 */
async function resizeWindow(
  app: ElectronApplication,
  width: number,
  height: number,
): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height);
    },
    { width, height },
  );
}

test('narrow window has no workbench; widening restores it, selecting a chat while narrow leaves it', async () => {
  test.setTimeout(240_000);
  const session = await startSession('kepcup-e2e-wb-narrow-');
  const { page, app } = session;
  try {
    await waitReady(page);
    await createBotAndOpenChat(page, '阿窄');
    await openWorkbench(page);
    await quickAdd(page, '窄屏前的事项');

    await resizeWindow(app, 375, 812);
    await expect(page.locator('[data-testid="workbench-view"]')).toHaveCount(0, {
      timeout: 15_000,
    });
    await expect(page.locator('[data-testid="workbench-nav"]')).toHaveCount(0);
    await shot(page, '18-narrow-no-workbench');

    // 窄屏下没有工作台：放宽后回到工作台，数据还在。
    await resizeWindow(app, 1280, 840);
    await expect(page.locator('[data-testid="workbench-view"]')).toBeVisible({ timeout: 15_000 });
    await expect(todoCard(page, '窄屏前的事项')).toBeVisible({ timeout: 15_000 });

    // 窄屏里选了一个会话，再放宽：停在对话而不是跳回工作台。
    await resizeWindow(app, 375, 812);
    await expect(page.locator('[data-testid="workbench-view"]')).toHaveCount(0, {
      timeout: 15_000,
    });
    // 窄屏恢复在当前会话的详情层：返回列表，再点一次这个会话。
    await page.locator('[data-testid="narrow-back-button"]').click();
    await openConversationByName(page, '阿窄');
    await resizeWindow(app, 1280, 840);
    await expect(page.locator('[data-testid="chat-view"]')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid="workbench-view"]')).toHaveCount(0);
  } finally {
    await closeSession(session);
  }
});

/** 元素自身或其任一后代横向溢出（内容比盒子宽）的描述——非空说明长文本撑破了布局。 */
async function overflowing(page: Page, rootSelector: string): Promise<string[]> {
  return page.evaluate((selector) => {
    const root = document.querySelector(selector);
    if (root === null) return ['<root missing>'];
    const found: string[] = [];
    for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
      const box = el as HTMLElement;
      const style = getComputedStyle(box);
      // 输入框自己内部滚动，不算撑破。
      if (box.tagName === 'INPUT' || box.tagName === 'TEXTAREA') continue;
      if (style.overflowX === 'auto' || style.overflowX === 'scroll') continue;
      // 设计内截断（省略号）不是撑破；窄窗口下 lane 名等靠它收敛。
      if (
        style.textOverflow === 'ellipsis' &&
        style.whiteSpace === 'nowrap' &&
        style.overflowX === 'hidden'
      )
        continue;
      if (box.scrollWidth > box.clientWidth + 1 && box.clientWidth > 0) {
        const id = box.getAttribute('data-testid') ?? '';
        found.push(
          `${box.tagName.toLowerCase()}[${id}].${String(box.className).slice(0, 60)} ${box.scrollWidth}>${box.clientWidth}`,
        );
      }
    }
    return found;
  }, rootSelector);
}

test('layout: long text does not overflow; tabs below the width threshold', async () => {
  test.setTimeout(240_000);
  const session = await startSession('kepcup-e2e-wb-layout-');
  const { page, app } = session;
  try {
    await waitReady(page);
    await createBotAndOpenChat(page, '阿长名字特别特别特别特别特别长的助手');
    const longTitle = '超长标题'.repeat(30);
    const longWord = 'x'.repeat(240);
    await openWorkbench(page);

    const memoInput = page.locator('[data-testid="memo-input"]');
    await memoInput.fill(`${longWord}`);
    await memoInput.press('Enter');
    await expect(page.locator('[data-testid="memo-card"]')).toHaveCount(1, { timeout: 15_000 });
    await memoInput.fill(Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 行`).join('\n'));
    await memoInput.press('Enter');
    await expect(page.locator('[data-testid="memo-card"]')).toHaveCount(2);

    await quickAdd(page, longTitle);
    await page
      .locator('[data-testid="todo-lane"][data-lane-kind="unassigned"] [data-testid="todo-lane-add"]')
      .click();
    await expect(page.locator('[data-testid="todo-drawer"]')).toBeVisible();
    await pickAssignee(page, '阿长名字特别特别特别特别特别长的助手');
    await page.locator('[data-testid="todo-title"]').fill(longTitle);
    await page.locator('[data-testid="todo-notes"]').fill(longWord);
    await page.locator('[data-testid="todo-when-once"]').click();
    await page
      .locator('[data-testid="todo-when-once-input"]')
      .fill(localInput(Date.now() + 3_600_000));
    await page.locator('[data-testid="todo-save"]').click();
    await expect(page.locator('[data-testid="todo-drawer"]')).toHaveCount(0, { timeout: 15_000 });
    await expect(page.locator('[data-testid="todo-card"]')).toHaveCount(2);

    // 12 行备忘卡正文最多 6 行。
    const clamped = page.locator('[data-testid="memo-body"]').first();
    const lines = await clamped.evaluate((el) => {
      const style = getComputedStyle(el);
      return Math.round(el.getBoundingClientRect().height / parseFloat(style.lineHeight));
    });
    expect(lines).toBeLessThanOrEqual(6);

    expect(await overflowing(page, '[data-testid="workbench-view"]')).toEqual([]);
    await shot(page, '19-layout-long-text');

    // 抽屉里的长标题也不撑破。
    await page.locator('[data-testid="todo-card"]').first().click();
    await expect(page.locator('[data-testid="todo-drawer"]')).toBeVisible();
    expect(await overflowing(page, '[data-testid="todo-drawer"]')).toEqual([]);
    await shot(page, '20-layout-long-drawer');
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="todo-drawer"]')).toHaveCount(0);

    // 视图宽度 < 760：折成「事项 / 备忘」两个 tab，各自不溢出。
    // seam（双栏强制）在挂载时刻生效且贯穿生命周期：本段要 tab 形态，
    // 先撤掉 waitReady 里的 seam 值、把窗口缩到阈值下，随后「回对话 →
    // 重新打开工作台」做一次 remount，挂载逻辑按新状态重新起形态。
    await page.evaluate(() => localStorage.removeItem('kepcup.e2e.workbenchWide'));
    await resizeWindow(app, 900, 760);
    await openConversationByName(page, '阿长名字特别特别特别特别特别长的助手');
    await expect(page.locator('[data-testid="chat-view"]')).toBeVisible({ timeout: 15_000 });
    await page.locator('[data-testid="workbench-nav"]').click();
    await expect(page.locator('[data-testid="workbench-tab-memos"]')).toBeVisible({
      timeout: 15_000,
    });

    await expect(page.locator('[data-testid="memo-pane"]')).toHaveCount(0);
    expect(await overflowing(page, '[data-testid="workbench-view"]')).toEqual([]);
    await shot(page, '21-layout-tabbed-todos');
    await page.locator('[data-testid="workbench-tab-memos"]').click();
    await expect(page.locator('[data-testid="memo-pane"]')).toBeVisible();
    await expect(page.locator('[data-testid="todo-pane"]')).toHaveCount(0);
    expect(await overflowing(page, '[data-testid="workbench-view"]')).toEqual([]);
    await shot(page, '22-layout-tabbed-memos');
  } finally {
    await closeSession(session);
  }
});

test('toast: hovering a toast expands it without turning it into a viewport-sized box', async () => {
  test.setTimeout(120_000);
  const session = await startSession('kepcup-e2e-wb-toast-');
  const { page, llm } = session;
  try {
    await waitReady(page);
    // 先渲染过一条 Bot 回复：streamdown（含 Mermaid 的全局样式）随消息列表加载后才会带上那条规则。
    await createBotAndOpenChat(page, '阿吐司');
    llm.script('mock-main', [step().replyText('你好，我是阿吐司。')]);
    reflections(llm, 2);
    const composer = page.locator('[data-testid="composer-input"]');
    await composer.fill('你好');
    await composer.press('ControlOrMeta+Enter');
    await expect(
      page.locator('[data-testid="bot-bubble"]').filter({ hasText: '阿吐司' }),
    ).toBeVisible({ timeout: 30_000 });
    await openWorkbench(page);
    const input = page.locator('[data-testid="memo-input"]');
    await input.fill('会被删掉的备忘');
    await input.press('Enter');
    await expect(page.locator('[data-testid="memo-card"]')).toHaveCount(1, { timeout: 15_000 });
    await page.locator('[data-testid="memo-delete"]').click();
    const toast = page.locator('[data-sonner-toast]').first();
    await expect(toast).toBeVisible();
    // 鼠标悬停 → sonner 把 toast 置为 data-expanded="true"。streamdown-svelte 的 Mermaid 全屏样式
    // 曾用全局 [data-expanded='true'] 把它变成 position: fixed 的整屏大块（盖住左侧栏）。
    await toast.hover();
    await expect(toast).toHaveAttribute('data-expanded', 'true');
    await expect(toast).toBeVisible();
    const box = await toast.boundingBox();
    expect(box?.height ?? 9999).toBeLessThan(200);
    expect(box?.width ?? 9999).toBeLessThan(500);
    expect(await toast.evaluate((el) => getComputedStyle(el).position)).toBe('absolute');
    // 撤销按钮仍可点：恢复刚删除的备忘。
    await toast.getByRole('button', { name: '撤销' }).click();
    await expect(page.locator('[data-testid="memo-card"]')).toHaveCount(1, { timeout: 15_000 });
  } finally {
    await closeSession(session);
  }
});
