import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import {
  expect,
  test,
  type ElectronApplication,
  type Page,
  type TestInfo,
  _electron,
} from '@playwright/test';
import type { WebContentsView } from 'electron';
import {
  isTaskRequest,
  startMockLlm,
  startTestWebServer,
  step,
  viaTask,
  type MockChatRequest,
  type MockLlmServer,
  type MockLlmStep,
  type TestWebServer,
} from '@kepcup/testkit';

// P11 浏览器工具 e2e（docs/dev/phases/P11-browser.md 测试要求）：真实 Electron +
// 本地网页夹具（startTestWebServer），经 mock 模型的工具调用环驱动真实主进程
// 浏览器宿主（隐藏 WebContentsView + CDP + 网络拦截）。
// D75：浏览器只在任务里用（对话轮只读、不给浏览器工具）——每一步都是「对话轮
// start_task → 任务调用浏览器工具 → 任务结果唤醒对话轮转述」。

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
  web: TestWebServer;
}

async function startSession(prefix: string): Promise<Session> {
  const llm = await startMockLlm();
  const web = await startTestWebServer();
  const home = await mkdtemp(path.join(tmpdir(), prefix));
  const launched = await launchApp({ home, llmUrl: llm.url });
  return { ...launched, llm, web };
}

async function closeSession(session: Session): Promise<void> {
  await session.app.close();
  await session.llm.stop();
  await session.web.stop();
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

/** Switches to an existing conversation (direct chat title = bot name). */
async function openConversation(page: Page, title: string): Promise<void> {
  await page.locator('[data-testid^="conversation-item-"]', { hasText: title }).first().click();
  // 切换完成的判别信号：侧栏「激活项」的名字变为目标对话（SidebarMenuButton
  // 的 isActive 直落 data-active）。chat-view 常驻 visible 无区分度——负载下
  // 切换渲染未完成时，后续 composer 输入会落进上一个对话（回复落在后台对话，
  // 当前 DOM 永远等不到），本断言只能在 currentId 真正变化后通过。
  await expect(
    page.locator(
      '[data-testid^="conversation-item-"][data-active="true"] [data-testid="conversation-name"]',
      { hasText: title },
    ),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-testid="chat-view"]')).toBeVisible({ timeout: 15_000 });
}

/** Forces the native directory picker to return `dir` and binds it (P04 flow). */
async function bindProject(app: ElectronApplication, page: Page, dir: string): Promise<void> {
  await app.evaluate(({ dialog }, target) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
  }, dir);
  // 项目选择器在右栏：群对话是群信息面板（选择器直接可见），单聊在「配置」tab
  // （右栏收起时先展开）。
  const groupInfo = page.locator('[data-testid="group-info"]');
  const tabs = page.locator('[data-testid="right-panel-tabs"]');
  if (!(await groupInfo.isVisible()) && !(await tabs.isVisible())) {
    await page.locator('[data-testid="right-panel-toggle"]').click();
  }
  if (!(await groupInfo.isVisible())) {
    await tabs.locator('text=配置').click();
  }
  await page.locator('[data-testid="project-selector-trigger"]').click();
  await page.locator('[data-testid="project-pick-new"]').click();
  await expect(page.locator('[data-testid="project-selector-name"]')).toContainText(
    path.basename(dir),
    { timeout: 15_000 },
  );
  await expect(
    page.locator('[data-testid="system-message"]').filter({ hasText: '项目已绑定' }),
  ).toHaveCount(1, { timeout: 15_000 });
  // 绑定后选择弹框保持打开（方便继续权限设置）；后续对话流程前先 Esc 关闭。
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-testid="project-picker-dialog"]')).not.toBeVisible();
}

function makeProjectDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
  return dir;
}

/** Gate: the step only matches requests whose serialized body contains `sub`. */
function bodyContains(sub: string): (req: MockChatRequest) => boolean {
  return (req) => JSON.stringify(req.body).includes(sub);
}

/**
 * Scripts one run (reply ends the run), sends a message and waits for the
 * bot bubble — the marker proves the scripted step chain completed.
 */
async function runOnce(
  page: Page,
  llm: MockLlmServer,
  steps: MockLlmStep[],
  expectText: string,
): Promise<void> {
  llm.script('mock-main', steps);
  const composer = page.locator('[data-testid="composer-input"]');
  await composer.fill('继续');
  await composer.press('ControlOrMeta+Enter');
  await expect(
    page.locator('[data-testid="bot-bubble"]').filter({ hasText: expectText }),
  ).toBeVisible({ timeout: 90_000 });
}

/**
 * D75: the turn starts a (read-only by default) task; the task calls the tool
 * and its gated final text (the gate proves what the model saw) is the result
 * the waking turn relays as `reply`.
 */
function toolRun(
  toolName: string,
  args: unknown,
  gateSub: string,
  reply: string,
  options: { writes?: boolean } = {},
): MockLlmStep[] {
  return viaTask({
    title: `浏览：${reply}`,
    writes: options.writes ?? false,
    // The ack must not contain `reply`: runOnce waits for the relay bubble.
    ack: '好的，我去浏览器里看看',
    taskSteps: [
      step().replyToolCall(toolName, args),
      step().expect(bodyContains(gateSub)).replyText(`任务结果：${reply}`),
    ],
    relay: reply,
  });
}

/**
 * Content of the most recent tool-result message across all recorded
 * requests (background requests after the run have no tool messages, so the
 * search skips them).
 */
function lastToolContent(llm: MockLlmServer): string {
  const texts: string[] = [];
  // D75: browser tools run in tasks (the turns' tool messages are start_task's).
  for (const request of [...llm.requests()].reverse().filter(isTaskRequest)) {
    const messages = (request.body.messages ?? []) as Array<{ role: string; content?: unknown }>;
    for (const message of [...messages].reverse()) {
      if (message.role !== 'tool') continue;
      const content = message.content;
      if (typeof content === 'string') texts.push(content);
      else if (Array.isArray(content)) {
        texts.push(
          content
            .map((part) =>
              part && typeof part === 'object' && 'text' in part
                ? String((part as { text: unknown }).text)
                : '',
            )
            .join(''),
        );
      }
    }
    if (texts.length > 0) return texts[0]!;
  }
  return '';
}

