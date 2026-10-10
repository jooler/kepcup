import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  expect,
  test,
  type ElectronApplication,
  type Frame,
  type Page,
  _electron,
} from '@playwright/test';
import {
  startFakeMcpAppServer,
  startMockLlm,
  step,
  viaTask,
  type FakeMcpAppServer,
  type MockLlmServer,
} from '@kepcup/testkit';

/**
 * D73 P3 §7.5 MCP Apps rendering in the real Electron app (security gate): a tool result with
 * `_meta.ui.resourceUri` becomes a card whose page is served over the privileged `kepcup-app://`
 * scheme into a `sandbox="allow-scripts"` iframe. The page (a fixture view driven through
 * `frame.evaluate`) must not reach `window.kepcup` / the parent / cookies / storage, its network is
 * limited to the CSP allowlist (the loopback server outside it sees ZERO hits), popups and
 * navigation are blocked, and UI-initiated tool calls go through the normal approval cards with the
 * default-deny visibility rule.
 */

interface Counter {
  server: Server;
  url: string;
  hits: () => number;
}

async function counterServer(): Promise<Counter> {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits += 1;
    res.writeHead(200, { 'access-control-allow-origin': '*', 'content-type': 'text/plain' });
    res.end('loopback-secret');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, url: `http://127.0.0.1:${port}`, hits: () => hits };
}

interface Session {
  app: ElectronApplication;
  page: Page;
  home: string;
  llm: MockLlmServer;
  fake: FakeMcpAppServer;
  blocked: Counter;
}

async function startSession(): Promise<Session> {
  const llm = await startMockLlm();
  const blocked = await counterServer();
  const fake = await startFakeMcpAppServer({
    // Loopback sources are accepted only for the owning (local dev) server's exact origin.
    connectDomains: ['{self}'],
    probe: { blockedUrl: blocked.url, allowedUrl: '{self}/ok' },
  });
  const home = await mkdtemp(path.join(tmpdir(), 'kepcup-e2e-mcpapp-'));
  const app = await _electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      KEPCUP_HOME: home,
      NODE_ENV: 'test',
      KEPCUP_KEYSTORE: 'file',
      KEPCUP_ONBOARDING: 'off',
      KEPCUP_FILE_KEYSTORE_PATH: path.join(home, '.test-master-key'),
      KEPCUP_MOCK_LLM_URL: llm.url,
    },
  });
  const page = await app.firstWindow();
  return { app, page, home, llm, fake, blocked };
}

async function closeSession(session: Session): Promise<void> {
  await session.app.close();
  await session.llm.stop();
  await session.fake.stop();
  await new Promise<void>((resolve) => session.blocked.server.close(() => resolve()));
  await rm(session.home, { recursive: true, force: true });
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
  const backdrop = page.locator('[data-testid="start-chat-backdrop"]');
  if (await backdrop.isVisible()) await backdrop.click({ timeout: 2_000 }).catch(() => {});
}

async function createBotAndOpenChat(page: Page, name: string): Promise<void> {
  await page.locator('[data-testid="new-chat-button"]').click();
  await page.locator('[data-testid="bot-create-form"]').click();
  await expect(page.locator('[data-testid="bot-create-dialog"]')).toBeVisible();
  await page.locator('[data-testid="bot-create-dialog"] [data-testid="bot-name-input"]').fill(name);
  await page.locator('[data-testid="bot-create-save"]').click();
  await expect(page.locator('[data-testid="chat-view"]')).toBeVisible({ timeout: 15_000 });
  const backdrop = page.locator('[data-testid="start-chat-backdrop"]');
  if (await backdrop.isVisible()) await backdrop.click();
  await expect(backdrop).toHaveCount(0);
}

type Rpc = (method: string, input?: unknown) => Promise<unknown>;
declare global {
  interface Window {
    __kepcupRpc: Rpc;
  }
}

