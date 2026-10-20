import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page, _electron } from '@playwright/test';
import { rmHomeTolerant } from './helpers/home-cleanup';
import { dismissStartPanel } from './helpers/create-bot';

/**
 * UI 级对联（契约 v0.1）：侧栏「新建 InkCop 写作助理」→ 发短消息 →
 * 本机 InkCop sidecar（需源码 InkCop + 开关）经 HTTP/SSE 回包。
 * P0 可无 chunk：run-status「处理中」直到 complete 落 bot-bubble。
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
      // 无内置模型：InkCop Bot 走 message_transport，不依赖 mock LLM。
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

test('sidebar InkCop writing bot: send → in-progress → final bubble via local bridge', async () => {
  test.setTimeout(180_000);
  if (!(await bridgeHealthy())) {
    test.skip(true, 'InkCop local bridge endpoint/health not available on this machine');
  }

  const session = await startSession('kepcup-e2e-inkcop-ui-');
  const { page } = session;
  const shots: string[] = [];
  try {
    await waitReady(page);

    // 「+」→ 新建 InkCop 写作助理
    await page.locator('[data-testid="new-chat-button"]').click();
    const createBtn = page.locator('[data-testid="start-chat-create-inkcop-bot"]');
    await expect(createBtn).toBeVisible({ timeout: 15_000 });
    shots.push(await shot(page, '01-start-panel-inkcop.png'));
    await createBtn.click();

    await expect(page.locator('[data-testid="chat-view"]')).toBeVisible({ timeout: 20_000 });
    await expect(
      page.locator(
        '[data-testid^="conversation-item-"][data-active="true"] [data-testid="conversation-name"]',
      ),
    ).toContainText('InkCop', { timeout: 15_000 });
    shots.push(await shot(page, '02-inkcop-chat-open.png'));

    const composer = page.locator('[data-testid="composer-input"]');
    await expect(composer).toBeVisible({ timeout: 15_000 });
    const prompt = '请用一句话介绍你自己（UI 对联自检）';
    await composer.fill(prompt);
    await composer.press('Enter');

    await expect(page.locator('[data-testid="user-bubble"]').first()).toContainText(prompt, {
      timeout: 15_000,
    });

    // P0：可能没有 chunk，状态行「InkCop 处理中…」直到 complete。
    const status = page.locator('[data-testid="run-status-text"]');
    const botBubble = page.locator('[data-testid="bot-bubble"]').first();
    await expect
      .poll(
        async () => {
          if (await botBubble.isVisible().catch(() => false)) return 'bubble';
          if (await status.isVisible().catch(() => false)) {
            const t = await status.innerText().catch(() => '');
            if (t.includes('InkCop') || t.includes('处理')) return 'status';
          }
          return 'wait';
        },
        { timeout: 30_000 },
      )
      .not.toBe('wait');

    shots.push(await shot(page, '03-in-progress-or-early-bubble.png'));

    await expect(botBubble).toBeVisible({ timeout: 120_000 });
    const reply = (await botBubble.innerText()).trim();
    expect(reply.length).toBeGreaterThan(0);
    // 不应停在离线提示 / 空答占位
    expect(reply).not.toMatch(/未返回内容|离线|无法连接|通讯失败|桥接异常/);
    shots.push(await shot(page, '04-final-bot-bubble.png'));

    // 留给调试：把回复写进环境日志
    console.log('[inkcop-ui-pair] bot reply:', reply.slice(0, 500));
    console.log('[inkcop-ui-pair] screenshots:', shots.join(', '));
  } finally {
    await session.app.close();
    await rmHomeTolerant(session.home);
  }
});