async function createGroupViaUi(page: Page, title: string, memberNames: string[]): Promise<void> {
  await page.locator('[data-testid="new-chat-button"]').click();
  await page.locator('[data-testid="start-chat-create-group"]').click();
  // 对话内创建（19/D60）：名称 → 主要事务 → 成员 → 目录（跳过）。
  const card = (step: string) =>
    page.locator(`[data-testid="group-setup-card"][data-step="${step}"]`);
  await expect(card('title')).toBeVisible({ timeout: 15_000 });
  await card('title').locator('[data-testid="group-setup-input"]').fill(title);
  await card('title').locator('[data-testid="group-setup-submit"]').click();
  await expect(card('purpose')).toBeVisible({ timeout: 15_000 });
  await card('purpose').locator('[data-testid="group-setup-input"]').fill('协作处理日常事务');
  await card('purpose').locator('[data-testid="group-setup-submit"]').click();
  await expect(card('members')).toBeVisible({ timeout: 15_000 });
  for (const name of memberNames) {
    await card('members')
      .locator('label', { hasText: name })
      .locator('button[role="checkbox"]')
      .click();
  }
  await card('members').locator('[data-testid="group-setup-submit"]').click();
  await expect(card('project')).toBeVisible({ timeout: 15_000 });
  await card('project').locator('[data-testid="group-setup-skip"]').click();
  await expect(page.locator('[data-testid="conversation-name"]', { hasText: title })).toBeVisible({
    timeout: 15_000,
  });
}

async function mentionAndType(page: Page, botName: string, text: string): Promise<void> {
  const composer = page.locator('[data-testid="composer-input"]');
  await composer.click();
  await composer.pressSequentially(`@${botName}`);
  const candidate = page
    .locator('[data-testid="mention-popup"] button')
    .filter({ hasText: botName })
    .first();
  await expect(candidate).toBeVisible({ timeout: 5_000 });
  await candidate.click();
  await composer.pressSequentially(text);
}

// --- PNG decoding (技术点①: 截图非空白) ---------------------------------------

/**
 * Minimal PNG pixel reader: parses IHDR/IDAT, inflates and unfilters
 * scanlines, returns dimensions plus the number of distinct sampled RGB
 * colors (sampling every 97th pixel keeps it fast for 1280x800).
 */
function pngPixelStats(base64: string): {
  width: number;
  height: number;
  colors: number;
  nonWhite: number;
} {
  const buf = Buffer.from(base64, 'base64');
  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8]!;
      colorType = data[9]!;
    } else if (type === 'IDAT') {
      idat.push(data);
    }
    off += 12 + len;
    if (type === 'IEND') break;
  }
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (bitDepth !== 8 || bpp === 0) {
    throw new Error(`unsupported PNG shape (bitDepth=${bitDepth}, colorType=${colorType})`);
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  if (raw.length < height * (stride + 1)) throw new Error('PNG data truncated');
  const out = Buffer.alloc(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos++]!;
    const rowStart = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= bpp ? out[rowStart + x - bpp]! : 0;
      const b = y > 0 ? out[rowStart - stride + x]! : 0;
      const c = x >= bpp && y > 0 ? out[rowStart - stride + x - bpp]! : 0;
      let v = raw[pos + x]!;
      if (filter === 1) v = (v + a) & 0xff;
      else if (filter === 2) v = (v + b) & 0xff;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      }
      out[rowStart + x] = v;
    }
    pos += stride;
  }
  const colors = new Set<number>();
  let nonWhite = 0;
  for (let i = 0; i < out.length; i += bpp * 97) {
    const r = out[i]!;
    const g = out[i + 1]!;
    const b = out[i + 2]!;
    colors.add((r << 16) | (g << 8) | b);
    if (r < 250 || g < 250 || b < 250) nonWhite += 1;
  }
  return { width, height, colors: colors.size, nonWhite };
}

function extractPngBase64(serializedBody: string): string | null {
  const match = /data:image\/png;base64,([A-Za-z0-9+/=]+)/.exec(serializedBody);
  return match ? (match[1] ?? null) : null;
}

function dumpRequests(llm: MockLlmServer, testInfo: TestInfo): void {
  const dump = llm
    .requests()
    .map((r, i) => `===== request ${i} =====\n${JSON.stringify(r.body)}`)
    .join('\n');
  void testInfo.attach('mock-llm-requests', {
    body: dump.slice(0, 2_000_000),
    contentType: 'text/plain',
  });
}

// --- tests ---------------------------------------------------------------------

test('打开本地网页与快照、点击、输入并提交表单，页面内容带 untrusted 边界', async () => {
  const testInfo = test.info();
  test.setTimeout(240_000);
  const session = await startSession('kepcup-e2e-browser-');
  const { page, llm, web } = session;
  try {
    await waitReady(page);
    await createBotAndOpenChat(page, '小览');
    await bindProject(session.app, page, makeProjectDir('kepcup-e2e-browser-proj-'));

    // 打开 + 快照：标题/URL/元素引用/页面文本进入模型请求，整体有 <untrusted> 边界。
    await runOnce(
      page,
      llm,
      toolRun('browser_open', { url: `${web.url}/` }, 'fixture-home-marker', '首页打开了'),
      '首页打开了',
    );
    const opened = lastToolContent(llm);
    expect(opened).toContain('页面：P11 夹具首页');
    expect(opened).toContain(`URL：${web.url}/`);
    expect(opened).toContain('- [e1] link “打开表单”');
    expect(opened).toContain('<untrusted>');
    expect(opened.split('</untrusted>').length - 1).toBe(1); // exactly one real closer

    // 点击链接 → 表单页快照出现新的元素引用。
    await runOnce(
      page,
      llm,
      toolRun('browser_click', { ref: 'e1' }, 'fixture-form-marker', '表单页打开了'),
      '表单页打开了',
    );
    expect(lastToolContent(llm)).toContain('- [e1] textbox');

    // 输入文本并提交表单 → GET /submit 回显进入下一次模型请求。
    await runOnce(
      page,
      llm,
      toolRun('browser_type', { ref: 'e1', text: 'e2e-user' }, '已在 e1 输入文本', '输入完成'),
      '输入完成',
    );
    await runOnce(
      page,
      llm,
      toolRun('browser_press', { key: 'Enter' }, 'fixture-submitted-marker', '提交完成'),
      '提交完成',
    );
    const submitted = lastToolContent(llm);
    expect(submitted).toContain('SUBMITTED_QUERY=');
    expect(submitted).toContain('username=e2e-user');
  } catch (error) {
    dumpRequests(llm, testInfo);
    throw error;
  } finally {
    await closeSession(session);
  }
});

