import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page, _electron } from '@playwright/test';
import { botProfile, startMockLlm, step, type MockLlmServer } from '@kepcup/testkit';
import { openConversationByName, rpc } from './helpers/create-bot';
import { rmHomeTolerant } from './helpers/home-cleanup';

/**
 * D88 移交卡（docs/design/37 §2.2，todo/bot-handover.md §3.6 / §3.7）：真实 core 栈里
 * 阿尔法用 schedule 工具建两条定时任务；管家 propose_handover 出一张「阿尔法 → 贝塔」
 * 移交卡（dock 里可逐项勾选）→ 勾掉一项确认 → 消息流里的进度卡逐项打勾、结束为已完成，
 * 勾掉的一项标「未勾选」；贝塔私聊出现重建的回执卡与交接说明，阿尔法的原回执卡标
 * 「已移交给 贝塔」。全程 mock LLM。
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
      TZ: 'Asia/Shanghai',
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
  await rmHomeTolerant(session.home);
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
    await openConversationByName(page, '管家');
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
    await openConversationByName(page, '贝塔');
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
    await openConversationByName(page, '阿尔法');
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

/**
 * D88 P1：普通 Bot 自己发起。阿尔法用 remember / schedule 工具记下两条记忆（其中一条
 * 「只告诉你」）与一条定时任务；阿尔法自己 inspect_bot_assets（memory_query）→ 私密记忆
 * 不在候选里 → propose_handover 把一条记忆与定时任务交给贝塔；dock 里的卡按组展示记忆
 * 与定时任务 → 确认 → 进度卡完成；贝塔的记忆里有副本，阿尔法的私密记忆没有过去。
 */
test('handover P1: a regular bot hands its own memory and schedule over', async () => {
  test.setTimeout(240_000);
  const session = await startSession('kepcup-e2e-handover-p1-');
  const { page, llm } = session;
  try {
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
    type MemoryList = { items: Array<{ id: string; content: string }> };

    llm.script('mock-main', [
      step().replyToolCall('remember', { content: '用户喜欢周报用三段式写', kind: 'preference' }),
      step().replyToolCall('remember', {
        content: '只告诉你：周报其实是外包写的',
        kind: 'fact',
        private_to_bot: true,
      }),
      step().replyToolCall('schedule', { when: '0 18 * * 5', title: '周报', note: '写周报' }),
      step().replyText('都记下了。'),
    ]);
    await rpc(page, 'messages.send', {
      conversationId: alphaChat.conversation.id,
      text: '记住我喜欢三段式周报，每周五提醒我写周报',
    });
    let weekly = '';
    let pref = '';
    let secret = '';
    await expect
      .poll(
        async () => {
          const { schedules } = (await rpc(page, 'schedules.list', {
            conversationId: alphaChat.conversation.id,
          })) as { schedules: Array<{ id: string; title: string }> };
          weekly = schedules.find((entry) => entry.title === '周报')?.id ?? '';
          const { items } = (await rpc(page, 'memory.list', { botId: alpha.bot.id })) as MemoryList;
          pref = items.find((item) => item.content.includes('三段式'))?.id ?? '';
          secret = items.find((item) => item.content.includes('外包'))?.id ?? '';
          return weekly.length > 0 && pref.length > 0 && secret.length > 0;
        },
        { timeout: 60_000 },
      )
      .toBe(true);

    // 阿尔法自己盘点、自己提交移交卡。
    await openConversationByName(page, '阿尔法');
    llm.script('mock-main', [
      step().replyToolCall('inspect_bot_assets', { memory_query: '周报' }),
      step()
        .expect((request) => {
          const text = JSON.stringify(request.body.messages);
          return text.includes(`memory:${pref}`) && !text.includes(`memory:${secret}`);
        })
        .replyToolCall('propose_handover', {
          to: { bot_id: beta.bot.id },
          items: [{ key: `memory:${pref}` }, { key: `schedule:${weekly}` }],
          handover_note: '用户喜欢三段式周报。',
        }),
    ]);
    await rpc(page, 'messages.send', {
      conversationId: alphaChat.conversation.id,
      text: '以后周报的事交给贝塔吧',
    });
    const card = page.locator('[data-testid^="approval-card-"][data-approval-kind="bot_handover"]');
    await expect(card).toBeVisible({ timeout: 60_000 });
    await expect(card.locator('[data-testid="handover-direction"]')).toHaveText('阿尔法 → 贝塔');
    await expect(card.locator('[data-testid="handover-group-memory"]')).toContainText('三段式');
    await expect(card.locator(`[data-testid="handover-item-check-memory:${pref}"]`)).toBeChecked();
    await expect(card.locator(`[data-testid="handover-item-schedule:${weekly}"]`)).toContainText(
      '周报',
    );

    llm.script('mock-main', [step().replyText('周报已经交给贝塔了。')]);
    await card.locator('[data-testid="approval-approve"]').click();
    await expect(card).toHaveCount(0, { timeout: 15_000 });
    const progress = page.locator('[data-testid^="handover-progress-"]');
    await expect(progress.locator('[data-testid="handover-status"]')).toHaveAttribute(
      'data-status',
      'completed',
      { timeout: 30_000 },
    );
    await expect(
      progress.locator(`[data-testid="handover-item-status-memory:${pref}"]`),
    ).toHaveAttribute('data-status', 'done');

    // 贝塔得到记忆副本；私密记忆没有过去；阿尔法的记忆原样保留。
    await expect
      .poll(async () => {
        const { items } = (await rpc(page, 'memory.list', { botId: beta.bot.id })) as MemoryList;
        return items.map((item) => item.content);
      })
      .toEqual(expect.arrayContaining(['用户喜欢周报用三段式写']));
    const betaItems = (await rpc(page, 'memory.list', { botId: beta.bot.id })) as MemoryList;
    expect(betaItems.items.some((item) => item.content.includes('外包'))).toBe(false);
    const alphaItems = (await rpc(page, 'memory.list', { botId: alpha.bot.id })) as MemoryList;
    expect(alphaItems.items.some((item) => item.id === pref)).toBe(true);
  } finally {
    await closeSession(session);
  }
});

