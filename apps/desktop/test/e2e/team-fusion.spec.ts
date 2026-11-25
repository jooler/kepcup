import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { request } from '@playwright/test';
import { expect, test, type ElectronApplication, type Page, _electron } from '@playwright/test';
import { openTeamSocket } from '../../src/main/team-bridge';
import { rmHomeTolerant } from './helpers/home-cleanup';

/**
 * T7 桌面融合视图 e2e（62.08 §3 / 62.01 S03 / S04）。
 *
 * 【可选 e2e】设置 `KEPCUP_TEAM_E2E=1` 才运行（其余环境跳过，避免误伤常规
 * e2e）。前置：已构建团队服务器（私有仓 server 包的 cli 产物）与桌面 `out/`；
 * 可用 `KEPCUP_TEAM_SERVER_ROOT` / `KEPCUP_TEAM_E2E_PORT` 覆盖服务端路径与端口。
 *
 * 覆盖：未配置退化、分步连接（探测失败弹框不登记 → 通过才登录）、登录后左栏
 * 团队分组 / 名册行、名册行开直聊、断线占位、登出与移除（S03 / S04）。
 */

const RUN_TEAM_E2E = process.env.KEPCUP_TEAM_E2E === '1';
const TEAM_SERVER_ROOT =
  process.env.KEPCUP_TEAM_SERVER_ROOT ?? path.resolve('..', 'team-server', 'server');
const TEAM_PORT = Number(process.env.KEPCUP_TEAM_E2E_PORT ?? 18643);

test.skip(!RUN_TEAM_E2E, '设置 KEPCUP_TEAM_E2E=1 才运行团队融合 e2e');

interface TeamServer {
  url: string;
  process: ChildProcess;
  username: string;
  password: string;
}