test('302 重定向后的 URL 只出现在 untrusted 边界内（BR-P11-001）', async () => {
  const testInfo = test.info();
  test.setTimeout(240_000);
  const session = await startSession('kepcup-e2e-browser-redir-');
  const { page, llm, web } = session;
  try {
    await waitReady(page);
    await createBotAndOpenChat(page, '小转');
    await bindProject(session.app, page, makeProjectDir('kepcup-e2e-browser-redir-proj-'));

    // /redirect 302 → /redirected：真实宿主报告的落点 URL 完全由目标页面控制。
    await runOnce(
      page,
      llm,
      toolRun(
        'browser_open',
        { url: `${web.url}/redirect` },
        'fixture-redirected-marker',
        '跳转到了',
      ),
      '跳转到了',
    );
    const opened = lastToolContent(llm);
    // 陈述口吻的前缀不再携带 URL（重定向落点不可预知）。
    expect(opened.startsWith('已打开网页')).toBe(true);
    expect(opened).not.toContain('已打开 http');
    // 302 真实被跟随：模型从 URL 行读到落点（只在 untrusted 边界内）。
    expect(opened).toContain(`URL：${web.url}/redirected?from=fixture-redirect`);
    const beforeBoundary = opened.split('<untrusted>')[0] ?? '';
    expect(beforeBoundary).not.toContain('/redirected');
    expect(opened).toContain('<untrusted>');
    expect(opened.split('</untrusted>').length - 1).toBe(1); // exactly one real closer
  } catch (error) {
    dumpRequests(llm, testInfo);
    throw error;
  } finally {
    await closeSession(session);
  }
});

test('window.open 的非 http(s) 目标不导航页面；http(s) 弹窗仍同页打开（BR-P11-002）', async () => {
  const testInfo = test.info();
  test.setTimeout(240_000);
  const session = await startSession('kepcup-e2e-browser-pop-');
  const { page, llm, web } = session;
  try {
    await waitReady(page);
    await createBotAndOpenChat(page, '小窗');
    await bindProject(session.app, page, makeProjectDir('kepcup-e2e-browser-pop-proj-'));

    await runOnce(
      page,
      llm,
      toolRun('browser_open', { url: `${web.url}/popup-trap` }, 'popup-trap-marker', '陷阱页开了'),
      '陷阱页开了',
    );
    // e1 = file:// 陷阱按钮：点击后页面必须仍停在陷阱页（file:// 不经 loadURL）。
    await runOnce(
      page,
      llm,
      toolRun('browser_click', { ref: 'e1' }, 'popup-trap-marker', '文件陷阱没跟过去'),
      '文件陷阱没跟过去',
    );
    expect(lastToolContent(llm)).toContain(`URL：${web.url}/popup-trap`);
    // e2 = javascript: 陷阱按钮：同样不导航。
    await runOnce(
      page,
      llm,
      toolRun('browser_click', { ref: 'e2' }, 'popup-trap-marker', '脚本陷阱没跟过去'),
      '脚本陷阱没跟过去',
    );
    expect(lastToolContent(llm)).toContain(`URL：${web.url}/popup-trap`);
    // 正向对照：http(s) 弹窗仍按「新窗口同页打开」导航到 /form。
    await runOnce(
      page,
      llm,
      toolRun('browser_click', { ref: 'e3' }, 'fixture-form-marker', '表单页同页打开了'),
      '表单页同页打开了',
    );
    expect(lastToolContent(llm)).toContain(`URL：${web.url}/form`);
  } catch (error) {
    dumpRequests(llm, testInfo);
    throw error;
  } finally {
    await closeSession(session);
  }
});

test('下载链接的文件落到 workspace/downloads', async () => {
  const testInfo = test.info();
  test.setTimeout(240_000);
  const session = await startSession('kepcup-e2e-browser-dl-');
  const { page, llm, web, home } = session;
  try {
    await waitReady(page);
    await createBotAndOpenChat(page, '小载');
    await bindProject(session.app, page, makeProjectDir('kepcup-e2e-browser-dl-proj-'));

    await runOnce(
      page,
      llm,
      toolRun('browser_open', { url: `${web.url}/` }, 'fixture-home-marker', '首页打开了'),
      '首页打开了',
    );
    // e2 = 下载报告（<a download href="/files/report.txt">）。
    await runOnce(
      page,
      llm,
      // A write task: its downloads land in the workspace (read-only executions
      // download into the app cache, D75 审查 M4).
      toolRun('browser_click', { ref: 'e2' }, '已点击 e2', '点击完成', { writes: true }),
      '点击完成',
    );

    const downloads = path.join(home, 'bots');
    let target: string | null = null;
    await expect
      .poll(
        () => {
          const files: string[] = [];
          const walk = (dir: string): void => {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
              const full = path.join(dir, entry.name);
              if (entry.isDirectory()) walk(full);
              else if (entry.name === 'report.txt') files.push(full);
            }
          };
          walk(downloads);
          target = files[0] ?? null;
          return target !== null;
        },
        { timeout: 30_000 },
      )
      .toBe(true);
    expect(target).toBeTruthy();
    expect(readFileSync(target!, 'utf8')).toContain('fixture download payload');
  } catch (error) {
    dumpRequests(llm, testInfo);
    throw error;
  } finally {
    await closeSession(session);
  }
});

test('不同 Bot 的 cookie 互不可见；同一 Bot 跨对话共享登录', async () => {
  const testInfo = test.info();
  test.setTimeout(300_000);
  const session = await startSession('kepcup-e2e-browser-cookie-');
  const { page, llm, web } = session;
  try {
    await waitReady(page);
    await createBotAndOpenChat(page, '阿甲');
    await createBotAndOpenChat(page, '阿乙');
    // 本机夹具页面只有绑定 project 的对话能打开：给每个用到的对话都绑定。
    const project = makeProjectDir('kepcup-e2e-browser-cookie-proj-');
    await bindProject(session.app, page, project); // 当前对话 = 阿乙

    // 阿甲设置 cookie（同一分区持续存在）。
    await openConversation(page, '阿甲');
    await bindProject(session.app, page, project);
    await runOnce(
      page,
      llm,
      toolRun('browser_open', { url: `${web.url}/cookie-set` }, 'cookie-set-page', '甲设置好了'),
      '甲设置好了',
    );
    // 阿甲读取 → 看得到。
    await runOnce(
      page,
      llm,
      toolRun('browser_open', { url: `${web.url}/cookie-read` }, 'fixture_sid=SID1234', '甲看到了'),
      '甲看到了',
    );
    // 阿乙读取（另一 Bot = 另一分区）→ 看不到。
    await openConversation(page, '阿乙');
    await runOnce(
      page,
      llm,
      toolRun('browser_open', { url: `${web.url}/cookie-read` }, 'COOKIE_JAR=[]', '乙看不到'),
      '乙看不到',
    );

    // 同一 Bot（阿甲）跨对话：群对话共享同一分区。
    await createGroupViaUi(page, '浏览组', ['阿甲', '阿乙']);
    await bindProject(session.app, page, project); // 群对话
    llm.script(
      'mock-main',
      toolRun(
        'browser_open',
        { url: `${web.url}/cookie-read` },
        'fixture_sid=SID1234',
        '群里也共享',
      ),
    );
    await mentionAndType(page, '阿甲', ' 再读一次');
    await page.locator('[data-testid="composer-input"]').press('Meta+Enter');
    await expect(
      page.locator('[data-testid="bot-bubble"]').filter({ hasText: '群里也共享' }),
    ).toBeVisible({ timeout: 90_000 });
  } catch (error) {
    dumpRequests(llm, testInfo);
    throw error;
  } finally {
    await closeSession(session);
  }
});

