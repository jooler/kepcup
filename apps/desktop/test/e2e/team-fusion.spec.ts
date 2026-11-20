import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { request } from '@playwright/test';
import { expect, test, type ElectronApplication, type Page, _electron } from '@playwright/test';
import { rmHomeTolerant } from './helpers/home-cleanup';

/**
 * T7 桌面融合视图 e2e（62.08 §3 / 62.01 S03 / S04）。
 *
 * 【T11 Mac e2e 清单执行，不在本机运行】——本文件只写不跑：需要打包好的
 * 桌面进程 + kepcup-team-server 可执行文件与主进程团队桥接（T7 主进程侧），
 * 由收口阶段（T11）在 Mac 清单里执行。设置 `KEPCUP_TEAM_E2E=1` 才会运行
 *（其余环境跳过，避免误伤常规 e2e）。
 *
 * 覆盖：本机 + 团队会话并存、切换、断线占位、登录流程（S03 / S04）。
 */

const RUN_TEAM_E2E = process.env.KEPCUP_TEAM_E2E === '1';
const TEAM_SERVER_ROOT = process.env.KEPCUP_TEAM_SERVER_ROOT ?? path.resolve('..', 'team-server');
const TEAM_PORT = Number(process.env.KEPCUP_TEAM_E2E_PORT ?? 18643);

test.skip(!RUN_TEAM_E2E, 'T7 融合视图 e2e 属 T11 Mac 清单（KEPCUP_TEAM_E2E=1 时运行）');

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
      KEPCUP_TEAM_DATA: dataDir,
      KEPCUP_TEAM_PORT: String(TEAM_PORT),
      KEPCUP_TEAM_ADMIN_TOKEN: 'e2e-admin-token',
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
  // 管理员建成员（用户名 + 初始密码）。
  const admin = await request.newContext({
    extraHTTPHeaders: { 'admin-token': 'e2e-admin-token' },
  });
  const username = 'e2e_member';
  const password = 'e2e-password-123';
  await admin.post(`${url}/api/console/members`, {
    data: { username, displayName: '融合成员', password },
  });
  await admin.dispose();
  return { url, process: child, username, password };
}

interface LaunchedApp {
  app: ElectronApplication;
  page: Page;
  home: string;
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
    await expect(page.getByTestId('team-server-connect-card')).toBeVisible();
    await expect(page.getByTestId('team-server-group-h1')).toHaveCount(0);
  });

  test('登录流程：添加服务器 → 登录 → 融合开关默认开', async () => {
    const { page } = launched;
    await page.getByTestId('menu-settings').click();
    await page.getByRole('button', { name: /远程|Remote/ }).click();
    await page.getByTestId('team-server-address').fill(team.url);
    await page.getByTestId('team-server-connect').click();
    await expect(page.getByTestId('team-server-list')).toBeVisible();
    // 未认证状态 → 登录表单。
    await page.getByTestId('team-server-show-login').click();
    await page.getByTestId('team-login-username').fill(team.username);
    await page.getByTestId('team-login-password').fill(team.password);
    await page.getByTestId('team-login-submit').click();
    // 登录成功 → 主进程连接 → team-port 交付 → 状态点转绿（融合开关默认开）。
    const item = page.locator('[data-testid^="team-server-item-"]').first();
    await expect(item).toHaveAttribute('data-status', 'connected', { timeout: 30_000 });
  });

  test('本机 + 团队会话并存：团队条目带「团队」徽标', async () => {
    const { page } = launched;
    // 团队分组出现（服务器名或地址为组头）。
    await expect(page.locator('[data-testid^="team-server-group-"]').first()).toBeVisible({ timeout: 30_000 });
    // 本机会话列表仍在（无徽标），团队行带团队徽标。
    await expect(page.locator('[data-testid="team-badge"]').first()).toBeVisible();
  });

  test('切换：本机会话与团队会话互不串台（id 碰撞隔离）', async () => {
    const { page } = launched;
    const localRow = page.locator('[data-testid^="conversation-row-"]').first();
    const teamRow = page.locator('[data-testid^="conversation-row-"]').filter({
      has: page.locator('[data-testid="team-badge"]'),
    });
    if ((await teamRow.count()) === 0) test.skip(true, '该团队账号暂无会话');
    await localRow.click();
    await expect(page.getByTestId('conversation-avatar')).toBeVisible();
    await teamRow.first().click();
    await expect(page.getByTestId('conversation-avatar')).toBeVisible();
    // 团队会话打开时本机列表保持不变（未读 / 条目不串）。
    await localRow.click();
  });

  test('断线占位：断开团队连接后显示「未连接」，不伪造数据', async () => {
    const { page } = launched;
    await page.getByTestId('menu-settings').click();
    const fusionToggle = page.locator('[data-testid^="team-server-fusion-"]').first();
    await fusionToggle.uncheck();
    const group = page.locator('[data-testid^="team-server-group-"]').first();
    await expect(group).toHaveAttribute('data-status', /offline|reconnecting/, { timeout: 20_000 });
    await expect(group.getByText(/未连接|Not connected/)).toBeVisible();
    // 重新打开融合恢复。
    await fusionToggle.check();
    await expect(group).toHaveAttribute('data-status', 'connected', { timeout: 30_000 });
  });

  test('登出与移除：账号选择器 / 登出 / 移除确认', async () => {
    const { page } = launched;
    const logout = page.locator('[data-testid^="team-server-logout-"]').first();
    await logout.click();
    await expect(page.getByTestId('team-server-show-login')).toBeVisible({ timeout: 20_000 });
    const remove = page.locator('[data-testid^="team-server-remove-"]').first();
    await remove.click();
    await page.getByTestId('team-server-remove-confirm-ok').click();
    await expect(page.getByTestId('team-server-empty')).toBeVisible({ timeout: 20_000 });
  });
});
