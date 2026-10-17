import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page, _electron } from '@playwright/test';
import { startMockLlm, step, type MockChatRequest, type MockLlmStep, type MockLlmServer } from '@kepcup/testkit';
import { createBotAndOpenChat, rpc } from './helpers/create-bot';
import { createProjectViaUi } from './helpers/create-project';
import { rmHomeTolerant } from './helpers/home-cleanup';

/**
 * 项目组静默路由（D92 41 §6，WP8）：负责人 L（阿甲）、成员 M（阿乙）、N（阿丙）。
 * 续接判断与负责人网关都是 loop_type='triage' 的结构化调用（mock-light），按
 * 请求体区分：续接判断的用户消息含「你的名片：」，网关含「成员名册：」（§7
 * 陷阱：不按调用顺序假设）。mock-main 是成员回合。
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

/** 续接判断（上一位回话者 P 的认领判断）。 */
const isContinuation = (name: string) => (req: MockChatRequest) =>
  req.lastUserText().includes(`你的名片：${name}`);

/** 负责人网关。 */
const isGate = (req: MockChatRequest) => req.lastUserText().includes('成员名册：');

async function sendPlain(page: Page, text: string): Promise<void> {
  const composer = page.locator('[data-testid="composer-input"]');
  await composer.click();
  await composer.fill(text);
  await composer.press('Meta+Enter');
}

async function botIdOf(page: Page, name: string): Promise<string> {
  const { bots } = (await rpc(page, 'bots.list')) as {
    bots: Array<{ id: string; name: string }>;
  };
  return bots.find((bot) => bot.name === name)?.id ?? '';
}

test('project routing: gate routes to member, continuation claims, gate self/none, explicit @ bypasses routing', async () => {
  test.setTimeout(300_000);
  const session = await startSession('kepcup-e2e-project-routing-');
  const { page, llm } = session;
  try {
    await waitReady(page);
    await createBotAndOpenChat(page, '阿甲');
    await createBotAndOpenChat(page, '阿乙');
    await createBotAndOpenChat(page, '阿丙');
    await createProjectViaUi(page, '路由项目', ['阿甲', '阿乙', '阿丙']);
    const composer = page.locator('[data-testid="composer-input"]');
    const bubbles = page.locator('[data-testid="bot-bubble"]');

    // --- ① 没有 @、无上一位回话者：网关 route [M] → M 回复 ----------------------
    const mid = await botIdOf(page, '阿乙');
    // 网关调用 hold 住：路由阶段的状态行（「正在确认由谁回复」）可稳定断言。
    const gateStep: MockLlmStep = step()
      .expect(isGate)
      .hold()
      .replyJson({ decision: 'route', targets: [mid], reason: '归乙' });
    llm.script('mock-light', [gateStep]);
    llm.script('mock-main', [
      step()
        .expect((r) => JSON.stringify(r.body.messages).includes('名字：阿乙'))
        .replyText('乙来答'),
    ]);
    await sendPlain(page, '这个问题谁懂');
    const status = page.locator('[data-testid="project-turn-status"]');
    await expect(status).toBeVisible({ timeout: 15_000 });
    await expect(status).toHaveAttribute('data-phase', 'routing');
    await expect(status).toContainText('正在确认由谁回复');
    gateStep.release();
    await expect(bubbles.filter({ hasText: '乙来答' })).toBeVisible({ timeout: 60_000 });
    // 只有用户消息与 M 的回复：没有 L 的消息、没有系统消息 / 卡片。
    await expect(bubbles).toHaveCount(1);
    await expect(page.locator('[data-testid="system-message"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="episode-paused-card"]')).toHaveCount(0);
    await expect(status).toHaveCount(0, { timeout: 15_000 });

    // --- ② 续接：M 先回复过（①），无 @ 消息由 M 认领，网关未被调用 --------------
    const gateCallsAfter1 = llm.requestsFor('mock-light').filter(isGate).length;
    llm.script('mock-light', [
      step()
        .expect(isContinuation('阿乙'))
        .replyJson({ decision: 'respond', confidence: 0.9, reason: '续我的' }),
    ]);
    llm.script('mock-main', [
      step()
        .expect((r) => JSON.stringify(r.body.messages).includes('名字：阿乙'))
        .replyText('乙续答'),
    ]);
    await sendPlain(page, '接着刚才的继续');
    await expect(bubbles.filter({ hasText: '乙续答' })).toBeVisible({ timeout: 60_000 });
    await expect(bubbles).toHaveCount(2);
    // 网关没有被调用（mock-light 的网关请求数不变）。
    expect(llm.requestsFor('mock-light').filter(isGate).length).toBe(gateCallsAfter1);

    // --- ③ 续接不认领 → 网关 self → 负责人 L 回复 -------------------------------
    llm.script('mock-light', [
      step()
        .expect(isContinuation('阿乙'))
        .replyJson({ decision: 'not_mine', confidence: 0.9, reason: '不归我' }),
      step().expect(isGate).replyJson({ decision: 'self', targets: [], reason: '我来' }),
    ]);
    llm.script('mock-main', [
      step()
        .expect((r) => JSON.stringify(r.body.messages).includes('名字：阿甲'))
        .replyText('甲兜底'),
    ]);
    await sendPlain(page, '项目整体怎么安排');
    await expect(bubbles.filter({ hasText: '甲兜底' })).toBeVisible({ timeout: 60_000 });
    await expect(bubbles).toHaveCount(3);

    // --- ④ 网关 none（纯致谢）：无回复、无卡片；输入框仍可发送 -------------------
    const bubblesBefore = await bubbles.count();
    llm.script('mock-light', [
      step().expect(isGate).replyJson({ decision: 'none', targets: [], reason: '纯致谢' }),
    ]);
    await sendPlain(page, '谢谢');
    // 网关请求已应答、回合静默收口：状态行回到消失（idle）。
    await expect
      .poll(() => llm.requestsFor('mock-light').filter(isGate).length, { timeout: 30_000 })
      .toBe(gateCallsAfter1 + 1);
    await expect(status).toHaveCount(0, { timeout: 15_000 });
    await expect(bubbles).toHaveCount(bubblesBefore);
    await expect(page.locator('[data-testid="system-message"]')).toHaveCount(0);

    // --- ⑤ 显式 @N：只有 N 回复，没有路由 / 续接调用 ----------------------------
    const continuationCalls = llm.requestsFor('mock-light').filter((r) =>
      r.lastUserText().includes('你的名片：'),
    ).length;
    const gateCalls = llm.requestsFor('mock-light').filter(isGate).length;
    llm.script('mock-main', [
      step()
        .expect((r) => JSON.stringify(r.body.messages).includes('名字：阿丙'))
        .replyText('丙直达'),
    ]);
    await composer.click();
    await composer.pressSequentially('@阿丙');
    await page
      .locator('[data-testid="mention-popup"] button')
      .filter({ hasText: '阿丙' })
      .first()
      .click();
    await composer.pressSequentially(' 直达问题');
    await composer.press('Meta+Enter');
    await expect(bubbles.filter({ hasText: '丙直达' })).toBeVisible({ timeout: 60_000 });
    expect(bubbles).toHaveCount(bubblesBefore + 1);
    // 路由与续接判断都没跑（显式目标直接开轮）。
    expect(llm.requestsFor('mock-light').filter((r) => r.lastUserText().includes('你的名片：')).length).toBe(
      continuationCalls,
    );
    expect(llm.requestsFor('mock-light').filter(isGate).length).toBe(gateCalls);
  } finally {
    await closeSession(session);
  }
});