test('127.0.0.1 未绑定被拦截、绑定后放行；192.168 与 169.254 恒拦', async () => {
  const testInfo = test.info();
  test.setTimeout(300_000);
  const session = await startSession('kepcup-e2e-browser-net-');
  const { page, llm, web } = session;
  try {
    await waitReady(page);
    await createBotAndOpenChat(page, '小网');

    // 未绑定 project：loopback 被拦截，请求从未到达本地服务器。
    const before = web.requestsServed();
    await runOnce(
      page,
      llm,
      toolRun('browser_open', { url: `${web.url}/` }, '被网络规则拦截', '本机被拦了'),
      '本机被拦了',
    );
    expect(web.requestsServed()).toBe(before);

    // 绑定后：同一 URL 放行，服务器真实服务了页面。
    await bindProject(session.app, page, makeProjectDir('kepcup-e2e-browser-net-proj-'));
    await runOnce(
      page,
      llm,
      toolRun('browser_open', { url: `${web.url}/` }, 'fixture-home-marker', '本机放行了'),
      '本机放行了',
    );
    await expect.poll(() => web.requestsServed() > before).toBe(true);

    // 绑定了 project 也不放行：内网 IP 与云元数据地址恒拦。
    await runOnce(
      page,
      llm,
      toolRun('browser_open', { url: 'http://192.168.1.1/' }, '被网络规则拦截', '内网被拦'),
      '内网被拦',
    );
    await runOnce(
      page,
      llm,
      toolRun(
        'browser_open',
        { url: 'http://169.254.169.254/latest/meta-data/' },
        '被网络规则拦截',
        '元数据被拦',
      ),
      '元数据被拦',
    );
  } catch (error) {
    dumpRequests(llm, testInfo);
    throw error;
  } finally {
    await closeSession(session);
  }
});

test('删除 Bot 后其浏览器分区数据不存在', async () => {
  const testInfo = test.info();
  test.setTimeout(240_000);
  const session = await startSession('kepcup-e2e-browser-del-');
  const { page, llm, web, home, app } = session;
  try {
    await waitReady(page);
    await createBotAndOpenChat(page, '阿删');
    await bindProject(app, page, makeProjectDir('kepcup-e2e-browser-del-proj-'));

    // 触发真实分区写入（cookie）后强制落盘，确认目录先存在。
    await runOnce(
      page,
      llm,
      toolRun('browser_open', { url: `${web.url}/cookie-set` }, 'cookie-set-page', '设好了'),
      '设好了',
    );

    await page.locator('[data-testid="user-menu-trigger"]').click();
    await page.locator('[data-testid="menu-contacts"]').click();
    await expect(page.locator('[data-testid="contacts-page-content"]')).toBeVisible();
    const card = page.locator('li[data-testid^="bot-card-"]', { hasText: '阿删' });
    const botId = await card.getAttribute('data-testid').then((v) => v?.replace('bot-card-', ''));
    expect(botId).toBeTruthy();
    // Electron lower-cases the partition directory name (Linux is case-sensitive,
    // macOS is not): match it case-insensitively (partitionEntries, W8).
    const partition = `bot-${botId}`;
    // Force pending storage writes so the directory is observably present.
    await app.evaluate(async ({ session }, id) => {
      const botSession = session.fromPartition(`persist:bot-${id as string}`);
      await botSession.cookies.flushStore();
      await botSession.flushStorageData();
    }, botId);
    await expect
      .poll(() => partitionEntries(home, partition).length, { timeout: 15_000 })
      .toBeGreaterThan(0);

    // 删除 Bot（两步确认）→ 分区目录被清理。
    await card.locator('[data-testid^="bot-delete-"]').click();
    await expect(page.locator('[data-testid="bot-delete-dialog"]')).toBeVisible();
    await page.locator('[data-testid="bot-delete-confirm"]').click();
    await expect(page.locator('[data-testid="bot-delete-dialog"]')).toBeHidden({ timeout: 15_000 });
    await expect.poll(() => partitionEntries(home, partition).length, { timeout: 30_000 }).toBe(0);
    // tombstone：迟到的 ensurePage 被拒绝，目录不会复活。
    await expect.poll(() => partitionEntries(home, partition).length, { timeout: 5_000 }).toBe(0);
  } catch (error) {
    dumpRequests(llm, testInfo);
    throw error;
  } finally {
    await closeSession(session);
  }
});

