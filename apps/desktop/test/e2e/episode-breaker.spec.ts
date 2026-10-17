import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page, _electron } from '@playwright/test';
import { startMockLlm, step, type MockChatRequest, type MockLlmServer } from '@kepcup/testkit';
import { createBotAndOpenChat, rpc } from './helpers/create-bot';
import { createProjectViaUi } from './helpers/create-project';
import { rmHomeTolerant } from './helpers/home-cleanup';

/**
 * 协作熔断 e2e（D92 41 §7.3，WP8）：启动时带 `KEPCUP_TEST_EPISODE_LIMITS=2,2`
 * （test-hook 构建的测试缝），负责人 L（阿甲）与成员 M（阿乙）脚本化互相 @——
 * 第 3 次触发熔断：沟通里出现暂停卡（其他 tab 时沟通 tab 出徽标）；「继续」
 * 补投被暂停的触发；再熔断后「停止」→ stopped、pending 丢弃、不再有新往返。
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
      // WP8 测试缝：熔断阈值降到 2/2（仅 test-hook 构建；打包产物折叠掉）。
      KEPCUP_TEST_EPISODE_LIMITS: '2,2',
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

/** The system prompt of a turn names the bot（与 episodes-breaker.test.ts 同法）。 */
const isBot = (name: string) => (request: MockChatRequest) =>
  (request.body.messages ?? []).some(
    (message) =>
      message.role === 'system' &&
      typeof message.content === 'string' &&
      message.content.includes(`名字：${name}`),
  );

/** One L→M→L→(trip) ping-pong against fresh counters. */
function pingPong(aId: string, bId: string, round: string) {
  return [
    step()
      .inTurn()
      .expect(isBot('阿甲'))
      .replyToolCall('send_message', { text: `${round}请阿乙看`, mention_bot_ids: [bId] }),
    step().inTurn().expect(isBot('阿甲')).replyText(`甲${round}收尾`),
    step()
      .inTurn()
      .expect(isBot('阿乙'))
      .replyToolCall('send_message', { text: `${round}请阿甲复核`, mention_bot_ids: [aId] }),
    step().inTurn().expect(isBot('阿乙')).replyText(`乙${round}收尾`),
    step()
      .inTurn()
      .expect(isBot('阿甲'))
      .replyToolCall('send_message', { text: `${round}再请阿乙看`, mention_bot_ids: [bId] }),
    step().inTurn().expect(isBot('阿甲')).replyText(`甲${round}再收尾`),
  ];
}

async function botIdOf(page: Page, name: string): Promise<string> {
  const { bots } = (await rpc(page, 'bots.list')) as {
    bots: Array<{ id: string; name: string }>;
  };
  return bots.find((bot) => bot.name === name)?.id ?? '';
}

/** M 的回合 run 数（loop_type=turn）——「停止后不再投递」用它判定。 */
async function memberTurnRuns(page: Page, conversationId: string, botId: string): Promise<number> {
  const { runs } = (await rpc(page, 'runs.list', { conversationId, limit: 100 })) as {
    runs: Array<{ botId: string; loopType: string }>;
  };
  return runs.filter((run) => run.botId === botId && run.loopType === 'turn').length;
}