/** Registers the fake server and gives the (only) bot access to it, through the page's core RPC. */
async function attachFakeServer(page: Page, fake: FakeMcpAppServer): Promise<void> {
  await page.evaluate(async (url) => {
    await window.__kepcupRpc('settings.update', {
      mcpServers: [
        {
          id: 'app1',
          name: '假界面应用',
          transport: 'http',
          url,
          enabled: true,
          autoApprove: false,
          auth: 'none',
        },
      ],
    });
    // Real apps lock first-seen tools until reviewed: approve what the test just saw.
    const server = {
      id: 'app1',
      name: '假界面应用',
      transport: 'http',
      url,
      enabled: true,
      autoApprove: false,
      auth: 'none',
    };
    const tested = (await window.__kepcupRpc('mcp.test', { server })) as {
      toolHashes?: Record<string, string>;
    };
    await window.__kepcupRpc('apps.tools.approveAfterTest', {
      serverId: 'app1',
      toolHashes: tested.toolHashes ?? {},
    });
    const { bots } = (await window.__kepcupRpc('bots.list')) as {
      bots: Array<{ id: string; profile: { runtime: Record<string, unknown> } }>;
    };
    const bot = bots[0]!;
    await window.__kepcupRpc('bots.update', {
      id: bot.id,
      profile: {
        ...bot.profile,
        runtime: { ...bot.profile.runtime, mcp_server_ids: ['app1'] },
      },
    });
  }, fake.mcpUrl);
}

function appFrame(page: Page): Frame | undefined {
  return page.frames().find((frame) => frame.url().startsWith('kepcup-app://'));
}

interface Fixture {
  state: {
    initialized: boolean;
    toolInput: unknown;
    toolResult: { content: Array<{ text: string }> } | null;
    hostContext: Record<string, unknown> | null;
  };
  probes(): Promise<Record<string, unknown>>;
  request(method: string, params: unknown): Promise<unknown>;
  size(height: number): void;
  navigateSelf(url: string): string;
  hijack(): string;
  hijackSeen(): number;
}
declare global {
  interface Window {
    __fixture: Fixture;
  }
}

async function openCard(session: Session): Promise<Frame> {
  const { page, llm } = session;
  llm.script(
    'mock-main',
    viaTask({
      writes: false,
      taskSteps: [
        step().replyToolCall('mcp_app1_show_dashboard', { topic: '销量' }),
        step().replyText('看板已显示'),
      ],
      relay: '看板好了',
    }),
  );
  const composer = page.locator('[data-testid="composer-input"]');
  await composer.fill('显示看板');
  await composer.press('ControlOrMeta+Enter');
  page.on('pageerror', (error) => console.error(`[pageerror] ${error.message}`));
  try {
    await expect(page.locator('[data-testid="mcp-app-card"]')).toHaveAttribute(
      'data-state',
      'ready',
      { timeout: 90_000 },
    );
  } catch (error) {
    const dump = await page
      .evaluate(async () => {
        const convs = (await window.__kepcupRpc('conversations.list')) as {
          conversations: Array<{ id: string }>;
        };
        const id = convs.conversations[0]?.id ?? '';
        const { messages } = (await window.__kepcupRpc('messages.list', {
          conversationId: id,
        })) as { messages: Array<{ kind: string; content: { cardType?: string } }> };
        const { runs } = (await window.__kepcupRpc('runs.list', { conversationId: id })) as {
          runs: Array<{ id: string; loopType: string; status: string }>;
        };
        const steps: unknown[] = [];
        for (const run of runs.filter((r) => r.loopType === 'task')) {
          const out = (await window.__kepcupRpc('runs.steps', { runId: run.id })) as {
            steps: Array<{ type: string; payload: Record<string, unknown> }>;
          };
          steps.push(
            ...out.steps
              .filter((step) => step.type === 'tool_result' || step.type === 'tool_call')
              .map((step) => JSON.stringify(step.payload).slice(0, 400)),
          );
        }
        return JSON.stringify({
          cards: messages.map((m) => `${m.kind}:${m.content.cardType ?? ''}`),
          runs: runs.map((r) => `${r.loopType}:${r.status}`),
          steps,
        });
      })
      .catch((dumpError: unknown) => String(dumpError));
    console.error(`[debug] card never became ready: ${dump}`);
    console.error(
      `[debug] card html: ${await page.locator('[data-testid="chat-view"]').innerText()}`,
    );
    throw error;
  }
  await expect.poll(() => appFrame(page) !== undefined, { timeout: 30_000 }).toBe(true);
  const frame = appFrame(page)!;
  await expect
    .poll(() => frame.evaluate(() => window.__fixture?.state.initialized === true), {
      timeout: 30_000,
    })
    .toBe(true);
  return frame;
}