test('查看窗口显示 Bot 当前页面；关闭后回到隐藏托管且不中断执行', async () => {
  const testInfo = test.info();
  test.setTimeout(300_000);
  const session = await startSession('kepcup-e2e-browser-view-');
  const { page, llm, web, app } = session;
  const viewerTitle = '阿看 的浏览器';
  try {
    await waitReady(page);
    await createBotAndOpenChat(page, '阿看');
    await bindProject(app, page, makeProjectDir('kepcup-e2e-browser-view-proj-'));

    // Bot 先打开页面（隐藏托管中）。
    await runOnce(
      page,
      llm,
      toolRun('browser_open', { url: `${web.url}/` }, 'fixture-home-marker', '首页打开了'),
      '首页打开了',
    );

    // 第二个执行挂起期间打开查看窗口：证明不中断 Bot 正在进行的操作。
    llm.script(
      'mock-main',
      viaTask({
        title: '看看页面',
        writes: false,
        ack: '我去看看页面',
        taskSteps: [
          step().replyToolCall('browser_snapshot', {}),
          step().expect(bodyContains('fixture-home-marker')).hold().replyText('任务：后台还在跑'),
        ],
        relay: '后台还在跑',
      }),
    );
    const composer = page.locator('[data-testid="composer-input"]');
    await composer.fill('看看页面');
    await composer.press('ControlOrMeta+Enter');
    // The task's status line (the turn that started it has its own, briefly).
    await expect(
      page.locator('[data-testid="run-status"]').filter({ hasText: '看看页面' }),
    ).toBeVisible({ timeout: 30_000 });

    // 「查看浏览器」按钮在右栏头部（右栏默认收起，先经顶部药丸展开）。
    if (!(await page.locator('[data-testid="browser-show"]').isVisible())) {
      await page.locator('[data-testid="right-panel-toggle"]').click();
    }
    await page.locator('[data-testid="browser-show"]').click();

    // 查看窗口可见，且其子视图就是 Bot 的当前页面（夹具 URL）。
    await expect
      .poll(
        async () => {
          const info = await app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()
              .filter((w) => !w.isDestroyed())
              .map((w) => ({
                title: w.getTitle(),
                visible: w.isVisible(),
                childUrls: w.contentView.children.map(
                  (c) => (c as Partial<WebContentsView>).webContents?.getURL() ?? '',
                ),
              })),
          );
          const viewerWindow = info.find((w) => w.title === viewerTitle);
          return viewerWindow !== undefined &&
            viewerWindow.visible &&
            viewerWindow.childUrls.some((u) => u.startsWith(`${web.url}/`))
            ? 'shown'
            : 'pending';
        },
        { timeout: 15_000 },
      )
      .toBe('shown');

    // 关闭查看窗口 → 页面回到隐藏托管（宿主窗口仍持有该视图），窗口销毁。
    await app.evaluate(({ BrowserWindow }, title) => {
      BrowserWindow.getAllWindows()
        .find((w) => w.getTitle() === title)
        ?.close();
    }, viewerTitle);
    await expect
      .poll(
        async () => {
          const info = await app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()
              .filter((w) => !w.isDestroyed())
              .map((w) => ({
                title: w.getTitle(),
                childUrls: w.contentView.children.map(
                  (c) => (c as Partial<WebContentsView>).webContents?.getURL() ?? '',
                ),
              })),
          );
          return info.some((w) => w.title === viewerTitle) ? 'open' : 'closed';
        },
        { timeout: 15_000 },
      )
      .toBe('closed');
    const hosts = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .filter((w) => !w.isDestroyed())
        .flatMap((w) =>
          w.contentView.children.map(
            (c) => (c as Partial<WebContentsView>).webContents?.getURL() ?? '',
          ),
        ),
    );
    expect(hosts.some((u) => u.startsWith(`${web.url}/`))).toBe(true);

    // 挂起中的执行在窗口开关之后照常完成。
    llm.releaseAll();
    await expect(
      page.locator('[data-testid="bot-bubble"]').filter({ hasText: '后台还在跑' }),
    ).toBeVisible({ timeout: 60_000 });

    // 页面仍可用于后续操作（隐藏托管继续）。
    await runOnce(
      page,
      llm,
      toolRun('browser_snapshot', {}, 'fixture-home-marker', '页面还能用'),
      '页面还能用',
    );
  } catch (error) {
    dumpRequests(llm, testInfo);
    throw error;
  } finally {
    await closeSession(session);
  }
});

test('技术点①：隐藏页面的截图非空白（像素多样性）', async () => {
  const testInfo = test.info();
  test.setTimeout(240_000);
  const session = await startSession('kepcup-e2e-browser-shot-');
  const { page, llm, web } = session;
  try {
    await waitReady(page);
    await createBotAndOpenChat(page, '小照');
    await bindProject(session.app, page, makeProjectDir('kepcup-e2e-browser-shot-proj-'));

    await runOnce(
      page,
      llm,
      toolRun('browser_open', { url: `${web.url}/` }, 'fixture-home-marker', '首页打开了'),
      '首页打开了',
    );
    await runOnce(
      page,
      llm,
      toolRun('browser_screenshot', {}, '已截取页面图像', '截图拿到了'),
      '截图拿到了',
    );

    // 找到携带截图的那次模型请求（运行结束后还有后台反思请求，不能取 at(-1)）。
    const shotSerialized = (() => {
      for (const request of [...llm.requests()].reverse()) {
        const serialized = JSON.stringify(request.body);
        if (serialized.includes('已截取页面图像')) return serialized;
      }
      return '';
    })();
    expect(shotSerialized).toContain('1280x800'); // tool note
    const base64 = extractPngBase64(shotSerialized);
    expect(base64).not.toBeNull();
    const stats = pngPixelStats(base64!);
    // clip 限定的是 CSS 视口（1280x800）；物理像素随显示器 DPR 缩放
    // （本机 retina = 2x → 2560x1600），宽高比不变。
    expect(stats.width / stats.height).toBeCloseTo(1280 / 800, 5);
    expect(stats.width).toBeGreaterThanOrEqual(1280);
    expect(stats.width).toBeLessThanOrEqual(2560);
    // 非空白：多种颜色（夹具页含红/绿/蓝色块、黑字白底）且有非白色像素。
    expect(stats.colors).toBeGreaterThanOrEqual(4);
    expect(stats.nonWhite).toBeGreaterThan(0);
  } catch (error) {
    dumpRequests(llm, testInfo);
    throw error;
  } finally {
    await closeSession(session);
  }
});

test('技术点③：大页面 AXTree 输出按上限截断（150 元素 / 4000 字符）', async () => {
  const testInfo = test.info();
  test.setTimeout(240_000);
  const session = await startSession('kepcup-e2e-browser-large-');
  const { page, llm, web } = session;
  try {
    await waitReady(page);
    await createBotAndOpenChat(page, '小量');
    await bindProject(session.app, page, makeProjectDir('kepcup-e2e-browser-large-proj-'));

    await runOnce(
      page,
      llm,
      toolRun('browser_open', { url: `${web.url}/large` }, 'fixture-large-marker', '大页面读到了'),
      '大页面读到了',
    );

    const toolText = lastToolContent(llm);
    expect(toolText).toContain('元素列表已达上限 150');
    // W1: the cap stays at 150; the note says how many were left out.
    expect(toolText).toContain('还有 250 个元素未列出，可 browser_scroll 或缩小范围');
    expect(toolText).toContain('（页面文本已截断）');
    const refs = toolText.match(/- \[e\d+\]/g) ?? [];
    expect(refs.length).toBe(150);
  } catch (error) {
    dumpRequests(llm, testInfo);
    throw error;
  } finally {
    await closeSession(session);
  }
});

