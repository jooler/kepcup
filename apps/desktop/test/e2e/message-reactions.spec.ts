import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page, _electron } from '@playwright/test';
import { startMockLlm, step } from '@kepcup/testkit';
import { createBotAndOpenChat } from './helpers/create-bot';
import { rmHomeTolerant } from './helpers/home-cleanup';

/**
 * Bot 消息 emoji 反馈与举报入口（AI 内容举报 todo §4 / §10.4）：hover 面板点
 * 👎 出 chip 且本地假 Worker 恰好收到一次 POST（hashes.content 可复算）；再点
 * 👎 = 切换关闭（chip 消失；cancel 是纯本机行为，不产生新 POST——首条已发出
 * 的举报不可撤）；❤️ 再点即取消（chip 消失）；右键菜单「举报不当内容」与 👎
 * 同流程（无确认、无 toast）。
 *
 * 反滥用 PoW（任务 5A）：假 Worker 实现 GET /v1/challenge（difficulty 4）并要求
 * POST 带 proof 兄弟键（校验存在即可）；challenge GET 不计入 reports 计数。
 */

const REPLY_1 = '这是一条被举报的回复';
const REPLY_2 = '第二条被举报的回复';

/** 假 challenge 难度：4（≈16 次哈希，测试秒解）。 */
const FAKE_POW_DIFFICULTY = 4;

/** 签出协议 v1 形状的假 token `v1.<payload>.<hmac>`（core 不验签，只解 n）。 */
function fakeChallengeToken(nonce: string, expiresAt: number, difficulty: number): string {
  const payloadPart = Buffer.from(
    JSON.stringify({ n: nonce, exp: expiresAt, d: difficulty, ipf: '' }),
    'utf8',
  ).toString('base64url');
  const mac = createHmac('sha256', 'e2e-fake-pow-secret')
    .update(`v1.${payloadPart}`, 'utf8')
    .digest();
  return `v1.${payloadPart}.${mac.toString('base64url')}`;
}

/**
 * 本地假举报 Worker：GET /v1/challenge 发 difficulty 4 的假 challenge；
 * POST /v1/reports 要求带 proof（校验存在），记录整份 body 后回 201。
 * `reports` 只数被受理的 POST（challenge GET 与被拒 POST 都不计入）。
 */
class FakeReportWorker {
  reports: Array<Record<string, unknown>> = [];
  url = '';
  #server: Server | null = null;

  async start(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.#server = createServer((req, res) => {
        if (req.method === 'GET' && (req.url ?? '').includes('/v1/challenge')) {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              challenge: fakeChallengeToken(
                randomBytes(16).toString('hex'),
                Date.now() + 600_000,
                FAKE_POW_DIFFICULTY,
              ),
              difficulty: FAKE_POW_DIFFICULTY,
              expiresAt: Date.now() + 600_000,
              algorithm: 'sha256',
            }),
          );
          return;
        }
        if (req.method === 'POST' && (req.url ?? '').includes('/v1/reports')) {
          const chunks: Buffer[] = [];
          req.on('data', (chunk: Buffer) => chunks.push(chunk));
          req.on('end', () => {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
              proof?: { challenge?: unknown; solution?: unknown };
            };
            // PoW 反滥用（任务 5A）：无 proof / 形状不对 → 400 missing_proof。
            const proof = body.proof;
            if (
              typeof proof !== 'object' ||
              proof === null ||
              typeof proof.challenge !== 'string' ||
              proof.challenge.length === 0 ||
              typeof proof.solution !== 'string'
            ) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'missing_proof' }));
              return;
            }
            this.reports.push(body as Record<string, unknown>);
            res.statusCode = 201;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ status: 'accepted', id: 'rep_e2e' }));
          });
          return;
        }
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end('{}');
      });
      this.#server.listen(0, '127.0.0.1', () => {
        const address = this.#server?.address() as { port: number };
        this.url = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      if (this.#server === null) return resolve();
      this.#server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  }
}

async function launchApp(options: {
  home: string;
  llmUrl: string;
  reportEndpoint: string;
}): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await _electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      TZ: 'Asia/Shanghai',
      KEPCUP_HOME: options.home,
      NODE_ENV: 'test',
      KEPCUP_KEYSTORE: 'file',
      KEPCUP_ONBOARDING: 'off',
      KEPCUP_FILE_KEYSTORE_PATH: path.join(options.home, '.test-master-key'),
      KEPCUP_MOCK_LLM_URL: options.llmUrl,
      KEPCUP_REPORT_ENDPOINT: options.reportEndpoint,
    },
  });
  const page = await app.firstWindow();
  // 渲染层错误透传到测试日志（reaction 链路全程静默，失败只进 console）。
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      console.warn(`[renderer ${msg.type()}]`, msg.text());
    }
  });
  page.on('pageerror', (error) => console.warn('[renderer pageerror]', error.message));
  return { app, page };
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
}

/** hover 一条 Bot 气泡并打开 emoji 面板。 */
async function openReactionPanel(page: Page, bubble: ReturnType<Page['locator']>): Promise<void> {
  await bubble.hover();
  const react = page.locator('[data-testid="message-react"]').first();
  await expect(react).toBeVisible();
  await react.click();
  await expect(page.locator('[data-testid="message-react-panel"]')).toBeVisible();
}

