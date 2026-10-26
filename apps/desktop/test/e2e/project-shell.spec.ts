import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page, _electron } from '@playwright/test';
import { startMockLlm, type MockLlmServer } from '@kepcup/testkit';
import { createBotAndOpenChat, openConversationByName } from './helpers/create-bot';
import { createProjectViaUi } from './helpers/create-project';
import { rmHomeTolerant } from './helpers/home-cleanup';

/**
 * 项目组外壳（D92 41 §11.2，WP8）：两行顶栏与模块 tab、不渲染右栏、详情页
 * 经 ⚙、跨 tab 草稿保留、成员弹层、授权撤销一步可达、窄屏与单聊回归。
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

/** Electron 窗口尺寸（窄屏断点 <640，见 narrow-layout.ts）。 */
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

test('project shell: header, tabs, no right panel, settings page, draft, members menu, grants, narrow, direct chat unaffected', async () => {
  test.setTimeout(300_000);
  const session = await startSession('kepcup-e2e-project-shell-');
  const { app, page } = session;
  try {
    await waitReady(page);
    await createBotAndOpenChat(page, '阿甲');
    await createBotAndOpenChat(page, '阿乙');
    await createBotAndOpenChat(page, '阿丙');
    await createProjectViaUi(page, '外壳项目', ['阿甲', '阿乙']);

    // ① 单行顶栏：模块 tab；沟通激活，Wiki 可点；planned 模块不渲染。
    const tabs = page.locator('[data-testid="project-tabs"]');
    await expect(tabs).toBeVisible();
    await expect(page.locator('[data-testid="project-tab-chat"]')).toHaveAttribute(
      'data-active',
      'true',
    );
    await expect(page.locator('[data-testid="project-tab-board"]')).toBeVisible();
    // A new project has nothing for the board to report, so the badge stays hidden.
    await expect(page.locator('[data-testid="project-tab-badge-board"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="project-view"]')).toHaveAttribute('data-view', 'chat');
    for (const id of ['okr', 'calendar']) {
      await expect(page.locator(`[data-testid="project-tab-${id}"]`)).toHaveCount(0);
    }
    await page.locator('[data-testid="project-tab-wiki"]').click();
    await expect(page.locator('[data-testid="project-view"]')).toHaveAttribute('data-view', 'wiki');
    // D92 T1b WP10：Wiki tab 的真实视图（原占位符已被 ProjectWikiView 取代）。
    await expect(page.locator('[data-testid="project-wiki-view"]')).toBeVisible();
    await expect(page.locator('[data-testid="project-wiki-view"]')).toHaveAttribute(
      'data-owner-kind',
      'project',
    );

    // ② 项目组不渲染右栏（药丸与面板都不存在）。
    await expect(page.locator('[data-testid="right-panel"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="right-panel-toggle"]')).toHaveCount(0);

    // ④ 草稿保留：输入未发送文字 → 切 Wiki → 切回沟通，文字还在。
    await page.locator('[data-testid="project-tab-chat"]').click();
    await expect(page.locator('[data-testid="project-view"]')).toHaveAttribute('data-view', 'chat');
    const composer = page.locator('[data-testid="composer-input"]');
    await composer.click();
    await composer.pressSequentially('草稿保留验证');
    await page.locator('[data-testid="project-tab-wiki"]').click();
    await expect(page.locator('[data-testid="project-view"]')).toHaveAttribute('data-view', 'wiki');
    await page.locator('[data-testid="project-tab-chat"]').click();
    await expect(page.locator('[data-testid="project-view"]')).toHaveAttribute('data-view', 'chat');
    await expect(composer).toContainText('草稿保留验证');

    // ③ ⚙ 打开详情页（内容区页面）：所有 tab 无激活态；点 tab 返回沟通。
    await page.locator('[data-testid="project-settings-button"]').click();
    await expect(page.locator('[data-testid="project-settings-page"]')).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator('[data-testid="project-view"]')).toHaveAttribute(
      'data-view',
      'settings',
    );
    for (const id of ['chat', 'wiki']) {
      await expect(page.locator(`[data-testid="project-tab-${id}"]`)).not.toHaveAttribute(
        'data-active',
        'true',
      );
    }
    await page.locator('[data-testid="project-tab-chat"]').click();
    await expect(page.locator('[data-testid="project-view"]')).toHaveAttribute('data-view', 'chat');

    // ⑤ 成员弹层：负责人置顶带标；菜单不再有「添加成员」入口（加人收编进
    // 「管理成员…」→详情页成员分区）；点外部与 Esc 都能关。
    await page.locator('[data-testid="project-members-trigger"]').click();
    const menu = page.locator('[data-testid="project-members-menu"]');
    await expect(menu).toBeVisible();
    const menuRows = menu.locator('[data-testid^="project-member-row-"]');
    await expect(menuRows).toHaveCount(2);
    await expect(menuRows.first()).toContainText('阿甲');
    await expect(menuRows.first()).toContainText('负责人');
    await expect(menu.locator('[data-testid="project-members-add"]')).toHaveCount(0);
    await expect(menu.locator('[data-testid="project-member-add"]')).toHaveCount(0);
    // 点弹层外部关闭。
    await page.locator('[data-testid="composer-input"]').click();
    await expect(menu).toHaveCount(0);
    // 再开一次，Esc 关闭。
    await page.locator('[data-testid="project-members-trigger"]').click();
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    // 管理成员：弹层直达详情页成员分区，底部选择器搜索加入阿丙。
    await page.locator('[data-testid="project-members-trigger"]').click();
    await expect(menu).toBeVisible();
    await menu.locator('[data-testid="project-members-manage"]').click();
    await expect(page.locator('[data-testid="project-settings-page"]')).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator('[data-testid="project-settings-section-members"]')).toBeVisible();
    const memberAdd = page.locator('[data-testid="project-member-add"]');
    await memberAdd.fill('阿丙');
    await page
      .locator('[data-testid^="project-member-add-option-"]')
      .filter({ hasText: '阿丙' })
      .click();
    await expect(
      page.locator('[data-testid="project-member-list"] [data-testid^="project-member-row-"]'),
    ).toHaveCount(3, { timeout: 10_000 });
    // 回沟通：⑥ 的 ⚙ 是切换键，要求从沟通视图出发。
    await page.locator('[data-testid="project-tab-chat"]').click();
    await expect(page.locator('[data-testid="project-view"]')).toHaveAttribute('data-view', 'chat');
    // 点弹层外部关闭。
    await page.locator('[data-testid="composer-input"]').click();
    await expect(menu).toHaveCount(0);
    // 再开一次，Esc 关闭。
    await page.locator('[data-testid="project-members-trigger"]').click();
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);

    // ⑥ 授权撤销一步可达：⚙ → 授权分区导航直达（本会话没有授权：空态）。
    await page.locator('[data-testid="project-settings-button"]').click();
    await expect(page.locator('[data-testid="project-settings-page"]')).toBeVisible({
      timeout: 15_000,
    });
    await page.locator('[data-testid="project-settings-nav-grants"]').click();
    await expect(page.locator('[data-testid="project-settings-section-grants"]')).toBeVisible();
    await expect(page.locator('[data-testid="project-grants-empty"]')).toBeVisible();
    // 回沟通：⚙ 是切换键，窄屏段的「点开详情页」要求从沟通视图出发。
    await page.locator('[data-testid="project-tab-chat"]').click();
    await expect(page.locator('[data-testid="project-view"]')).toHaveAttribute('data-view', 'chat');

    // ⑦ 窄屏（600×800 < 640 断点）：返回按钮、tab 行横向滚动、⚙ 可用。
    await resizeWindow(app, 600, 800);
    await expect(page.locator('[data-testid="narrow-shell"]')).toBeVisible({ timeout: 15_000 });
    // 窄屏保留当前会话：可能直接在详情层；若停在列表层则点开项目组。
    const projectHeader = page.locator('[data-testid="project-header"]');
    if (!(await projectHeader.isVisible())) {
      await page
        .locator('[data-testid^="conversation-item-"]', { hasText: '外壳项目' })
        .first()
        .click();
    }
    await expect(projectHeader).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid="narrow-back-button"]')).toBeVisible();
    // tab 行横向滚动：600px 下五个 tab 可能仍放得下，压到 420px（同 WP6 冒烟）
    // 才必然溢出——overflow-x-auto 的行为断言。
    await resizeWindow(app, 420, 800);
    await expect(page.locator('[data-testid="narrow-back-button"]')).toBeVisible();
    // tab 行为断言走「机制」不走「指标」：实测三平台 420px 下行宽各不相同
    // （ubuntu 272 恰好放下、win 256 放下、mac 同窗标题图标占位后 204×239 溢出），
    // 「必然溢出」与「必然放下」都不成立。可跨平台恒真的契约是：行根
    // overflow-x-auto（真溢出时可滚）+ nowrap 不换行 + 每枚按钮 shrink-0。
    const tabsProbe = await page.locator('[data-testid="project-tabs"]').evaluate((el) => {
      const style = getComputedStyle(el);
      const buttons = Array.from(el.querySelectorAll('button')).map((button) => ({
        shrink: getComputedStyle(button).flexShrink,
      }));
      return { overflowX: style.overflowX, whiteSpace: style.whiteSpace, buttons };
    });
    expect(tabsProbe.overflowX).toBe('auto');
    expect(tabsProbe.whiteSpace).not.toBe('normal');
    expect(tabsProbe.buttons.length).toBeGreaterThan(0);
    for (const button of tabsProbe.buttons) {
      expect(button.shrink).toBe('0');
    }
    await resizeWindow(app, 600, 800);
    await page.locator('[data-testid="project-settings-button"]').click();
    await expect(page.locator('[data-testid="project-settings-page"]')).toBeVisible({
      timeout: 15_000,
    });
    await page.locator('[data-testid="project-tab-chat"]').click();
    await expect(page.locator('[data-testid="project-view"]')).toHaveAttribute('data-view', 'chat');

    // ⑧ 恢复宽屏：单聊不受影响——药丸在、右栏可开合。
    await resizeWindow(app, 1280, 800);
    await expect(page.locator('[data-testid="narrow-shell"]')).toHaveCount(0, { timeout: 15_000 });
    await openConversationByName(page, '阿甲');
    await expect(page.locator('[data-testid="right-panel-toggle"]')).toBeVisible();
    await page.locator('[data-testid="right-panel-toggle"]').click();
    await expect(page.locator('[data-testid="right-panel"]')).toBeVisible({ timeout: 15_000 });
  } finally {
    await closeSession(session);
  }
});