test('W1：SPA 重渲染后点旧 ref → REF_STALE 且无副作用；密码框输入不回显', async () => {
  const testInfo = test.info();
  test.setTimeout(240_000);
  const session = await startSession('kepcup-e2e-browser-w1-');
  const { page, llm, web } = session;
  try {
    await waitReady(page);
    await createBotAndOpenChat(page, '小稳');
    await bindProject(session.app, page, makeProjectDir('kepcup-e2e-browser-w1-proj-'));

    await runOnce(
      page,
      llm,
      toolRun('browser_open', { url: `${web.url}/spa` }, 'fixture-spa-marker', 'SPA 打开了'),
      'SPA 打开了',
    );
    expect(lastToolContent(llm)).toContain('- [e1] button “删除 张三”');

    // The page re-renders the same button node with another name 1.5 s after
    // load: the old ref now points at different content.
    await page.waitForTimeout(2_000);
    await runOnce(
      page,
      llm,
      toolRun('browser_click', { ref: 'e1' }, '名称已变化', '旧引用被拒'),
      '旧引用被拒',
    );
    expect(lastToolContent(llm)).toContain('动作未执行');

    // No side effect: the click handler never ran.
    await runOnce(
      page,
      llm,
      toolRun('browser_snapshot', {}, 'fixture-spa-marker', '页面复查完成'),
      '页面复查完成',
    );
    const after = lastToolContent(llm);
    expect(after).toContain('SPA_STATUS=idle');
    expect(after).toContain('删除 李四');

    // A password field forces sensitive handling even without sensitive=true.
    await runOnce(
      page,
      llm,
      toolRun('browser_type', { ref: 'e2', text: 'pw-e2e-secret' }, '输入敏感内容', '密码填好了'),
      '密码填好了',
    );
    expect(lastToolContent(llm)).not.toContain('pw-e2e-secret');
  } catch (error) {
    dumpRequests(llm, testInfo);
    throw error;
  } finally {
    await closeSession(session);
  }
});

// --- W8 自动接管 + 共享浏览器资料 ------------------------------------------------

/** Opens the bot's viewer window from the right panel and waits until it shows the page. */
async function openViewer(
  app: ElectronApplication,
  page: Page,
  title: string,
  urlPrefix: string,
): Promise<void> {
  if (!(await page.locator('[data-testid="browser-show"]').isVisible())) {
    await page.locator('[data-testid="right-panel-toggle"]').click();
  }
  await page.locator('[data-testid="browser-show"]').click();
  await expect
    .poll(
      () =>
        app.evaluate(
          ({ BrowserWindow }, args) => {
            const win = BrowserWindow.getAllWindows().find(
              (w) => !w.isDestroyed() && w.getTitle() === args.title,
            );
            return (
              win !== undefined &&
              win.isVisible() &&
              win.contentView.children.some((c) =>
                ((c as Partial<WebContentsView>).webContents?.getURL() ?? '').startsWith(
                  args.urlPrefix,
                ),
              )
            );
          },
          { title, urlPrefix },
        ),
      { timeout: 15_000 },
    )
    .toBe(true);
}

/**
 * Viewer toolbar state ('agent' / 'user'), read from the toolbar page's data:
 * URL (the state is part of the page it was loaded with) — no script execution.
 */
async function toolbarControl(app: ElectronApplication, title: string): Promise<string | null> {
  const url = await app.evaluate(({ BrowserWindow }, viewerTitle) => {
    const win = BrowserWindow.getAllWindows().find(
      (w) => !w.isDestroyed() && w.getTitle() === viewerTitle,
    );
    return (
      win?.contentView.children
        .map((c) => (c as Partial<WebContentsView>).webContents?.getURL() ?? '')
        .find((u) => u.startsWith('data:text/html')) ?? null
    );
  }, title);
  if (url === null) return null;
  const match = /"control":"(agent|user)"/.exec(decodeURIComponent(url));
  return match?.[1] ?? null;
}

test('W8 自动接管：查看窗口里点击 → Bot 点击被拒（BROWSER_USER_CONTROL）；交还给 Bot 后成功；滚轮不算接管、键盘算；关窗即交还', async () => {
  const testInfo = test.info();
  test.setTimeout(300_000);
  const session = await startSession('kepcup-e2e-browser-takeover-');
  const { page, llm, web, app } = session;
  const viewerTitle = '阿接 的浏览器';
  try {
    await waitReady(page);
    await createBotAndOpenChat(page, '阿接');
    await bindProject(app, page, makeProjectDir('kepcup-e2e-browser-takeover-proj-'));
    await runOnce(
      page,
      llm,
      toolRun('browser_open', { url: `${web.url}/` }, 'fixture-home-marker', '首页打开了'),
      '首页打开了',
    );
    await openViewer(app, page, viewerTitle, `${web.url}/`);
    await expect.poll(() => toolbarControl(app, viewerTitle), { timeout: 15_000 }).toBe('agent');

    // 用户在查看窗口的页面里点一下（空白处，不触发页面导航）→ 页面归用户。
    await app.evaluate(
      ({ BrowserWindow }, args) => {
        const win = BrowserWindow.getAllWindows().find(
          (w) => !w.isDestroyed() && w.getTitle() === args.title,
        );
        const wc = win?.contentView.children
          .map((c) => (c as Partial<WebContentsView>).webContents)
          .find((w) => (w?.getURL() ?? '').startsWith(args.urlPrefix));
        if (wc === undefined) throw new Error('viewer page not found');
        wc.sendInputEvent({ type: 'mouseDown', x: 640, y: 600, button: 'left', clickCount: 1 });
        wc.sendInputEvent({ type: 'mouseUp', x: 640, y: 600, button: 'left', clickCount: 1 });
      },
      { title: viewerTitle, urlPrefix: `${web.url}/` },
    );
    await expect.poll(() => toolbarControl(app, viewerTitle), { timeout: 15_000 }).toBe('user');

    // Bot 的点击被拒：未派发（not_started），提示等用户交还 / ask_user。
    await runOnce(
      page,
      llm,
      toolRun('browser_click', { ref: 'e1' }, '用户正在浏览器窗口里操作', '被用户接管了'),
      '被用户接管了',
    );
    expect(lastToolContent(llm)).toContain('ask_user');

    // browser_close 也要等用户交还（不关页面）。
    await runOnce(
      page,
      llm,
      toolRun('browser_close', {}, '用户正在浏览器窗口里操作', '关闭也被拒了'),
      '关闭也被拒了',
    );
    // 网页自己改 document.title 成工具条的交还信号：无效（只认工具条页面）。
    await app.evaluate(
      async ({ BrowserWindow }, args) => {
        const win = BrowserWindow.getAllWindows().find(
          (w) => !w.isDestroyed() && w.getTitle() === args.title,
        );
        const wc = win?.contentView.children
          .map((c) => (c as Partial<WebContentsView>).webContents)
          .find((w) => (w?.getURL() ?? '').startsWith(args.urlPrefix));
        if (wc === undefined) throw new Error('viewer page not found');
        await wc.executeJavaScript("document.title = 'kepcup:handback:1'", true);
      },
      { title: viewerTitle, urlPrefix: `${web.url}/` },
    );
    await page.waitForTimeout(1_000);
    expect(await toolbarControl(app, viewerTitle)).toBe('user');

    // 工具条「交还给 Bot」→ 回到 Bot；同一个点击这次生效（进入表单页）。
    await app.evaluate(async ({ BrowserWindow }, title) => {
      const win = BrowserWindow.getAllWindows().find(
        (w) => !w.isDestroyed() && w.getTitle() === title,
      );
      const toolbar = win?.contentView.children
        .map((c) => (c as Partial<WebContentsView>).webContents)
        .find((wc) => (wc?.getURL() ?? '').startsWith('data:text/html'));
      if (toolbar === undefined) throw new Error('toolbar not found');
      await Promise.race([
        toolbar.executeJavaScript("document.getElementById('handback').click()", true),
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error('toolbar script timed out')), 10_000),
        ),
      ]);
    }, viewerTitle);
    await expect.poll(() => toolbarControl(app, viewerTitle), { timeout: 15_000 }).toBe('agent');
    await runOnce(
      page,
      llm,
      toolRun('browser_click', { ref: 'e1' }, 'fixture-form-marker', '交还后点上了'),
      '交还后点上了',
    );

    // 滚轮 / 移动鼠标不算接管；键盘输入算。
    const sendToViewerPage = (events: Array<Record<string, unknown>>) =>
      app.evaluate(
        ({ BrowserWindow }, args) => {
          const win = BrowserWindow.getAllWindows().find(
            (w) => !w.isDestroyed() && w.getTitle() === args.title,
          );
          const wc = win?.contentView.children
            .map((c) => (c as Partial<WebContentsView>).webContents)
            .find((w) => (w?.getURL() ?? '').startsWith(args.urlPrefix));
          if (wc === undefined) throw new Error('viewer page not found');
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          for (const event of args.events) wc.sendInputEvent(event as any);
        },
        { title: viewerTitle, urlPrefix: `${web.url}/`, events },
      );
    await sendToViewerPage([
      { type: 'mouseMove', x: 300, y: 300 },
      { type: 'mouseWheel', x: 300, y: 300, deltaX: 0, deltaY: -120 },
      { type: 'keyDown', keyCode: 'Down' },
      { type: 'keyUp', keyCode: 'Down' },
    ]);
    await page.waitForTimeout(1_000);
    expect(await toolbarControl(app, viewerTitle)).toBe('agent');
    await sendToViewerPage([
      { type: 'keyDown', keyCode: 'Escape' },
      { type: 'keyUp', keyCode: 'Escape' },
    ]);
    await expect.poll(() => toolbarControl(app, viewerTitle), { timeout: 15_000 }).toBe('user');

    // 关闭查看窗口 = 交还：Bot 的动作重新可用。
    await app.evaluate(({ BrowserWindow }, title) => {
      BrowserWindow.getAllWindows()
        .find((w) => !w.isDestroyed() && w.getTitle() === title)
        ?.close();
    }, viewerTitle);
    await runOnce(
      page,
      llm,
      toolRun('browser_back', {}, 'fixture-home-marker', '关窗后回到首页'),
      '关窗后回到首页',
    );
  } catch (error) {
    dumpRequests(llm, testInfo);
    throw error;
  } finally {
    await closeSession(session);
  }
});

