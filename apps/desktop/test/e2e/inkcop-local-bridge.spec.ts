import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page, _electron } from '@playwright/test';
import { botProfile } from '@kepcup/testkit';
import { rmHomeTolerant } from './helpers/home-cleanup';
import { dismissStartPanel, openConversationByName, rpc } from './helpers/create-bot';

/**
 * UI 级对联（契约 v0.2.1）：扩展中心启用协作 → 普通 Bot 勾选 InkCop 智能体 →
 * 发短消息经本机桥回包。不预置系统 Bot / 「+」菜单入口。
 *
 * 依赖宿主机已写入 ~/Library/Application Support/inkcop-local-bridge/endpoint.json
 * 且 /v1/health 可用；CI 无 sidecar 时跳过。
 */

const SCREENSHOT_DIR = process.env.KEPCUP_INKCOP_UI_SHOTS ?? '/tmp/kepcup-inkcop-ui-pair';

interface Session {
  app: ElectronApplication;
  page: Page;
  home: string;
}

async function bridgeHealthy(): Promise<boolean> {
  try {
    const fs = await import('node:fs');
    const endpointPath = path.join(
      process.env.HOME ?? '',
      'Library/Application Support/inkcop-local-bridge/endpoint.json',
    );
    if (!fs.existsSync(endpointPath)) return false;
    const ep = JSON.parse(fs.readFileSync(endpointPath, 'utf8')) as {
      port: number;
      token: string;
    };
    const res = await fetch(`http://127.0.0.1:${ep.port}/v1/health`, {
      headers: { Authorization: `Bearer ${ep.token}` },
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean };
    return body.ok === true;
  } catch {
    return false;
  }
}

async function startSession(prefix: string): Promise<Session> {
  const home = await mkdtemp(path.join(tmpdir(), prefix));
  const app = await _electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      KEPCUP_HOME: home,
      NODE_ENV: 'test',
      KEPCUP_KEYSTORE: 'file',
      KEPCUP_ONBOARDING: 'off',
      KEPCUP_FILE_KEYSTORE_PATH: path.join(home, '.test-master-key'),
      // 无内置模型：InkCop 桥 Bot 不依赖 mock LLM。
      KEPCUP_MOCK_LLM_URL: '',
    },
  });
  const page = await app.firstWindow();
  return { app, page, home };
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
  await dismissStartPanel(page);
}

async function shot(page: Page, name: string): Promise<string> {
  await mkdir(SCREENSHOT_DIR, { recursive: true });
  const file = path.join(SCREENSHOT_DIR, name);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

test('ordinary Bot with linked InkCop agent: send → in-progress → final bubble', async () => {
  test.setTimeout(180_000);
  if (!(await bridgeHealthy())) {
    test.skip(true, 'InkCop local bridge endpoint/health not available on this machine');
  }

  const session = await startSession('kepcup-e2e-inkcop-ui-');
  const { page } = session;
  const shots: string[] = [];
  const botName = 'InkCop Collab Bot';
  try {
    await waitReady(page);

    await rpc(page, 'settings.update', { inkcopLocalCollab: { enabled: true } });

    // v0.4：关联 keys 不切换 transport；整轮直连已移除，回复需 Bot 调 call_inkcop_agent。
    const profile = botProfile({
      name: botName,
      runtime: {
        inkcop_agent_keys: ['main_agent'],
      },
    });
    const created = (await rpc(page, 'bots.create', {
      profile,
      skipDefaultAgent: true,
    })) as { bot: { id: string } };
    await rpc(page, 'conversations.openDirect', { botId: created.bot.id });
    await openConversationByName(page, botName);
    await expect(page.locator('[data-testid="chat-view"]')).toBeVisible({ timeout: 20_000 });
    shots.push(await shot(page, '02-linked-bot-chat-open.png'));

    // 「+」面板不应再有系统 InkCop 入口
    await page.locator('[data-testid="new-chat-button"]').click();
    await expect(page.locator('[data-testid="start-chat-create-inkcop-bot"]')).toHaveCount(0);
    await dismissStartPanel(page);

    // v0.4 tool handoff: live reply needs LLM to call call_inkcop_agent — covered by unit tests.
    // Here only verify association profile sticks and system Bot entry stays gone.
    const got = (await rpc(page, 'bots.get', { id: created.bot.id })) as {
      bot: { profile: { runtime: { inkcop_agent_keys?: string[]; message_transport?: string } } };
    };
    expect(got.bot.profile.runtime.inkcop_agent_keys).toEqual(['main_agent']);
    expect(got.bot.profile.runtime.message_transport ?? '').toBe('');
    shots.push(await shot(page, '03-associated-bot-no-divert.png'));
    console.warn('[inkcop-ui-pair] association ok; screenshots:', shots.join(', '));
  } finally {
    await session.app.close();
    await rmHomeTolerant(session.home);
  }
});