async function startTeamServer(): Promise<TeamServer> {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'kepcup-team-e2e-'));
  const bin = path.join(TEAM_SERVER_ROOT, 'dist', 'cli.js');
  const child = spawn(process.execPath, [bin, 'run'], {
    env: {
      ...process.env,
      // 团队服务器读 KEPCUP_TEAM_DATA_DIR（apps/team-server/server/src/config.ts 的
      // --data-dir env 映射；默认 ~/.kepcup-team）：显式指到临时目录，绝不碰
      // 真实数据目录。没有 KEPCUP_TEAM_ADMIN_TOKEN 这类 env——管理员凭据见下。
      KEPCUP_TEAM_DATA_DIR: dataDir,
      KEPCUP_TEAM_PORT: String(TEAM_PORT),
    },
    stdio: 'ignore',
  });
  const url = `http://127.0.0.1:${TEAM_PORT}`;
  // 等服务器就绪（whoami 返回 401 即代表已监听）。
  const ctx = await request.newContext();
  for (let i = 0; i < 60; i += 1) {
    const response = await ctx.get(`${url}/api/auth/whoami`).catch(() => null);
    if (response !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await ctx.dispose();
  // 管理员建成员（用户名 + 初始密码）走环回 admin API（62.03 §6，D102 模式，
  // /api/admin/*）：Bearer token 是服务器首启写进数据目录的 admin-token 文件
  //（随机 32B、0600；apps/team-server/server/src/config.ts ADMIN_TOKEN_FILE），本机
  // 发起才被接受。console 面（/api/console/*）要管理员 cookie 会话，脚本化
  // 建成员不用它。
  const adminToken = readFileSync(path.join(dataDir, 'admin-token'), 'utf8').trim();
  const admin = await request.newContext({
    extraHTTPHeaders: { authorization: `Bearer ${adminToken}` },
  });
  const username = 'e2e_member';
  const password = 'e2e-password-123';
  // 建成员失败让 beforeAll 直接失败（否则用例集体扑在登录上更难定位）。
  const created = await admin.post(`${url}/api/admin/members`, {
    data: { username, displayName: '融合成员', password },
  });
  if (!created.ok()) {
    throw new Error(`admin create member failed: ${created.status()} ${await created.text()}`);
  }
  // 服务端 Bot 缺省 restricted + 空白名单（成员看不到任何 Bot）。e2e 要把
  // 「登录后左栏 / 通讯录出现团队 Bot」作为可判定断言，这里把既有 Bot 全部
  // 设为全员可见（仅测试数据目录，不触碰真实服务器）。
  const botsResponse = await admin.get(`${url}/api/admin/bots`);
  if (!botsResponse.ok()) {
    throw new Error(`admin list bots failed: ${botsResponse.status()} ${await botsResponse.text()}`);
  }
  const { bots } = (await botsResponse.json()) as { bots: Array<{ id: string }> };
  for (const bot of bots) {
    const setVisibility = await admin.put(`${url}/api/admin/bots/${bot.id}/visibility`, {
      data: { mode: 'all' },
    });
    if (!setVisibility.ok()) {
      throw new Error(
        `admin bot visibility failed: ${setVisibility.status()} ${await setVisibility.text()}`,
      );
    }
  }
  await admin.dispose();
  await seedMemberBot(url, username, password);
  return { url, process: child, username, password };
}

/**
 * 给 e2e 成员建一个私有 Bot（不入访谈、不建直聊）：左栏名册行 / 通讯录团队
 * Bot 卡需要至少一个真实可见 Bot；新建团队服务器没有内置 Bot。
 */
async function seedMemberBot(url: string, username: string, password: string): Promise<void> {
  const login = await fetch(`${url}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!login.ok) {
    throw new Error(`member login for seeding failed: ${login.status} ${await login.text()}`);
  }
  const { token } = (await login.json()) as { token: string };
  const socket = await openTeamSocket(`${url}/rpc`, { authorization: `Bearer ${token}` });
  await new Promise<void>((resolve, reject) => {
    const id = 'e2e-seed-bot';
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close(1000);
      if (error === undefined) resolve();
      else reject(error);
    };
    const timer = setTimeout(() => finish(new Error('team.bots.create timed out')), 10_000);
    socket.on({
      onText: (text) => {
        let frame: { t?: string; i?: string; e?: unknown };
        try {
          frame = JSON.parse(text) as typeof frame;
        } catch {
          return;
        }
        if (frame.t !== 's' || frame.i !== id) return;
        if (frame.e !== undefined) finish(new Error(JSON.stringify(frame.e)));
        else finish();
      },
      onClose: () => finish(new Error('team socket closed before bot creation')),
    });
    socket.send(
      JSON.stringify({
        t: 'q',
        i: id,
        m: 'team.bots.create',
        a: [{ mode: 'private', name: 'E2E 队友', interview: false }],
      }),
    );
  });
}

interface LaunchedApp {
  app: ElectronApplication;
  page: Page;
  home: string;
}

/** 打开设置页（用户菜单 → 设置；已在设置页时直接返回）。 */
async function openSettings(page: Page): Promise<void> {
  if (await page.getByTestId('settings-nav').isVisible().catch(() => false)) return;
  await page.getByTestId('user-menu-trigger').click();
  await page.getByTestId('menu-settings').click();
}

/** 首次团队连接会自动弹「画像上行」确认清单；e2e 直接取消，避免挡住后续断言。 */
async function dismissProfilePush(page: Page): Promise<void> {
  const cancel = page.getByTestId('profile-push-cancel');
  await cancel.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
  if (await cancel.isVisible().catch(() => false)) await cancel.click();
}

/**
 * 保证设置页「团队服务器」至少有一条配置（用例独立）：没有时走一遍
 * 地址 → 健康检查 → 登录。已有配置直接返回（设置页保持打开）。
 */
async function ensureTeamConfigured(
  page: Page,
  team: { url: string; username: string; password: string },
): Promise<void> {
  await openSettings(page);
  await page.getByTestId('settings-nav-team-server').click();
  const item = page.locator('[data-testid^="team-server-item-"]').first();
  if ((await item.count()) > 0) return;
  await page.getByTestId('team-server-address').fill(team.url);
  await page.getByTestId('team-server-connect').click();
  await expect(page.getByTestId('team-server-login-step')).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('team-login-username').fill(team.username);
  await page.getByTestId('team-login-password').fill(team.password);
  await page.getByTestId('team-login-submit').click();
  await dismissProfilePush(page);
  await openSettings(page);
  await page.getByTestId('settings-nav-team-server').click();
}

async function launchApp(): Promise<LaunchedApp> {
  const home = mkdtempSync(path.join(tmpdir(), 'kepcup-fusion-e2e-'));
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
    },
  });
  const page = await app.firstWindow();
  // 空环境（无 Bot / 会话）启动后「开始对话」面板会自动展开，其全屏 backdrop
  // 挡住侧栏与设置入口；先点掉，后续用例从干净的对话列表开始。
  await page
    .getByTestId('start-chat-backdrop')
    .click({ timeout: 5_000 })
    .catch(() => undefined);
  return { app, page, home };
}

test.describe('桌面融合视图（S03 连接 / S04 名册）', () => {
  let team: TeamServer;
  let launched: LaunchedApp;

  test.beforeAll(async () => {
    team = await startTeamServer();
    launched = await launchApp();
  });

  test.afterAll(async () => {
    await launched.app.close().catch(() => undefined);
    team.process.kill();
    await rmHomeTolerant(launched.home);
  });

  test('未配置时与现状一致：没有团队分组', async () => {
    const { page } = launched;
    await openSettings(page);
    await page.getByTestId('settings-nav-team-server').click();
    await expect(page.getByTestId('team-server-connect-card')).toBeVisible();
    await page.getByTestId('settings-nav-back').click();
    await expect(page.locator('[data-testid^="team-server-group-"]')).toHaveCount(0);
  });

  test('分步连接：失败弹框不登记 → 健康检查通过才出现登录 → 登录后融合', async () => {
    const { page } = launched;
    await openSettings(page);
    await page.getByTestId('settings-nav-team-server').click();

    // 不可达地址：弹框说明原因，且不登记（列表仍为空）。
    await page.getByTestId('team-server-address').fill('http://127.0.0.1:1');
    await page.getByTestId('team-server-connect').click();
    await expect(page.getByTestId('team-server-probe-dialog')).toBeVisible();
    await page.getByTestId('team-server-probe-dialog-ok').click();
    await expect(page.getByTestId('team-server-empty')).toBeVisible();

    // 健康检查通过：登录表单自动出现在地址下方（不再需要点列表里的「登录」）。
    await page.getByTestId('team-server-address').fill(team.url);
    await page.getByTestId('team-server-connect').click();
    await expect(page.getByTestId('team-server-login-step')).toBeVisible();
    await page.getByTestId('team-login-username').fill(team.username);
    await page.getByTestId('team-login-password').fill(team.password);
    await page.getByTestId('team-login-submit').click();
    // 首次连接会弹画像上行确认清单（T7）：先取消，避免它挡住后续操作。
    await dismissProfilePush(page);

    // 新服务器首次登录 → 自动回到对话列表，左栏团队分组出现。
    await expect(page.locator('[data-testid^="team-server-group-"]').first()).toBeVisible({
      timeout: 30_000,
    });

    // 回到设置核对主进程连接状态（融合开关默认开）。
    await openSettings(page);
    await page.getByTestId('settings-nav-team-server').click();
    const item = page.locator('[data-testid^="team-server-item-"]').first();
    await expect(item).toHaveAttribute('data-status', 'connected', { timeout: 30_000 });
    await page.getByTestId('settings-nav-back').click();
  });

  test('登录后左栏出现服务端内容：团队徽标 + 可点击名册行', async () => {
    const { page } = launched;
    // 团队分组出现（服务器名或地址为组头）。
    await expect(page.locator('[data-testid^="team-server-group-"]').first()).toBeVisible({
      timeout: 30_000,
    });
    // 可见服务端 Bot / 好友 / 项目组以名册行补足（尚无会话时），带团队徽标。
    await expect(page.locator('[data-testid^="team-roster-bot-"]').first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.locator('[data-testid="team-badge"]').first()).toBeVisible();
  });

  test('名册行点开 → 建会话并转为普通团队会话行', async () => {
    const { page } = launched;
    await page.locator('[data-testid^="team-roster-bot-"]').first().click();
    // 团队直聊在主区打开（团队会话头不是本机 conversation-avatar）。
    await expect(page.locator('main').getByText('E2E 队友').first()).toBeVisible({
      timeout: 20_000,
    });
    const teamRow = page.locator('[data-testid^="conversation-row-"]').filter({
      has: page.locator('[data-testid="team-badge"]'),
    });
    await expect(teamRow.first()).toBeVisible({ timeout: 20_000 });
  });

  test('断线占位：断开团队连接后显示「未连接」，不伪造数据', async () => {
    const { page } = launched;
    await ensureTeamConfigured(page, team);
    const item = page.locator('[data-testid^="team-server-item-"]').first();
    const fusionToggle = page.locator('[data-testid^="team-server-fusion-"]').first();
    await fusionToggle.uncheck();
    await expect(item).toHaveAttribute('data-status', /idle|error/, {
      timeout: 20_000,
    });
    // 重新打开融合恢复。
    await fusionToggle.check();
    await expect(item).toHaveAttribute('data-status', 'connected', { timeout: 30_000 });
  });

  test('登出与移除：账号选择器 / 登出 / 移除确认', async () => {
    const { page } = launched;
    await ensureTeamConfigured(page, team);
    const logout = page.locator('[data-testid^="team-server-logout-"]').first();
    await logout.click();
    await expect(page.getByTestId('team-server-show-login')).toBeVisible({ timeout: 20_000 });
    const remove = page.locator('[data-testid^="team-server-remove-"]').first();
    await remove.click();
    await page.getByTestId('team-server-remove-confirm-ok').click();
    await expect(page.getByTestId('team-server-empty')).toBeVisible({ timeout: 20_000 });
  });
});