async function openProfileTab(page: Page): Promise<void> {
  if (!(await page.locator('[data-testid="right-panel-tabs"]').isVisible())) {
    await page.locator('[data-testid="right-panel-toggle"]').click();
  }
  await page.locator('[data-testid="right-panel-tabs"]').locator('text=配置').click();
  await expect(page.locator('[data-testid="profile-tab"]')).toBeVisible();
}

async function openBrowserProfilesSettings(page: Page): Promise<void> {
  await page.locator('[data-testid="user-menu-trigger"]').click();
  await page.locator('[data-testid="menu-settings"]').click();
  await expect(page.locator('[data-testid="settings-page-content"]')).toBeVisible();
  await page.locator('[data-testid="settings-nav-browser"]').click();
  await expect(page.locator('[data-testid="settings-browser-profiles"]')).toBeVisible();
}

async function closeSettings(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-testid="settings-dialog"]')).toBeHidden();
}

/** Partition directories of a profile (Electron's on-disk spelling may be lower-cased). */
function partitionEntries(home: string, name: string): string[] {
  const root = path.join(home, 'browser', 'Partitions');
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((entry) => entry.toLowerCase() === name.toLowerCase());
}

test('W8 共享浏览器资料：同一共享资料的两个 Bot 共用 cookie，私有 Bot 看不到；删除资料后目录被清', async () => {
  const testInfo = test.info();
  test.setTimeout(420_000);
  const session = await startSession('kepcup-e2e-browser-shared-');
  const { page, llm, web, home, app } = session;
  try {
    await waitReady(page);
    await createBotAndOpenChat(page, '共甲');
    await createBotAndOpenChat(page, '共乙');
    await createBotAndOpenChat(page, '私丙');
    const project = makeProjectDir('kepcup-e2e-browser-shared-proj-');
    await bindProject(app, page, project); // 当前对话 = 私丙

    // 设置 › 浏览器资料：新建共享资料。
    await openBrowserProfilesSettings(page);
    await page.locator('[data-testid="browser-profile-new-name"]').fill('工作账号');
    await page.locator('[data-testid="browser-profile-create"]').click();
    const item = page.locator('li[data-testid^="browser-profile-bpf_"]');
    await expect(item).toHaveCount(1, { timeout: 15_000 });
    const profileId = (await item.getAttribute('data-testid'))!.replace('browser-profile-', '');
    await closeSettings(page);

    // Bot 详情：共甲、共乙挂到共享资料（选中即出现警示），自动保存。
    // 切换要显式确认（不走自动保存）：先取消一次，值复原、没有保存。
    const profileSelect = page.locator(
      '[data-testid="profile-tab"] [data-testid="bot-browser-profile"]',
    );
    const switchConfirm = page.locator('[data-testid="bot-browser-profile-confirm"]');
    for (const name of ['共甲', '共乙']) {
      await openConversation(page, name);
      await bindProject(app, page, project);
      await openProfileTab(page);
      if (name === '共甲') {
        // 键盘在下拉里移动选项：只出确认，不保存。
        await profileSelect.focus();
        await page.keyboard.press('ArrowDown');
        await expect(switchConfirm).toBeVisible();
        await page.waitForTimeout(1_000); // 超过自动保存的防抖：未确认不保存
        await page.locator('[data-testid="bot-browser-profile-confirm-no"]').click();
        await expect(switchConfirm).toBeHidden();
        await expect(profileSelect).toHaveValue('');
        await openBrowserProfilesSettings(page);
        await expect(item.locator('[data-testid="browser-profile-bots"]')).toHaveText(
          '还没有 Bot 使用它',
        );
        await closeSettings(page);
        await openProfileTab(page);
      }
      await profileSelect.selectOption(profileId);
      await expect(page.locator('[data-testid="bot-browser-profile-warning"]')).toBeVisible();
      await page.locator('[data-testid="bot-browser-profile-confirm-yes"]').click();
      await expect(switchConfirm).toBeHidden({ timeout: 15_000 });
      await expect(profileSelect).toHaveValue(profileId);
    }
    await openBrowserProfilesSettings(page);
    await expect(item.locator('[data-testid="browser-profile-bots"]')).toContainText('共甲');
    await expect(item.locator('[data-testid="browser-profile-bots"]')).toContainText('共乙');
    await closeSettings(page);

    // 共甲设置 cookie → 共乙（同一共享资料）看得到；私丙（私有）看不到。
    await openConversation(page, '共甲');
    await runOnce(
      page,
      llm,
      toolRun('browser_open', { url: `${web.url}/cookie-set` }, 'cookie-set-page', '甲设好了'),
      '甲设好了',
    );
    await openConversation(page, '共乙');
    await runOnce(
      page,
      llm,
      toolRun('browser_open', { url: `${web.url}/cookie-read` }, 'fixture_sid=SID1234', '乙看到了'),
      '乙看到了',
    );
    await openConversation(page, '私丙');
    await runOnce(
      page,
      llm,
      toolRun('browser_open', { url: `${web.url}/cookie-read` }, 'COOKIE_JAR=[]', '丙看不到'),
      '丙看不到',
    );

    // 共享资料的分区目录存在（强制落盘）。
    await app.evaluate(async ({ session: electronSession }, id) => {
      const shared = electronSession.fromPartition(`persist:shared-${id as string}`);
      await shared.cookies.flushStore();
      await shared.flushStorageData();
    }, profileId);
    await expect
      .poll(() => partitionEntries(home, `shared-${profileId}`).length, { timeout: 15_000 })
      .toBeGreaterThan(0);

    // 删除共享资料（行内确认）→ 目录被清；两个 Bot 回到私有。
    await openBrowserProfilesSettings(page);
    await item.locator('[data-testid="browser-profile-delete"]').click();
    await item.locator('[data-testid="browser-profile-confirm-yes"]').click();
    await expect(page.locator('[data-testid="browser-profiles-empty"]')).toBeVisible({
      timeout: 15_000,
    });
    await closeSettings(page);
    await expect
      .poll(() => partitionEntries(home, `shared-${profileId}`).length, { timeout: 30_000 })
      .toBe(0);
    await openConversation(page, '共甲');
    await openProfileTab(page);
    await expect(
      page.locator('[data-testid="profile-tab"] [data-testid="bot-browser-profile"]'),
    ).toHaveValue('');
  } catch (error) {
    dumpRequests(llm, testInfo);
    throw error;
  } finally {
    await closeSession(session);
  }
});