test('episode breaker: pause card, resume re-delivers, stop ends the round', async () => {
  test.setTimeout(300_000);
  const session = await startSession('kepcup-e2e-episode-breaker-');
  const { page, llm } = session;
  try {
    await waitReady(page);
    await createBotAndOpenChat(page, '阿甲');
    await createBotAndOpenChat(page, '阿乙');
    await createProjectViaUi(page, '熔断项目', ['阿甲', '阿乙']);
    const aId = await botIdOf(page, '阿甲');
    const bId = await botIdOf(page, '阿乙');
    const conversationId = await (async () => {
      const { conversations } = (await rpc(page, 'conversations.list')) as {
        conversations: Array<{ id: string; type: string; title: string | null }>;
      };
      return conversations.find((c) => c.type === 'project' && c.title === '熔断项目')?.id ?? '';
    })();

    const composer = page.locator('[data-testid="composer-input"]');
    const cards = page.locator('[data-testid="episode-paused-card"]');

    // 第一轮 ping-pong：L@M（1）→ M@L（2）→ L@M 第 3 次触发熔断（2,2 阈值）。
    llm.script('mock-main', pingPong(aId, bId, '第一轮'));
    await composer.click();
    await composer.pressSequentially('@阿甲 开始协作');
    await page
      .locator('[data-testid="mention-popup"] button')
      .filter({ hasText: '阿甲' })
      .first()
      .click();
    await composer.press('Meta+Enter');

    // 切到 Wiki tab：熔断发生时沟通 tab 出徽标（用户在其他模块也不会漏掉）。
    await page.locator('[data-testid="project-tab-wiki"]').click();
    await expect(page.locator('[data-testid="project-view"]')).toHaveAttribute('data-view', 'wiki');
    await expect(page.locator('[data-testid="project-tab-badge-chat"]')).toBeVisible({
      timeout: 60_000,
    });

    // 回到沟通：暂停卡 data-status="paused"，文案带往返次数；有「继续 / 停止」。
    await page.locator('[data-testid="project-tab-chat"]').click();
    await expect(cards.last()).toBeVisible({ timeout: 60_000 });
    await expect(cards.last()).toHaveAttribute('data-status', 'paused');
    await expect(cards.last()).toContainText('协作已自动往返 2 次，已暂停');
    await expect(cards.last()).toContainText('待投递');
    await expect(page.locator('[data-testid="episode-resume"]')).toBeVisible();
    await expect(page.locator('[data-testid="episode-stop"]')).toBeVisible();

    // 「继续」：卡变 active（已继续协作），被暂停的触发补投给 M，M 回复。
    // 先等甲的收尾气泡（触发熔断的那个回合仍要把话说完），再重设脚本。
    await expect(
      page.locator('[data-testid="bot-bubble"]').filter({ hasText: '甲第一轮再收尾' }),
    ).toBeVisible({ timeout: 60_000 });
    llm.script('mock-main', [
      step().inTurn().expect(isBot('阿乙')).replyText('乙补投完成'),
    ]);
    await page.locator('[data-testid="episode-resume"]').click();
    await expect(cards.last()).toHaveAttribute('data-status', 'active', { timeout: 15_000 });
    await expect(cards.last()).toContainText('已继续协作');
    await expect(
      page.locator('[data-testid="bot-bubble"]').filter({ hasText: '乙补投完成' }),
    ).toBeVisible({ timeout: 60_000 });
    // 继续后按钮消失（active 无按钮）。
    await expect(page.locator('[data-testid="episode-resume"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="episode-stop"]')).toHaveCount(0);

    // 再触发一次熔断（计数已清零，重跑同一脚本）：新暂停卡出现。
    llm.script('mock-main', pingPong(aId, bId, '第二轮'));
    await composer.click();
    await composer.pressSequentially('@阿甲 继续协作');
    await page
      .locator('[data-testid="mention-popup"] button')
      .filter({ hasText: '阿甲' })
      .first()
      .click();
    await composer.press('Meta+Enter');
    await expect(cards).toHaveCount(2, { timeout: 60_000 });
    await expect(cards.last()).toHaveAttribute('data-status', 'paused');

    // 「停止」：卡变 stopped（已停止协作），pending 丢弃——M 没有新的回合。
    // （不重设 mock 脚本：甲的收尾请求仍在飞行，让它按剧本走完。）
    const mRunsBefore = await memberTurnRuns(page, conversationId, bId);
    await page.locator('[data-testid="episode-stop"]').click();
    await expect(cards.last()).toHaveAttribute('data-status', 'stopped', { timeout: 15_000 });
    await expect(cards.last()).toContainText('已停止协作');
    // 停止后回合收敛：状态行消失，M 的回合数不再增长。
    await expect(page.locator('[data-testid="project-turn-status"]')).toHaveCount(0, {
      timeout: 60_000,
    });
    await expect
      .poll(async () => memberTurnRuns(page, conversationId, bId), { timeout: 15_000 })
      .toBe(mRunsBefore);
  } finally {
    await closeSession(session);
  }
});