test('MCP App card: sandboxed iframe, CSP-limited network, bridge, approvals, links', async () => {
  test.setTimeout(300_000);
  const session = await startSession();
  const { app, page, fake, blocked } = session;
  try {
    await waitReady(page);
    await createBotAndOpenChat(page, '小界面');
    await attachFakeServer(page, fake);
    const frame = await openCard(session);

    // --- the card and the iframe element --------------------------------------------------
    const iframe = page.locator('[data-testid="mcp-app-frame"]');
    await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts');
    await expect(iframe).toHaveAttribute('allow', '');
    await expect(iframe).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(await iframe.getAttribute('src')).toMatch(
      /^kepcup-app:\/\/app-[0-9a-f]{24}\/[A-Za-z0-9_-]{20,}$/,
    );
    await expect(page.locator('[data-testid="mcp-app-title"]')).toHaveText('Show dashboard');
    await expect(page.locator('[data-testid="mcp-app-network"]')).toContainText(fake.url);

    // --- bridge handshake: host context, tool input and result reach the view --------------
    await expect
      .poll(
        () => frame.evaluate(() => window.__fixture.state.toolResult?.content[0]?.text ?? null),
        {
          timeout: 30_000,
        },
      )
      .toBe('dashboard-data');
    expect(await frame.evaluate(() => window.__fixture.state.toolInput)).toEqual({
      arguments: { topic: '销量' },
    });
    expect(await frame.evaluate(() => window.__fixture.state.hostContext)).toMatchObject({
      displayMode: 'inline',
      platform: 'desktop',
    });

    // --- isolation + network probes inside the iframe --------------------------------------
    const probes = await frame.evaluate(() => window.__fixture.probes());
    expect(probes['windowOrigin']).toBe('null');
    expect(probes['windowKepcup']).toBe('undefined');
    expect(probes['windowRequire']).toBe('undefined/undefined');
    for (const key of [
      'parentDocument',
      'parentKepcup',
      'topLocation',
      'cookie',
      'localStorage',
      'indexedDB',
    ]) {
      expect(String(probes[key]), key).toMatch(/^ERR (SecurityError|DOMException)/);
    }
    expect(probes['windowOpen']).toBe('null');
    expect(String(probes['topNavigate'])).toMatch(/^ERR SecurityError/);
    // Network: everything outside the CSP is blocked; the allowlisted loopback server answers.
    for (const key of ['fetchExternal', 'fetchBlocked', 'fetchOtherApp', 'fetchFile']) {
      expect(String(probes[key]), key).toMatch(/^ERR TypeError/);
    }
    expect(probes['imgBlocked']).toBe('error');
    expect(probes['websocketBlocked']).toBe('error');
    expect(String(probes['fetchAllowed'])).toMatch(/^200/);
    expect(blocked.hits()).toBe(0);
    expect(fake.okHits).toBeGreaterThanOrEqual(1);
    const violations = (probes['violations'] as string[]).join('\n');
    expect(violations).toContain('connect-src');
    expect(violations).toContain('img-src');
    // Each blocked attempt is a CSP violation of its own — not just "some TypeError".
    expect(violations).toContain('connect-src https://example.com/');
    expect(violations).toContain(`connect-src ${blocked.url}/secret`);
    expect(violations).toContain('connect-src kepcup-app');
    expect(violations).toContain('connect-src file');
    expect(violations).toContain(`img-src ${blocked.url}/img.png`);
    expect(violations).not.toContain(fake.url);
    // --- the page can not hijack the core RPC port (security review: window 'message' listener) ---
    await frame.evaluate(() => window.__fixture.hijack());
    await page.waitForTimeout(800);
    // The real core still answers on the real port (settings, bots), and the page's own port
    // never received a single call.
    const settings = (await page.evaluate(() => window.__kepcupRpc('settings.get'))) as {
      settings?: { mcpServers?: Array<{ id: string }> };
    };
    expect(JSON.stringify(settings)).toContain('app1');
    const botsAfter = (await page.evaluate(() => window.__kepcupRpc('bots.list'))) as {
      bots: unknown[];
    };
    expect(botsAfter.bots.length).toBeGreaterThanOrEqual(1);
    expect(await frame.evaluate(() => window.__fixture.hijackSeen())).toBe(0);
    // No browser permission is granted to the page.
    expect(String(probes['geolocation'])).toMatch(/^denied/);
    expect(String(probes['clipboard'])).toMatch(/^ERR/);

    // --- navigation: cross-app / external navigation of the frame is blocked, no popups ------
    expect(await app.windows()).toHaveLength(1);
    await frame.evaluate(() =>
      window.__fixture.navigateSelf(
        'kepcup-app://app-000000000000000000000000/AbCdEfGhIjKlMnOpQrStUv',
      ),
    );
    await page.waitForTimeout(1_000);
    expect(appFrame(page)?.url()).toBe(await iframe.getAttribute('src'));
    expect(await app.windows()).toHaveLength(1);

    // --- height: reported sizes are clamped to 100–800 px ------------------------------------
    await frame.evaluate(() => window.__fixture.size(10_000));
    await expect(iframe).toHaveCSS('height', '800px');
    await frame.evaluate(() => window.__fixture.size(5));
    await expect(iframe).toHaveCSS('height', '100px');
    await frame.evaluate(() => window.__fixture.size(333));
    await expect(iframe).toHaveCSS('height', '333px');

    // --- unsupported UI methods and unlisted methods are refused ------------------------------
    for (const method of [
      'ui/message',
      'ui/update-model-context',
      'resources/read',
      'sampling/createMessage',
    ]) {
      const answer = await frame.evaluate(
        (name) => window.__fixture.request(name, { role: 'user', content: [] }),
        method,
      );
      expect(String(answer), method).toMatch(/^ERR/);
    }

    // --- UI-initiated tools/call ---------------------------------------------------------------
    // A read-only app tool needs no card.
    const refreshed = (await frame.evaluate(() =>
      window.__fixture.request('tools/call', { name: 'refresh_data', arguments: {} }),
    )) as { content: Array<{ text: string }> };
    expect(refreshed.content[0]!.text).toMatch(/^refreshed:/);

    // Tools not declared for the app are refused without any card or server call.
    const before = fake.toolCalls.length;
    for (const name of ['internal_write', 'model_only', 'show_dashboard']) {
      const refused = (await frame.evaluate(
        (toolName) => window.__fixture.request('tools/call', { name: toolName, arguments: {} }),
        name,
      )) as { isError?: boolean; content?: Array<{ text: string }> };
      expect(refused.isError, name).toBe(true);
      expect(refused.content?.[0]?.text, name).toContain('不能调用');
    }
    expect(fake.toolCalls).toHaveLength(before);
    await expect(page.locator('[data-testid^="approval-card-"]')).toHaveCount(0);

    // (The bridge allows 5 tools/call per second per card: let the window pass between phases.)
    await page.waitForTimeout(1_100);
    // A write tool raises the normal approval card above the composer; approving runs it.
    const pendingWrite = frame.evaluate(() =>
      window.__fixture.request('tools/call', { name: 'save_note', arguments: { text: 'hi' } }),
    );
    const card = page.locator('[data-testid^="approval-card-"]');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toContainText('save_note');
    await card.press('Enter');
    expect(((await pendingWrite) as { content: Array<{ text: string }> }).content[0]!.text).toBe(
      'saved:hi',
    );

    await page.waitForTimeout(1_100);
    // Denying returns an error result and nothing reaches the server.
    const pendingDeny = frame.evaluate(() =>
      window.__fixture.request('tools/call', { name: 'save_note', arguments: { text: 'no' } }),
    );
    await expect(card).toBeVisible({ timeout: 30_000 });
    await card.press('Escape');
    expect(((await pendingDeny) as { isError?: boolean }).isError).toBe(true);
    expect(fake.toolCalls.filter((call) => call.name === 'save_note')).toHaveLength(1);

    // --- external links: confirmed in the card, https only, through shell.openExternal --------
    await app.evaluate(({ shell }) => {
      const opened: string[] = [];
      (globalThis as unknown as { __opened: string[] }).__opened = opened;
      (shell as unknown as { openExternal: (url: string) => Promise<void> }).openExternal = async (
        url,
      ) => {
        opened.push(url);
      };
    });
    const openedLinks = () =>
      app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened);
    // A non-https link is refused with no confirmation.
    const badLink = await frame.evaluate(() =>
      window.__fixture.request('ui/open-link', { url: 'http://example.com/' }),
    );
    expect(badLink).toMatchObject({ isError: true });
    await expect(page.locator('[data-testid="mcp-app-link-confirm"]')).toHaveCount(0);
    // Cancelling: the app is told it failed, nothing is opened.
    const cancelled = frame.evaluate(() =>
      window.__fixture.request('ui/open-link', { url: 'https://example.com/docs' }),
    );
    await expect(page.locator('[data-testid="mcp-app-link-url"]')).toContainText(
      'example.com/docs',
    );
    await expect(page.locator('[data-testid="mcp-app-link-host"]')).toContainText('example.com');
    await page.locator('[data-testid="mcp-app-link-cancel"]').click();
    expect(await cancelled).toMatchObject({ isError: true });
    expect(await openedLinks()).toEqual([]);
    // After a cancel the app may not ask again for 5 s: refused with no confirmation bar.
    const spam = await frame.evaluate(() =>
      window.__fixture.request('ui/open-link', { url: 'https://example.com/again' }),
    );
    expect(spam).toMatchObject({ isError: true });
    await expect(page.locator('[data-testid="mcp-app-link-confirm"]')).toHaveCount(0);
    await page.waitForTimeout(5_200);
    // Confirming opens it through the main process.
    const confirmed = frame.evaluate(() =>
      window.__fixture.request('ui/open-link', { url: 'https://example.com/docs' }),
    );
    await page.locator('[data-testid="mcp-app-link-open"]').click();
    expect(await confirmed).not.toHaveProperty('isError', true);
    expect(await openedLinks()).toEqual(['https://example.com/docs']);

    // --- nothing sensitive crossed the boundary ---------------------------------------------
    expect(fake.authorizationHeaders).toEqual([]);
    const html = await frame.content();
    expect(html.toLowerCase()).not.toContain('bearer');
    expect(html).not.toContain('HOST-SECRET');

    // --- navigating the frame away is blocked: nothing is requested, nothing is rendered --------
    const iframeSrc = await iframe.getAttribute('src');
    await frame.evaluate((url) => window.__fixture.navigateSelf(url), `${blocked.url}/navigated`);
    await page.waitForTimeout(1_500);
    expect(blocked.hits()).toBe(0);
    expect(await page.locator('[data-testid="mcp-app-card"]').innerText()).not.toContain(
      'loopback-secret',
    );
    expect(await iframe.getAttribute('src')).toBe(iframeSrc);
    for (const other of page.frames()) {
      expect(other.url()).not.toContain(blocked.url);
    }
    expect(await app.windows()).toHaveLength(1);
  } finally {
    await closeSession(session);
  }
});