/**
 * D88 P2：阿尔法有一本 Wiki（测试直接写进它的数据目录并 git 提交）；阿尔法自己
 * inspect_bot_assets（wiki_query）→ propose_handover 整本 Wiki 给贝塔 → dock 里的卡显示
 * Wiki 组 → 确认 → 后台作业复制完成后进度卡「已完成」、条目显示复制了几页 → 结果卡给出
 * 「删除 阿尔法」→ 走删除确认 → 阿尔法被删除；贝塔的 Wiki 里有这两页。
 */
test('handover P2: wiki copied in the background, then the retire button deletes the source', async () => {
  test.setTimeout(240_000);
  const session = await startSession('kepcup-e2e-handover-p2-');
  const { page, llm, home } = session;
  try {
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

    // 阿尔法的 Wiki：两页 + 一份被引用的原件，git 提交。
    const { execFileSync } = await import('node:child_process');
    const { mkdirSync, writeFileSync, realpathSync } = await import('node:fs');
    const wikiRoot = path.join(realpathSync(home), 'bots', alpha.bot.id, 'wiki');
    const files: Record<string, string> = {
      'SCHEMA.md': '# Wiki 维护规范\n',
      'index.md': '# 目录\n',
      'log.md': '# 变更日志\n',
      'pages/guide.md': '# 部署指南\n\n见 [原文](../raw/20261001-aaaaaaaaaaaa-guide.md)。\n',
      'pages/ops/runbook.md': '# 值班手册\n\n值班步骤。\n',
      'raw/20261001-aaaaaaaaaaaa-guide.md': '指南原文',
    };
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(wikiRoot, rel)), { recursive: true });
      writeFileSync(path.join(wikiRoot, rel), content);
    }
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
        cwd: wikiRoot,
      });
    git('init', '-q');
    git('add', '-A');
    git('commit', '-q', '-m', 'seed');

    await openConversationByName(page, '阿尔法');
    llm.script('mock-main', [
      step().replyToolCall('inspect_bot_assets', { wiki_query: '*' }),
      step()
        .expect((request) => JSON.stringify(request.body.messages).includes('wiki:pages/guide.md'))
        .replyToolCall('propose_handover', {
          to: { bot_id: beta.bot.id },
          items: [{ key: 'wiki:pages/' }],
          handover_note: '部署相关的资料都在 Wiki 里。',
        }),
      step()
        .expect((request) => JSON.stringify(request.body.messages).includes('移交处理结果'))
        .replyText('Wiki 已经复制给贝塔了。'),
    ]);
    await rpc(page, 'messages.send', {
      conversationId: alphaChat.conversation.id,
      text: '把你的 Wiki 交给贝塔吧',
    });
    const card = page.locator('[data-testid^="approval-card-"][data-approval-kind="bot_handover"]');
    await expect(card).toBeVisible({ timeout: 60_000 });
    await expect(card.locator('[data-testid="handover-group-wiki"]')).toContainText('整本 Wiki');
    await card.locator('[data-testid="approval-approve"]').click();
    await expect(card).toHaveCount(0, { timeout: 15_000 });

    const progress = page.locator('[data-testid^="handover-progress-"]');
    await expect(progress.locator('[data-testid="handover-status"]')).toHaveAttribute(
      'data-status',
      'completed',
      { timeout: 60_000 },
    );
    await expect(progress.locator('[data-testid="handover-item-copied"]')).toHaveText(
      '已复制 2 页',
    );
    const tree = (await rpc(page, 'wiki.tree', {
      owner: { kind: 'bot', id: beta.bot.id },
    })) as {
      pages: Array<{ path: string }>;
    };
    expect(tree.pages.map((entry) => entry.path).sort()).toEqual([
      'pages/guide.md',
      'pages/ops/runbook.md',
    ]);

    // 退役：全部完成 → 「删除 阿尔法」→ D18 删除确认 → 删除。
    const retire = progress.locator('[data-testid="handover-retire-button"]');
    await expect(retire).toHaveText(/删除 阿尔法/);
    await retire.click();
    const dialog = page.locator('[data-testid="handover-retire-dialog"]');
    await expect(dialog).toBeVisible();
    await dialog.locator('[data-testid="handover-retire-confirm"]').click();
    await expect
      .poll(
        async () => {
          const { bots } = (await rpc(page, 'bots.list')) as { bots: Array<{ id: string }> };
          return bots.some((bot) => bot.id === alpha.bot.id);
        },
        // 退役（删除）RPC 的级联在 windows 上慢（runs/jobs/wiki/browser wipe）。
        { timeout: 60_000 },
      )
      .toBe(false);
  } finally {
    await closeSession(session);
  }
});
