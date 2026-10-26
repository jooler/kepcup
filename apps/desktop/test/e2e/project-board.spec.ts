import { mkdtempSync, writeFileSync } from 'node:fs';
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
import { startMockLlm, step, viaTask, type MockLlmServer } from '@kepcup/testkit';
import { createBotAndOpenChat } from './helpers/create-bot';
import { createProjectViaUi } from './helpers/create-project';
import { rmHomeTolerant } from './helpers/home-cleanup';

/**
 * P1 board: seed columns, column and card editing, the text dialog, drag,
 * layout, the chat draft across tabs, and a 375px-wide window.
 */

interface Session {
  app: ElectronApplication;
  page: Page;
  home: string;
  llm: MockLlmServer;
}

async function startSession(prefix: string): Promise<Session> {
  const llm = await startMockLlm();
  const home = await mkdtemp(path.join(tmpdir(), prefix));
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
    },
  });
  const page = await app.firstWindow();
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
  if (await startBackdrop.isVisible()) {
    await startBackdrop.click({ timeout: 2_000 }).catch(() => {});
  }
}

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

function columns(page: Page): Locator {
  return page.locator('[data-testid="board-column"]');
}

function columnTitled(page: Page, title: string): Locator {
  return columns(page).filter({
    has: page.locator('[data-testid="board-column-title"]', { hasText: title }),
  });
}

async function openBoard(page: Page): Promise<void> {
  await page.locator('[data-testid="project-tab-board"]').click();
  await expect(page.locator('[data-testid="project-board-view"]')).toBeVisible({ timeout: 15_000 });
}

async function columnIds(page: Page): Promise<string[]> {
  return columns(page).evaluateAll((els) =>
    els.map((el) => el.getAttribute('data-column-id') ?? ''),
  );
}

async function cardIds(column: Locator): Promise<string[]> {
  return column
    .locator('[data-testid="board-card"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-card-id') ?? ''));
}

/** Optimistic creates use a tmp_ id until the RPC returns. */
async function settledCardIds(column: Locator): Promise<string[]> {
  await expect
    .poll(async () => {
      const ids = await cardIds(column);
      return ids.length > 0 && ids.every((id) => !id.startsWith('tmp_'));
    })
    .toBe(true);
  return cardIds(column);
}

async function replaceTitle(page: Page, title: Locator, text: string): Promise<void> {
  await title.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
  await expect(title).toHaveText(text);
}

async function drag(
  page: Page,
  from: Locator,
  to: { x: number; y: number },
  release = true,
): Promise<void> {
  const box = await from.boundingBox();
  if (box === null) throw new Error('drag source has no box');
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 12, startY + 12, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 24 });
  if (!release) return;
  await releasePointer(page);
}

async function releasePointer(page: Page): Promise<void> {
  await page.mouse.up();
  // The drag library listens for mouseup on window. Deliver one directly in
  // case the OS event did not reach it (the floating clone would otherwise stick).
  await page.evaluate(() => {
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
  });
  await expect(page.locator('#dnd-action-dragged-el')).toHaveCount(0, { timeout: 2_000 });
}