test('a card whose page was evicted (> 64 registered resources) shows the expired state and reopens on reload', async () => {
  test.setTimeout(240_000);
  const session = await startSession();
  const { page } = session;
  try {
    await waitReady(page);
    await createBotAndOpenChat(page, '小界面三');
    await attachFakeServer(page, session.fake);
    const frame = await openCard(session);
    const messageId = await page.evaluate(async () => {
      const convs = (await window.__kepcupRpc('conversations.list')) as {
        conversations: Array<{ id: string }>;
      };
      const { messages } = (await window.__kepcupRpc('messages.list', {
        conversationId: convs.conversations[0]!.id,
      })) as { messages: Array<{ id: string; content: { cardType?: string } }> };
      return messages.find((m) => m.content.cardType === 'mcp_app')!.id;
    });
    // 64 more registrations evict the oldest — the mounted card's resource.
    await page.evaluate(async (id) => {
      for (let i = 0; i < 64; i += 1) await window.__kepcupRpc('apps.ui.open', { messageId: id });
    }, messageId);
    const answer = (await frame.evaluate(() =>
      window.__fixture.request('tools/call', { name: 'refresh_data', arguments: {} }),
    )) as { isError?: boolean };
    expect(answer.isError).toBe(true);
    await expect(page.locator('[data-testid="mcp-app-card"]')).toHaveAttribute(
      'data-state',
      'error',
    );
    await expect(page.locator('[data-testid="mcp-app-error"]')).toContainText('过期');
    // Reload registers the card again and the page comes back.
    await page.locator('[data-testid="mcp-app-reload"]').click();
    await expect(page.locator('[data-testid="mcp-app-card"]')).toHaveAttribute(
      'data-state',
      'ready',
      {
        timeout: 30_000,
      },
    );
    await expect
      .poll(
        () => appFrame(page)?.evaluate(() => window.__fixture?.state.initialized === true) ?? false,
        { timeout: 30_000 },
      )
      .toBe(true);
  } finally {
    await closeSession(session);
  }
});

test('an app whose server went away shows an expired state and can be reloaded', async () => {
  test.setTimeout(240_000);
  const session = await startSession();
  const { page } = session;
  try {
    await waitReady(page);
    await createBotAndOpenChat(page, '小界面二');
    await attachFakeServer(page, session.fake);
    await openCard(session);
    // Remove the server, then reload the card: the resource can no longer be registered.
    await page.evaluate(() => window.__kepcupRpc('settings.update', { mcpServers: [] }));
    await page.locator('[data-testid="mcp-app-reload"]').click();
    await expect(page.locator('[data-testid="mcp-app-error"]')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-testid="mcp-app-card"]')).toHaveAttribute(
      'data-state',
      'error',
    );
    expect(page.frames().some((frame) => frame.url().startsWith('kepcup-app://'))).toBe(false);
  } finally {
    await closeSession(session);
  }
});