async function pickEmoji(page: Page, emoji: string): Promise<void> {
  await page.locator(`[data-testid="reaction-option-${emoji}"]`).first().click();
  // 点选后面板收起、焦点回触发按钮。
  await expect(page.locator('[data-testid="message-react-panel"]')).toHaveCount(0);
}

test('bot message reactions: dislike reports once, heart toggles, context menu reports', async () => {
  test.setTimeout(240_000);
  const worker = new FakeReportWorker();
  await worker.start();
  const llm = await startMockLlm();
  const home = await mkdtemp(path.join(tmpdir(), 'kepcup-e2e-reactions-'));
  const launched = await launchApp({
    home,
    llmUrl: llm.url,
    reportEndpoint: `${worker.url}/v1/reports`,
  });
  const { page } = launched;
  try {
    await waitReady(page);
    await createBotAndOpenChat(page, '小艾');

    llm.script('mock-main', [step().replyText(REPLY_1)]);
    const composer = page.locator('[data-testid="composer-input"]');
    await composer.fill('触发举报');
    await composer.press('Enter');
    const firstBubble = page.locator('[data-testid="bot-bubble"]').first();
    await expect(firstBubble).toContainText(REPLY_1, { timeout: 30_000 });

    // hover → message-react → 👎：chip 出现，假 Worker 恰好收到一次 POST。
    await openReactionPanel(page, firstBubble);
    await pickEmoji(page, '👎');
    const dislikeChip = page.locator('[data-testid="reaction-chip-👎"]').first();
    await expect(dislikeChip).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(() => worker.reports.length, { timeout: 30_000 })
      .toBe(1);
    const report = worker.reports[0] as {
      schemaVersion: number;
      reason: string;
      reportId: string;
      source: { kind: string };
      client: { surface: string };
      message: { text: string; kind: string };
      hashes: { content: string };
      proof?: { challenge: string; solution: string };
    };
    // content hash（§5.4）：text 消息 = sha256(utf8(正文))，可复算。
    expect(report.schemaVersion).toBe(1);
    expect(report.reason).toBe('inappropriate');
    expect(report.reportId).toMatch(/^rep_/);
    expect(report.source.kind).toBe('local');
    expect(report.client.surface).toBe('desktop');
    expect(report.message.kind).toBe('text');
    expect(report.message.text).toBe(REPLY_1);
    expect(report.hashes.content).toBe(createHash('sha256').update(REPLY_1, 'utf8').digest('hex'));
    // PoW（任务 5A）：POST 带 proof 兄弟键（challenge token v1 形状 + 非 ASCII 空解）。
    expect(report.proof?.challenge).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(report.proof?.solution.length).toBeGreaterThan(0);

    // 同一条再点 👎 = 切换关闭：chip 消失；首条 POST 已落地（已发送不可撤，
    // reports.cancel 只撤本机队列），cancel 不产生新的 POST。
    await openReactionPanel(page, firstBubble);
    await pickEmoji(page, '👎');
    await expect(page.locator('[data-testid="reaction-chip-👎"]')).toHaveCount(0, {
      timeout: 15_000,
    });
    await page.waitForTimeout(1_500);
    expect(worker.reports).toHaveLength(1);

    // ❤️ 加上再取消：chip 出现后消失（👍 语义由同一分支覆盖）。
    await openReactionPanel(page, firstBubble);
    await pickEmoji(page, '❤️');
    const heartChip = page.locator('[data-testid="reaction-chip-❤️"]').first();
    await expect(heartChip).toBeVisible({ timeout: 15_000 });
    await openReactionPanel(page, firstBubble);
    await pickEmoji(page, '❤️');
    await expect(heartChip).toHaveCount(0, { timeout: 15_000 });

    // 同一条右键菜单「举报不当内容」：👎 已被上面的 toggle 移除 → 走首次举报
    // 路径（无确认弹窗），chip 重新出现；新举报命中同内容去重窗口（首条已
    // sent，行仍占 24h/90d 槽位）→ duplicate 不入队，POST 数不变。
    await firstBubble.click({ button: 'right' });
    await page.locator('[data-testid="context-message-report"]').click();
    await expect(dislikeChip).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(1_500);
    expect(worker.reports).toHaveLength(1);

    // 第二条 Bot 回复经右键菜单举报：👎 chip 出现；发送限流 1 条/分钟，
    // 测试窗口内 POST 仍是第一次的那一份。
    llm.script('mock-main', [step().replyText(REPLY_2)]);
    await composer.fill('再触发一次');
    await composer.press('Enter');
    const secondBubble = page.locator('[data-testid="bot-bubble"]').nth(1);
    await expect(secondBubble).toContainText(REPLY_2, { timeout: 30_000 });
    await secondBubble.click({ button: 'right' });
    await page.locator('[data-testid="context-message-report"]').click();
    await expect(page.locator('[data-testid="reaction-chip-👎"]')).toHaveCount(2, {
      timeout: 15_000,
    });
    await page.waitForTimeout(1_500);
    expect(worker.reports).toHaveLength(1);
  } finally {
    await launched.app.close();
    await llm.stop();
    await worker.stop();
    await rmHomeTolerant(home);
  }
});
