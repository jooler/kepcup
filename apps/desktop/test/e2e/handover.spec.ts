import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page, _electron } from '@playwright/test';
import { botProfile, startMockLlm, step, type MockLlmServer } from '@kepcup/testkit';

/**
 * D88 移交卡（docs/design/37 §2.2，todo/bot-handover.md §3.6 / §3.7）：真实 core 栈里
 * 阿尔法用 schedule 工具建两条定时任务；管家 propose_handover 出一张「阿尔法 → 贝塔」
 * 移交卡（dock 里可逐项勾选）→ 勾掉一项确认 → 消息流里的进度卡逐项打勾、结束为已完成，
 * 勾掉的一项标「未勾选」；贝塔私聊出现重建的回执卡与交接说明，阿尔法的原回执卡标
 * 「已移交给 贝塔」。全程 mock LLM。
 */

type Rpc = (method: string, input?: unknown) => Promise<unknown>;

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
  return { app, page, home, llm };
}

async function closeSession(session: Session): Promise<void> {
  await session.app.close();
  await session.llm.stop();
  await rm(session.home, { recursive: true, force: true });
}

function rpc(page: Page, method: string, input?: unknown): Promise<unknown> {
  return page.evaluate(
    ([m, i]) => (window as unknown as { __kepcupRpc: Rpc }).__kepcupRpc(m as string, i),
    [method, input] as const,
  );
}

async function openChat(page: Page, name: string): Promise<void> {
  const backdrop = page.locator('[data-testid="start-chat-backdrop"]');
  if (await backdrop.isVisible()) await backdrop.click().catch(() => {});
  // 按会话名精确匹配（预览行里可能出现别的 Bot 的名字）。
  await page
    .locator('[data-testid^="conversation-item-"]')
    .filter({
      has: page.locator('[data-testid="conversation-name"]', { hasText: new RegExp(`^${name}$`) }),
    })
    .first()
    .click();
  await expect(
    page.locator(
      '[data-testid^="conversation-item-"][data-active="true"] [data-testid="conversation-name"]',
    ),
  ).toHaveText(name, { timeout: 15_000 });
}

test('handover card: uncheck one item, confirm, progress and results render', async () => {
  test.setTimeout(240_000);
  const session = await startSession('kepcup-e2e-handover-');
  const { page, llm } = session;
  try {
    const butler = (await rpc(page, 'butler.ensure', {})) as {
      bot: { id: string };
      conversationId: string;
    };
    const alpha = (await rpc(page, 'bots.create', { profile: botProfile({ name: '阿尔法' }) })) as {
      bot: { id: string };
    };
    const beta = (await rpc(page, 'bots.create', { profile: botProfile({ name: '贝塔' }) })) as {
      bot: { id: string };
    };
    const alphaChat = (await rpc(page, 'conversations.openDirect', { botId: alpha.bot.id })) as {
      conversation: { id: string };
    };
    await rpc(page, 'conversations.openDirect', { botId: beta.bot.id });

    // 阿尔法在自己的私聊里建两条定时任务（真实 schedule 工具路径）。
    llm.script('mock-main', [
      step().replyToolCall('schedule', { when: '0 9 * * *', title: '日报', note: '写日报' }),
      step().replyToolCall('schedule', { when: '0 18 * * 5', title: '周报', note: '写周报' }),
      step().replyText('两条都设好了。'),
    ]);
    await rpc(page, 'messages.send', {
      conversationId: alphaChat.conversation.id,
      text: '帮我设日报和周报',
    });
    let scheduleIds: string[] = [];
    await expect
      .poll(
        async () => {
          const { schedules } = (await rpc(page, 'schedules.list', {
            conversationId: alphaChat.conversation.id,
          })) as { schedules: Array<{ id: string; title: string }> };
          scheduleIds = ['日报', '周报'].map(
            (title) => schedules.find((entry) => entry.title === title)?.id ?? '',
          );
          return scheduleIds.every((id) => id.length > 0);
        },
        { timeout: 60_000 },
      )
      .toBe(true);
    const [daily, weekly] = scheduleIds as [string, string];

    // 管家出移交卡。
    await openChat(page, '管家');
    llm.script('mock-main', [
      step().replyToolCall('propose_handover', {
        from_bot_id: alpha.bot.id,
        to: { bot_id: beta.bot.id },
        items: [{ key: `schedule:${daily}` }, { key: `schedule:${weekly}` }],
        responsibilities: { to: '写日报', from: '' },
        handover_note: '日报每天 9 点发给用户。',
        note: '把阿尔法的定时任务交给贝塔',
      }),
    ]);
    await rpc(page, 'messages.send', {
      conversationId: butler.conversationId,
      text: '把阿尔法的日报交给贝塔',
    });
    const card = page.locator('[data-testid^="approval-card-"][data-approval-kind="bot_handover"]');
    await expect(card).toBeVisible({ timeout: 60_000 });
    await expect(card.locator('[data-testid="handover-direction"]')).toHaveText('阿尔法 → 贝塔');
    await expect(card.locator(`[data-testid="handover-item-schedule:${daily}"]`)).toContainText(
      '日报',
    );
    await expect(card.locator('[data-testid="handover-note"]')).toContainText('日报每天 9 点');
    await expect(card.locator('[data-testid="handover-item-resp:to"]')).toContainText('写日报');

    // 勾掉周报，确认。
    await card.locator(`[data-testid="handover-item-check-schedule:${weekly}"]`).uncheck();
    llm.script('mock-main', [step().replyText('日报已经交给贝塔了。')]);
    await card.locator('[data-testid="approval-approve"]').click();
    await expect(card).toHaveCount(0, { timeout: 15_000 });

    // 消息流里的进度卡：结束为已完成；勾掉的一项标未勾选。
    const progress = page.locator('[data-testid^="handover-progress-"]');
    await expect(progress).toBeVisible({ timeout: 30_000 });
    await expect(progress.locator('[data-testid="handover-status"]')).toHaveAttribute(
      'data-status',
      'completed',
      { timeout: 30_000 },
    );
    await expect(
      progress.locator(`[data-testid="handover-item-status-schedule:${daily}"]`),
    ).toHaveAttribute('data-status', 'done');
    await expect(
      progress.locator(`[data-testid="handover-item-status-schedule:${weekly}"]`),
    ).toHaveAttribute('data-status', 'notSelected');
    await expect(
      page.locator('[data-testid="bot-bubble"]').filter({ hasText: '日报已经交给贝塔了' }).first(),
    ).toBeVisible({ timeout: 60_000 });

    // 贝塔私聊：重建的回执卡 + 交接说明。
    await openChat(page, '贝塔');
    await expect(page.locator('[data-testid="handover-received"]')).toContainText(
      '从 阿尔法 接手了',
    );
    await expect(page.locator('[data-testid="handover-received-note"]')).toContainText(
      '日报每天 9 点',
    );
    await expect(
      page.locator('[data-testid="schedule-receipt"][data-schedule-status="active"]'),
    ).toContainText('日报');

    // 阿尔法私聊：原回执卡标已移交，周报不动；已移交提示。
    await openChat(page, '阿尔法');
    await expect(page.locator('[data-testid="schedule-receipt-handed-over"]')).toHaveText(
      '已移交给 贝塔',
    );
    await expect(
      page.locator('[data-testid="schedule-receipt"][data-schedule-status="active"]'),
    ).toContainText('周报');
    await expect(page.locator('[data-testid="handover-handed-over"]')).toContainText(
      '已移交给 贝塔',
    );
  } finally {
    await closeSession(session);
  }
});