test('project board: columns, cards, dialog, drag, layout, draft, narrow width', async () => {
  test.setTimeout(360_000);
  const session = await startSession('kepcup-e2e-project-board-');
  const { app, page } = session;
  try {
    await waitReady(page);
    await createBotAndOpenChat(page, '阿甲');
    await createBotAndOpenChat(page, '阿乙');
    await createProjectViaUi(page, '看板项目', ['阿甲', '阿乙']);

    // ① Seed three columns. Create, rename, and delete a column, including a
    // non-empty column that asks before it deletes its cards.
    await openBoard(page);
    await expect(columns(page)).toHaveCount(3, { timeout: 15_000 });
    await expect(page.locator('[data-testid="board-column-title"]')).toHaveText([
      '待办',
      '进行中',
      '已完成',
    ]);

    await page.locator('[data-testid="board-add-column"]').click();
    await expect(columns(page)).toHaveCount(4);
    const added = columns(page).nth(3);
    await replaceTitle(page, added.locator('[data-testid="board-column-title"]'), '归档');
    await added.locator('header').click({ button: 'right' });
    await page.getByRole('menuitem', { name: '删除分栏' }).click();
    await expect(columns(page)).toHaveCount(3);
    await expect(page.locator('[data-testid="board-column-delete-dialog"]')).toHaveCount(0);

    const todo = columnTitled(page, '待办');
    await todo.locator('[data-testid="board-column-add-card"]').click();
    const composer = todo.locator('[data-testid="board-card-composer"]');
    await expect(composer).toBeVisible();
    await composer.pressSequentially('要一起删');
    await composer.press('Enter');
    await expect(todo.locator('[data-testid="board-card"]', { hasText: '要一起删' })).toBeVisible();
    await todo.locator('header').click({ button: 'right' });
    await page.getByRole('menuitem', { name: '删除分栏' }).click();
    const deleteDialog = page.locator('[data-testid="board-column-delete-dialog"]');
    await expect(deleteDialog).toBeVisible();
    await expect(deleteDialog).toContainText('1');
    await page.locator('[data-testid="board-column-delete-confirm"]').click();
    await expect(columnTitled(page, '待办')).toHaveCount(0);
    await expect(columns(page)).toHaveCount(2);

    // ② New cards: Enter commits, blur commits, Escape discards, empty text is not stored.
    const doing = columnTitled(page, '进行中');
    await doing.locator('[data-testid="board-column-add-card"]').click();
    const doingComposer = doing.locator('[data-testid="board-card-composer"]');
    await doingComposer.pressSequentially('回车卡片');
    await doingComposer.press('Enter');
    await expect(
      doing.locator('[data-testid="board-card"]', { hasText: '回车卡片' }),
    ).toBeVisible();

    await doing.locator('[data-testid="board-column-add-card"]').click();
    await doingComposer.pressSequentially('失焦卡片');
    await page.locator('[data-testid="board-add-column"]').click();
    await expect(
      doing.locator('[data-testid="board-card"]', { hasText: '失焦卡片' }),
    ).toBeVisible();
    // Adding a column above focused the new title; dismiss that column so the
    // later drag has a stable set. It is empty, so delete is immediate.
    await columns(page).last().locator('header').click({ button: 'right' });
    await page.getByRole('menuitem', { name: '删除分栏' }).click();
    await expect(columns(page)).toHaveCount(2);

    const beforeEsc = await cardIds(doing);
    await doing.locator('[data-testid="board-column-add-card"]').click();
    await doingComposer.pressSequentially('不该留下');
    await page.keyboard.press('Escape');
    await expect(doingComposer).toHaveCount(0);
    await expect(doing.locator('[data-testid="board-card"]', { hasText: '不该留下' })).toHaveCount(
      0,
    );
    expect(await cardIds(doing)).toEqual(beforeEsc);

    const beforeBlank = await cardIds(doing);
    await doing.locator('[data-testid="board-column-add-card"]').click();
    await doingComposer.pressSequentially('   ');
    await page.locator('[data-testid="board-add-column"]').click();
    expect(await cardIds(doing)).toEqual(beforeBlank);
    await columns(page).last().locator('header').click({ button: 'right' });
    await page.getByRole('menuitem', { name: '删除分栏' }).click();
    await expect(columns(page)).toHaveCount(2);

    // ③ Dialog edit survives close and reopen. The card face is not editable.
    const face = doing.locator('[data-testid="board-card"]', { hasText: '回车卡片' });
    expect(await face.locator('[contenteditable]').count()).toBe(0);
    expect(await face.evaluate((el) => el.getAttribute('contenteditable'))).toBeNull();
    await face.click();
    const dialog = page.locator('[data-testid="board-dialog"]');
    await expect(dialog).toBeVisible();
    const dialogText = page.locator('[data-testid="board-dialog-text"]');
    await dialogText.click();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type('改过的文本');
    await page.waitForTimeout(800);
    await page.locator('[data-testid="board-dialog-close"]').click();
    await expect(dialog).toHaveCount(0);
    await expect(
      doing.locator('[data-testid="board-card"]', { hasText: '改过的文本' }),
    ).toBeVisible();
    await doing.locator('[data-testid="board-card"]', { hasText: '改过的文本' }).click();
    await expect(dialogText).toHaveText('改过的文本');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    // ④ Drag a card within a column and across columns, and reorder columns
    // by the header grip. The order survives a reload.
    await doing.locator('[data-testid="board-column-add-card"]').click();
    await doingComposer.pressSequentially('第二张');
    await doingComposer.press('Enter');
    await doing.locator('[data-testid="board-column-add-card"]').click();
    await doingComposer.pressSequentially('第三张');
    await doingComposer.press('Enter');
    // Each create inserts at the top, so the face order is 第三张, 第二张, 改过的文本.
    const beforeWithin = await settledCardIds(doing);
    const movedDownId = beforeWithin[0]!;
    const doingList = await doing.locator('[data-testid="board-column-cards"]').boundingBox();
    const movingBox = await doing.locator(`[data-card-id="${movedDownId}"]`).boundingBox();
    if (doingList === null || movingBox === null) throw new Error('missing card box');
    await drag(page, doing.locator(`[data-card-id="${movedDownId}"]`), {
      x: doingList.x + doingList.width / 2,
      y: movingBox.y + movingBox.height + 36,
    });
    await expect(page.locator('[data-testid="board-dialog"]')).toHaveCount(0);
    await expect(page.locator(`[data-card-id="${movedDownId}"]`)).toBeVisible();
    const within = await cardIds(doing);
    expect(within).toContain(movedDownId);
    expect(within).not.toEqual(beforeWithin);

    const movedId = within[0]!;
    const done = columnTitled(page, '已完成');
    const doneList = done.locator('[data-testid="board-column-cards"]');
    const doneBox = await doneList.boundingBox();
    if (doneBox === null) throw new Error('missing column list box');
    const moving = doing.locator(`[data-testid="board-card"][data-card-id="${movedId}"]`);
    await drag(page, moving, { x: doneBox.x + doneBox.width / 2, y: doneBox.y + 24 });
    await expect(
      done.locator(`[data-testid="board-card"][data-card-id="${movedId}"]`),
    ).toBeVisible();
    await expect(
      doing.locator(`[data-testid="board-card"][data-card-id="${movedId}"]`),
    ).toHaveCount(0);
    await expect(page.locator('[data-testid="board-dialog"]')).toHaveCount(0);

    const idsBeforeColumnDrag = await columnIds(page);
    const firstColumn = columns(page).first();
    const handle = firstColumn.locator('[data-testid="board-column-handle"]');
    await expect(handle).toBeVisible();
    const secondBox = await columns(page).nth(1).boundingBox();
    if (secondBox === null) throw new Error('missing column box');
    await drag(page, handle, { x: secondBox.x + secondBox.width - 8, y: secondBox.y + 24 });
    const idsAfterColumnDrag = await columnIds(page);
    expect(idsAfterColumnDrag).not.toEqual(idsBeforeColumnDrag);

    // Dragging the column title does not reorder columns.
    const title = columns(page).first().locator('[data-testid="board-column-title"]');
    const titleBox = await title.boundingBox();
    if (titleBox === null) throw new Error('missing title box');
    await page.mouse.move(titleBox.x + 8, titleBox.y + titleBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(titleBox.x + 180, titleBox.y + titleBox.height / 2, { steps: 8 });
    await page.mouse.up();
    expect(await columnIds(page)).toEqual(idsAfterColumnDrag);

    const cardOrder = await cardIds(columnTitled(page, '已完成'));
    const columnOrder = await columnIds(page);
    await page.reload();
    await waitReady(page);
    await openBoard(page);
    expect(await columnIds(page)).toEqual(columnOrder);
    expect(await cardIds(columnTitled(page, '已完成'))).toEqual(cardOrder);

    // A plain click still opens the dialog after a drag did not.
    await columnTitled(page, '已完成').locator('[data-testid="board-card"]').first().click();
    await expect(page.locator('[data-testid="board-dialog"]')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="board-dialog"]')).toHaveCount(0);

    // Space starts a keyboard drag; Enter opens the dialog.
    const keyboardCard = columnTitled(page, '进行中').locator('[data-testid="board-card"]').first();
    await keyboardCard.focus();
    await page.keyboard.press('Space');
    await expect(page.locator('#dnd-action-aria-alert')).toContainText('拖动', { timeout: 5_000 });
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Space');
    await keyboardCard.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-testid="board-dialog"]')).toBeVisible();
    await page.keyboard.press('Escape');

    // ⑤ Edge auto-scroll on the card list and the track, then the layout invariants.
    const list = columnTitled(page, '进行中').locator('[data-testid="board-column-cards"]');
    for (let n = 0; n < 14; n += 1) {
      await columnTitled(page, '进行中').locator('[data-testid="board-column-add-card"]').click();
      const field = columnTitled(page, '进行中').locator('[data-testid="board-card-composer"]');
      await field.pressSequentially(`滚动${n}`);
      await field.press('Enter');
    }
    await settledCardIds(columnTitled(page, '进行中'));
    const listBox = await list.boundingBox();
    const scrollCard = list.locator('[data-testid="board-card"]').first();
    if (listBox === null) throw new Error('missing list box');
    await list.evaluate((el) => {
      el.scrollTop = 0;
    });
    const beforeScroll = await list.evaluate((el) => el.scrollTop);
    await drag(
      page,
      scrollCard,
      { x: listBox.x + listBox.width / 2, y: listBox.y + listBox.height - 6 },
      false,
    );
    await page.waitForTimeout(900);
    const afterScroll = await list.evaluate((el) => el.scrollTop);
    await releasePointer(page);
    expect(afterScroll).toBeGreaterThan(beforeScroll);

    for (let n = 0; n < 6; n += 1) {
      await page.locator('[data-testid="board-add-column"]').click();
      await page.keyboard.press('Enter');
    }
    const track = page.locator('[data-testid="board-track"]');
    const trackBox = await track.boundingBox();
    if (trackBox === null) throw new Error('missing track box');
    const trackHandle = columns(page).first().locator('[data-testid="board-column-handle"]');
    const beforeTrack = await track.evaluate((el) => el.scrollLeft);
    const trackHandleBox = await trackHandle.boundingBox();
    if (trackHandleBox === null) throw new Error('missing column handle box');
    // The handle spans the header; its centre is empty header space, clear of
    // the title on the left and the buttons on the right.
    await page.mouse.move(
      trackHandleBox.x + trackHandleBox.width / 2,
      trackHandleBox.y + trackHandleBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(trackBox.x + 40, trackBox.y + 40, { steps: 4 });
    await page.mouse.move(trackBox.x + trackBox.width - 8, trackBox.y + 40, { steps: 16 });
    await page.waitForTimeout(800);
    const afterTrack = await track.evaluate((el) => el.scrollLeft);
    await releasePointer(page);
    expect(afterTrack).toBeGreaterThan(beforeTrack);

    const layout = await page.evaluate(() => {
      const view = document.querySelector('[data-testid="project-view"]');
      const board = document.querySelector('[data-testid="board-view"]');
      const trackEl = document.querySelector('[data-testid="board-track"]');
      const column = document.querySelector('[data-testid="board-column"]');
      const header = column?.querySelector('header');
      const cards = column?.querySelector('[data-testid="board-column-cards"]');
      const viewStyle = view ? getComputedStyle(view) : null;
      const trackStyle = trackEl ? getComputedStyle(trackEl) : null;
      const cardsStyle = cards ? getComputedStyle(cards) : null;
      const columnStyle = column ? getComputedStyle(column) : null;
      return {
        docScrolls:
          document.documentElement.scrollHeight > document.documentElement.clientHeight + 1,
        viewScrolls: view ? view.scrollHeight > view.clientHeight + 1 : true,
        viewOverflow: viewStyle?.overflowY ?? '',
        boardScrolls: board ? board.scrollHeight > board.clientHeight + 1 : true,
        trackOverflowX: trackStyle?.overflowX ?? '',
        trackOverflowY: trackStyle?.overflowY ?? '',
        cardsOverflowY: cardsStyle?.overflowY ?? '',
        columnBackground: columnStyle?.backgroundColor ?? '',
        headerInColumn: header !== null,
      };
    });
    expect(layout.docScrolls).toBe(false);
    expect(layout.viewScrolls).toBe(false);
    expect(layout.boardScrolls).toBe(false);
    expect(layout.trackOverflowX).toBe('auto');
    expect(layout.trackOverflowY).toBe('hidden');
    expect(layout.cardsOverflowY).toBe('auto');
    expect(layout.columnBackground).toBe('rgba(0, 0, 0, 0)');
    expect(layout.headerInColumn).toBe(true);

    const scrollingColumn = columnTitled(page, '进行中');
    const header = scrollingColumn.locator('header');
    const headerTop = (await header.boundingBox())?.y;
    const scrollingList = scrollingColumn.locator('[data-testid="board-column-cards"]');
    await scrollingList.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    expect(await scrollingList.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    expect((await header.boundingBox())?.y).toBe(headerTop);

    const trackMetrics = await track.evaluate((el) => ({
      overflowX: getComputedStyle(el).overflowX,
      scrolls: el.scrollWidth > el.clientWidth,
    }));
    expect(trackMetrics.overflowX).toBe('auto');
    expect(trackMetrics.scrolls).toBe(true);
    await track.evaluate((el) => {
      el.scrollLeft = 240;
    });
    expect(await track.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);

    // ⑥ Chat draft survives a round trip through the board.
    await page.locator('[data-testid="project-tab-chat"]').click();
    const composerInput = page.locator('[data-testid="composer-input"]');
    await composerInput.click();
    await composerInput.pressSequentially('看板往返草稿');
    await page.locator('[data-testid="project-tab-board"]').click();
    await expect(page.locator('[data-testid="project-board-view"]')).toBeVisible();
    await page.locator('[data-testid="project-tab-chat"]').click();
    await expect(composerInput).toContainText('看板往返草稿');

    // ⑦ 375px: the track still scrolls sideways and a column control still works.
    await page.locator('[data-testid="project-tab-board"]').click();
    await resizeWindow(app, 375, 800);
    await expect(page.locator('[data-testid="narrow-shell"]')).toBeVisible({ timeout: 15_000 });
    const narrowTrack = page.locator('[data-testid="board-track"]');
    await expect(narrowTrack).toBeVisible({ timeout: 15_000 });
    const narrow = await narrowTrack.evaluate((el) => ({
      scrolls: el.scrollWidth > el.clientWidth,
      width: el.clientWidth,
    }));
    // setSize(375) is the outer window; the track is the content box, a few
    // pixels wider than the request once the frame is applied.
    expect(narrow.width).toBeLessThan(420);
    expect(narrow.scrolls).toBe(true);
    await narrowTrack.evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
    });
    await expect(page.locator('[data-testid="board-add-column"]')).toBeVisible();
    const beforeNarrow = await columns(page).count();
    await page.locator('[data-testid="board-add-column"]').click();
    await expect(columns(page)).toHaveCount(beforeNarrow + 1);
  } finally {
    await closeSession(session);
  }
});