test('W7 监看后台页：不显示窗口、取完即关；内网地址被拦截记为失败；绑定 project 后本机页可读并提醒', async () => {
  const testInfo = test.info();
  test.setTimeout(300_000);
  const session = await startSession('kepcup-e2e-browser-watch-');
  const { page, llm, web, app } = session;
  /** Visible windows (the main window only; a background page never shows). */
  const visibleWindows = () =>
    app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.isVisible()).length);
  /** webContents currently showing the fixture server (a kept background page would). */
  const fixturePages = (origin: string) =>
    app.evaluate(
      ({ webContents }, target) =>
        webContents.getAllWebContents().filter((wc) => wc.getURL().startsWith(target)).length,
      origin,
    );
  try {
    await waitReady(page);
    await createBotAndOpenChat(page, '小盯');
    const windowsBefore = await visibleWindows();

    // 1) 对话轮直接用 watch_create（异步托管动作，不派任务）：内网地址。
    const before = web.requestsServed();
    llm.script('mock-main', [
      step()
        .expect((req) => req.lastUserText().includes('盯一下路由器'))
        .replyToolCall('watch_create', {
          url: 'http://192.168.1.1/',
          condition: { kind: 'changed' },
          interval_minutes: 5,
        }),
      step().replyText('好的，开始监看路由器页面'),
    ]);
    const composer = page.locator('[data-testid="composer-input"]');
    await composer.fill('盯一下路由器页面');
    await composer.press('ControlOrMeta+Enter');
    await expect(
      page.locator('[data-testid="bot-bubble"]').filter({ hasText: '开始监看路由器页面' }),
    ).toBeVisible({ timeout: 90_000 });
    await expect(page.locator('[data-testid^="watch-card-created-"]').first()).toBeVisible({
      timeout: 15_000,
    });

    // 右栏「定时任务」标签里的监看列表：第一次检查立即执行，被网络规则拦截 → 失败计数。
    const tabs = page.locator('[data-testid="right-panel-tabs"]');
    if (!(await tabs.isVisible())) await page.locator('[data-testid="right-panel-toggle"]').click();
    await tabs.locator('text=定时任务').click();
    const list = page.locator('[data-testid="watches-tab-list"]');
    await expect(list.locator('[data-testid="watch-failing"]')).toContainText('拦截', {
      timeout: 60_000,
    });
    expect(web.requestsServed()).toBe(before);
    expect(await visibleWindows()).toBe(windowsBefore);

    // 2) 绑定 project 后本机地址放行：contains 条件首检即满足 → 提醒卡 + 唤醒对话轮。
    await bindProject(app, page, makeProjectDir('kepcup-e2e-browser-watch-proj-'));
    llm.script('mock-main', [
      step()
        .expect((req) => req.lastUserText().includes('盯一下本机页面'))
        .replyToolCall('watch_create', {
          url: `${web.url}/`,
          condition: { kind: 'contains', text: 'fixture-home-marker' },
          interval_minutes: 5,
        }),
      step().replyText('好的，开始监看本机页面'),
      step()
        .expect((req) => req.lastUserText().includes('<trigger reason="watch"'))
        .replyText('本机页面出现了标记'),
    ]);
    await composer.fill('盯一下本机页面');
    await composer.press('ControlOrMeta+Enter');
    await expect(
      page.locator('[data-testid="bot-bubble"]').filter({ hasText: '本机页面出现了标记' }),
    ).toBeVisible({ timeout: 90_000 });
    await expect(page.locator('[data-testid^="watch-card-alert-"]').first()).toBeVisible();
    await expect(page.locator('[data-testid="watch-card-summary"]').first()).toContainText(
      'fixture-home-marker',
    );
    expect(web.requestsServed()).toBeGreaterThan(before);
    // Never shown, not kept: no extra visible window, no page left on the fixture.
    expect(await visibleWindows()).toBe(windowsBefore);
    await expect.poll(() => fixturePages(web.url), { timeout: 15_000 }).toBe(0);
  } catch (error) {
    dumpRequests(llm, testInfo);
    throw error;
  } finally {
    await closeSession(session);
  }
});