function scriptLight(llm: MockLlmServer): void {
  llm.script(
    'mock-light',
    Array.from({ length: 8 }, () =>
      step().replyJson({
        runSummary: '无',
        memories: [],
        profileProposals: [],
        wikiSuggestions: [],
        skillSuggestion: null,
      }),
    ),
  );
}

test('project board: assign, dialog chat, badge, deep link, cascade', async () => {
  test.setTimeout(360_000);
  const session = await startSession('kepcup-e2e-project-board-dialog-');
  const { app, page, llm } = session;
  try {
    await waitReady(page);
    await createBotAndOpenChat(page, '阿甲');
    await createBotAndOpenChat(page, '阿乙');
    await createProjectViaUi(page, '执行看板', ['阿甲', '阿乙']);
    await openBoard(page);

    const doing = columnTitled(page, '进行中');
    await doing.locator('[data-testid="board-column-add-card"]').click();
    const composer = doing.locator('[data-testid="board-card-composer"]');
    await composer.pressSequentially('写一句问候');
    await composer.press('Enter');
    const face = doing.locator('[data-testid="board-card"]', { hasText: '写一句问候' });
    await expect(face).toBeVisible();

    // ⑧ Assign a member and a time. The schedule shows on the project page.
    await face.click();
    const dialog = page.locator('[data-testid="board-dialog"]');
    await expect(dialog).toBeVisible();
    await dialog.locator('[data-testid="board-dialog-executor"]').click();
    await page.getByRole('menuitem', { name: '阿乙' }).click();
    await expect(dialog.locator('[data-testid="board-dialog-status"]')).toContainText('待开始');
    await dialog.locator('[data-testid="board-dialog-when"]').click();
    // The popover is portal'd to body so the dialog's scroll box cannot clip it.
    const whenPopover = page.locator('[data-testid="board-dialog-when-popover"]');
    await whenPopover.locator('[data-testid="todo-when-once"]').click();
    await whenPopover.locator('[data-testid="todo-when-once-input"]').fill('2099-06-01T09:00');
    await whenPopover.locator('[data-testid="board-dialog-when-save"]').click();
    await expect(dialog.locator('[data-testid="board-dialog-when"]')).not.toContainText('未设置');
    await dialog.locator('[data-testid="board-dialog-close"]').click();
    await expect(dialog).toHaveCount(0);

    await page.locator('[data-testid="project-settings-button"]').click();
    await page.locator('[data-testid="project-settings-nav-schedules"]').click();
    const schedule = page.locator(
      '[data-testid="project-schedules"] [data-testid^="schedule-item-"]',
    );
    await expect(schedule).toBeVisible({ timeout: 15_000 });
    await expect(schedule.locator('[data-testid="schedule-workbench"]')).toHaveText('工作台');
    await expect(schedule.locator('[data-testid="schedule-title"]')).toContainText('写一句问候');
    await page.locator('[data-testid="project-tab-board"]').click();

    // ⑨ Start, accept, reopen, and a card-thread reply that stays out of the direct chat.
    // The one-off schedule is cleared first: 「开始执行」 is the draft action.
    await face.click();
    await expect(dialog).toBeVisible();
    await dialog.locator('[data-testid="board-dialog-action-clearWhen"]').click();
    await expect(dialog.locator('[data-testid="board-dialog-status"]')).toContainText('待开始', {
      timeout: 15_000,
    });
    const held = step().hold().replyText('问候写好了');
    scriptLight(llm);
    llm.script('mock-main', [held]);
    await dialog.locator('[data-testid="board-dialog-action-start"]').click();
    await expect(dialog.locator('[data-testid="board-dialog-status"]')).toContainText('执行中', {
      timeout: 30_000,
    });
    await expect(dialog.locator('[data-testid="dispatch-card"]')).toContainText('任务派发');
    await expect(dialog.locator('[data-testid="dispatch-card-view"]')).toHaveCount(0);
    held.release();
    await expect(dialog.locator('[data-testid="bot-bubble"]').first()).toContainText('问候写好了', {
      timeout: 30_000,
    });
    await expect(dialog.locator('[data-testid="board-dialog-status"]')).toContainText('待验收', {
      timeout: 30_000,
    });
    await dialog.locator('[data-testid="board-dialog-action-accept"]').click();
    await expect(dialog.locator('[data-testid="board-dialog-status"]')).toContainText('已完成', {
      timeout: 15_000,
    });
    await dialog.locator('[data-testid="board-dialog-action-reopen"]').click();
    await expect(dialog.locator('[data-testid="board-dialog-status"]')).toContainText('待开始', {
      timeout: 15_000,
    });

    scriptLight(llm);
    llm.script('mock-main', [step().replyText('卡片里的回答')]);
    const cardComposer = dialog.locator('[data-testid="composer-input"]');
    await cardComposer.click();
    await cardComposer.pressSequentially('直接问一句');
    await cardComposer.press('ControlOrMeta+Enter');
    await expect(dialog.locator('[data-testid="bot-bubble"]').last()).toContainText(
      '卡片里的回答',
      {
        timeout: 30_000,
      },
    );
    const cardConversationId = await dialog
      .locator('[data-testid="board-dialog-chat"]')
      .getAttribute('data-conversation-id');
    expect(cardConversationId).toBeTruthy();
    await dialog.locator('[data-testid="board-dialog-close"]').click();

    await page.locator('[data-testid="conversation-name"]', { hasText: '阿乙' }).click();
    await expect(page.locator('[data-testid="chat-view"]')).toBeVisible();
    await expect(page.locator('[data-testid="chat-view"]')).not.toContainText('卡片里的回答');
    await expect(page.locator('[data-testid="chat-view"]')).not.toContainText('问候写好了');
    await page.locator('[data-testid="conversation-name"]', { hasText: '执行看板' }).click();
    await openBoard(page);
    await face.click();
    await expect(dialog.locator('[data-testid="bot-bubble"]').last()).toContainText('卡片里的回答');

    // ⑪ A new assignee gets a new thread. Clearing the assignee shows the empty state.
    await dialog.locator('[data-testid="board-dialog-executor"]').click();
    await page.getByRole('menuitem', { name: '阿甲' }).click();
    await expect(dialog.locator('[data-testid="bot-bubble"]')).toHaveCount(0);
    await expect(dialog.locator('[data-testid="board-dialog-chat"]')).not.toContainText(
      '卡片里的回答',
    );
    const reassignedId = await dialog
      .locator('[data-testid="board-dialog-chat"]')
      .getAttribute('data-conversation-id');
    expect(reassignedId).not.toBe(cardConversationId);
    await dialog.locator('[data-testid="board-dialog-executor"]').click();
    await page.locator('[data-testid="board-dialog-executor-none"]').click();
    await expect(dialog.locator('[data-testid="board-dialog-chat"]')).toContainText(
      '指派一位成员后',
    );
    await dialog.locator('[data-testid="board-dialog-executor"]').click();
    await page.getByRole('menuitem', { name: '阿乙' }).click();
    await expect(dialog.locator('[data-testid="board-dialog-chat"]')).toContainText('卡片里的回答');

    // ⑩ and ⑫ Approval in the dialog, tab and face badges, task page inside the dialog.
    const externalDir = mkdtempSync(path.join(tmpdir(), 'kepcup-e2e-board-approval-'));
    const externalPath = path.join(externalDir, 'note.txt');
    writeFileSync(externalPath, 'e2e-external-content');
    scriptLight(llm);
    llm.script(
      'mock-main',
      viaTask({
        title: '读外部文件',
        writes: false,
        ack: '好的，我去读',
        taskSteps: [
          step().replyToolCall('read', { path: externalPath }),
          step().replyText('文件内容已读到'),
        ],
        relay: '外部文件读完了',
      }),
    );
    await cardComposer.click();
    await cardComposer.pressSequentially('读一下外部文件');
    await cardComposer.press('ControlOrMeta+Enter');
    const approval = dialog.locator('[data-testid^="approval-card-"]');
    await expect(approval).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('[data-testid="project-tab-badge-board"]')).toBeVisible();
    await dialog.locator('[data-testid="board-dialog-close"]').click();
    await expect(face.locator('[data-testid="board-card-approval"]')).toBeVisible({
      timeout: 15_000,
    });
    await face.click();
    await expect(approval).toBeVisible();
    await dialog.locator('[data-testid="task-open-run"]').click();
    await expect(dialog.locator('[data-testid="task-run-view"]')).toBeVisible({ timeout: 15_000 });
    await dialog.locator('[data-testid="task-run-back"]').click();
    await expect(dialog.locator('[data-testid="task-run-view"]')).toHaveCount(0);
    await expect(dialog.locator('[data-testid="board-dialog-chat"]')).toContainText('好的，我去读');
    await dialog.locator('[data-testid="board-dialog-close"]').click();
    await page.locator('[data-testid="project-tab-chat"]').click();
    await expect(page.locator('[data-testid="task-run-view"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="project-tab-badge-board"]')).toBeVisible();
    await openBoard(page);
    await face.click();
    await approval.press('Enter');
    await expect(approval).toBeHidden({ timeout: 60_000 });
    await dialog.locator('[data-testid="board-dialog-close"]').click();
    await expect(face.locator('[data-testid="board-card-approval"]')).toHaveCount(0);
    // Tab badge also counts「待验收」and unread. On slower runners the approved
    // run can settle into delivered before this assertion, leaving a count
    // badge even though the approval itself is gone. Accept to quiet it.
    await face.click();
    await expect(dialog.locator('[data-testid="board-dialog-status"]')).toContainText('待验收', {
      timeout: 60_000,
    });
    await dialog.locator('[data-testid="board-dialog-action-accept"]').click();
    await expect(dialog.locator('[data-testid="board-dialog-status"]')).toContainText('已完成', {
      timeout: 15_000,
    });
    await dialog.locator('[data-testid="board-dialog-close"]').click();
    await expect(page.locator('[data-testid="project-tab-badge-board"]')).toHaveCount(0);

    // ⑭ Narrow dialog: details / chat tabs.
    await resizeWindow(app, 720, 800);
    await face.click();
    await expect(dialog.locator('[data-testid="board-dialog-tabs"]')).toBeVisible();
    await expect(dialog.locator('[data-testid="board-dialog-tab-chat"]')).toBeVisible();
    await dialog.locator('[data-testid="board-dialog-tab-chat"]').click();
    await expect(dialog.locator('[data-testid="board-dialog-chat"]')).toBeVisible();
    await dialog.locator('[data-testid="board-dialog-close"]').click();
    await resizeWindow(app, 1280, 800);

    // ⑮ A notification-style select of the card id opens the dialog, not the sidebar.
    await face.click();
    const linkedId = await dialog
      .locator('[data-testid="board-dialog-chat"]')
      .getAttribute('data-conversation-id');
    await dialog.locator('[data-testid="board-dialog-close"]').click();
    await page.locator('[data-testid="project-tab-chat"]').click();
    const beforeItems = await page.locator('[data-testid^="conversation-item-"]').count();
    await app.evaluate(({ BrowserWindow }, conversationId) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('navigate-conversation', conversationId);
    }, linkedId);
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid^="conversation-item-"]')).toHaveCount(beforeItems);
    await expect(
      page.locator(
        '[data-testid^="conversation-item-"][data-active="true"] [data-testid="conversation-name"]',
      ),
    ).toContainText('执行看板');
    await dialog.locator('[data-testid="board-dialog-close"]').click();

    // ⑯ Removing the assignee blocks the card and makes the thread read-only.
    await page.locator('[data-testid="project-settings-button"]').click();
    await page.locator('[data-testid="project-settings-nav-members"]').click();
    const memberRow = page
      .locator('[data-testid^="project-member-row-"]')
      .filter({ hasText: '阿乙' });
    await memberRow.locator('[data-testid^="project-member-remove-"]').click();
    await openBoard(page);
    await expect(face.locator('[data-testid="board-card-blocked"]')).toContainText(
      '执行成员已移出项目组',
    );
    await face.click();
    // The latest thread stays in the dialog, read-only, with the blocked reason.
    // Older executor threads are still not listed.
    await expect(dialog.locator('[data-testid="readonly-banner"]')).toBeVisible();
    await expect(dialog.locator('[data-testid="composer-readonly"]')).toBeVisible();
    await expect(dialog.locator('[data-testid="board-dialog-chat"]')).toContainText('卡片里的回答');
    await expect(dialog.locator('[data-testid="board-dialog-chat"]')).not.toContainText(
      '指派一位成员后',
    );
    await expect(dialog.locator('[data-testid="board-dialog-status"]')).toContainText(
      '执行成员已移出项目组',
    );
    await dialog.locator('[data-testid="board-dialog-close"]').click();

    // ⑬ Delete the card (with confirm) and the project, whose confirm counts cards.
    await page.locator('[data-testid="project-settings-button"]').click();
    await page.locator('[data-testid="project-settings-nav-danger"]').click();
    await page.locator('[data-testid="project-delete-begin"]').click();
    await expect(page.locator('[data-testid="project-delete-board-count"]')).toContainText('1');
    await page.getByRole('button', { name: '取消' }).click();
    await openBoard(page);
    await face.click({ button: 'right' });
    await page.getByRole('menuitem', { name: '删除卡片' }).click();
    const confirm = page.locator('[data-testid="board-card-delete-confirm"]');
    await expect(page.getByRole('dialog').filter({ has: confirm })).toContainText(
      '其对话与执行记录会一并删除',
    );
    await confirm.click();
    await expect(face).toHaveCount(0);

    await doing.locator('[data-testid="board-column-add-card"]').click();
    await doing.locator('[data-testid="board-card-composer"]').pressSequentially('栏里的卡');
    await doing.locator('[data-testid="board-card-composer"]').press('Enter');
    await doing.locator('header').click({ button: 'right' });
    await page.getByRole('menuitem', { name: '删除分栏' }).click();
    await page.locator('[data-testid="board-column-delete-confirm"]').click();
    await expect(columnTitled(page, '进行中')).toHaveCount(0);

    await page.locator('[data-testid="project-settings-button"]').click();
    await page.locator('[data-testid="project-settings-nav-danger"]').click();
    await page.locator('[data-testid="project-delete-begin"]').click();
    await expect(page.locator('[data-testid="project-delete-board-count"]')).toBeVisible();
    await page.locator('[data-testid="project-delete-confirm"]').click();
    await expect(page.locator('[data-testid="project-board-view"]')).toHaveCount(0);
  } finally {
    await closeSession(session);
  }
});
