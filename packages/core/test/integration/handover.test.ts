import { afterEach, describe, expect, it } from 'vitest';
import {
  BOT_HANDED_OVER_EVENT,
  BOT_HANDOVER_EVENT,
  BOT_HANDOVER_FOLLOWUP_EVENT,
  SCHEDULE_CREATED_EVENT,
  botHandoverPayloadSchema,
  mailAlertDedupeKey,
  type Approval,
  type Bot,
  type Message,
} from '@kepcup/shared';
import {
  createTestStack,
  isTaskRequest,
  listAllMessages,
  makeBot,
  makeGroup,
  openDirect,
  sendBatch,
  step,
  waitFor,
  viaTask,
  waitForRun,
  type TestStack,
} from '@kepcup/testkit';
import type { MailService } from '../../src/mail/service.js';
import type { MailAccountRecord } from '../../src/mail/store.js';

/**
 * D88 Bot 资产移交 P0（docs/design/37，todo/bot-handover.md §3.7）：管家盘点 →
 * propose_handover 出一张移交卡（非阻塞、无人值守不自动批、可勾选）→ 确认后宿主按清单
 * 确定性执行（新建目标、邮箱先绑 B 再解 A 并改投排队提醒、连接应用共享、定时任务重建
 * 与原卡标记、职责改写、两侧交接说明）→ internal follow-up 通知管家。全程 mock LLM。
 */

const stacks: TestStack[] = [];

afterEach(async () => {
  for (const stack of stacks.splice(0)) await stack.cleanup();
});

async function start(): Promise<TestStack> {
  const stack = await createTestStack();
  stacks.push(stack);
  return stack;
}

function mailOf(stack: TestStack): MailService {
  const mail = stack.core.services.mail;
  if (mail === null) throw new Error('mail service not wired');
  return mail;
}

/** A mail account row without an IMAP session (no server needed: alerts are ingested directly). */
function seedMailAccount(stack: TestStack, id: string, address: string, botIds: string[]): void {
  const mail = mailOf(stack);
  const now = Date.now();
  const row: MailAccountRecord = {
    id,
    address,
    label: '工作邮箱',
    provider: 'custom',
    imapHost: '127.0.0.1',
    imapPort: 993,
    imapSecure: 'ssl',
    smtpHost: '127.0.0.1',
    smtpPort: 465,
    smtpSecure: 'ssl',
    username: address,
    mode: 'auto',
    pollIntervalSec: 300,
    status: 'paused',
    listen: null,
    lastUid: 10,
    uidValidity: null,
    unseenCount: null,
    lastError: null,
    lastOkAt: null,
    failureStreak: 0,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  mail.store.insert(row);
  mail.setBots(id, botIds);
}

function boundBots(stack: TestStack, accountId: string): string[] {
  return mailOf(stack)
    .store.bindings(accountId)
    .map((binding) => binding.botId);
}

function handoverApprovals(stack: TestStack, conversationId: string): Approval[] {
  return stack.core.services
    .domain!.approvals.list(conversationId)
    .filter((approval) => approval.kind === 'bot_handover');
}

async function pendingHandover(stack: TestStack, conversationId: string): Promise<Approval> {
  return waitFor(
    () => handoverApprovals(stack, conversationId).find((a) => a.status === 'pending') ?? null,
    { label: 'pending bot_handover card' },
  );
}

async function settled(stack: TestStack, approvalId: string) {
  const host = stack.core.services.handover!;
  return waitFor(
    () => {
      const view = host.view(approvalId);
      return view !== null && view.status !== 'proposed' && view.status !== 'applying'
        ? view
        : null;
    },
    { label: 'handover settled' },
  );
}

function eventsOf(messages: Message[], event: string): Message[] {
  return messages.filter(
    (message) =>
      message.kind === 'system_event' &&
      'event' in message.content &&
      message.content.event === event,
  );
}

async function ensureButler(stack: TestStack): Promise<{ butler: Bot; conversationId: string }> {
  const result = (await stack.core.rpc.call('butler.ensure', {})) as {
    bot: Bot;
    conversationId: string;
  };
  return { butler: result.bot, conversationId: result.conversationId };
}

async function botSaid(stack: TestStack, conversationId: string, text: string): Promise<void> {
  await waitFor(
    async () =>
      (await listAllMessages(stack.core, conversationId)).find(
        (m) => m.senderType === 'bot' && 'text' in m.content && m.content.text.includes(text),
      ) ?? null,
    { label: `bot reply「${text}」` },
  );
}

function toolNames(request: { body: Record<string, unknown> }): string[] {
  return ((request.body.tools ?? []) as Array<{ function: { name: string } }>).map(
    (tool) => tool.function.name,
  );
}

describe('bot asset handover (D88 P0)', () => {
  it('触发事件：管家把邮箱交给新建的 Bot——一张卡确认后 M 只绑新 Bot，两侧留痕，管家收到结果，新信只提醒新 Bot', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const { butler, conversationId } = await ensureButler(stack);
    seedMailAccount(stack, 'mal_work', 'work@example.com', [butler.id]);
    // 管家名下一条还在排队的提醒（免打扰停放）：移交时要改投新 Bot。
    const domain = core.services.domain!;
    const butlerDirect = conversationId;
    domain.jobs.enqueue({
      type: 'mail_alert',
      botId: butler.id,
      conversationId: butlerDirect,
      payload: {
        accountId: 'mal_work',
        botId: butler.id,
        uid: 9,
        key: mailAlertDedupeKey('mal_work', 9, butler.id),
        from: 'a@example.com',
        subject: '停放的信',
        date: '',
        snippet: '',
      },
      priority: 2,
      dedupeKey: mailAlertDedupeKey('mal_work', 9, butler.id),
      runAfter: Date.now() + 60 * 60 * 1000,
    });
    expect(mailOf(stack).contextSection(butler.id)).toContain('work@example.com');

    llm.script('mock-main', [
      step().replyToolCall('inspect_bot_assets', { bot_id: butler.id }),
      step()
        .expect((request) => JSON.stringify(request.body.messages).includes('mail:mal_work'))
        .replyToolCall('propose_handover', {
          from_bot_id: butler.id,
          to: {
            new_bot: {
              name: '邮件助理',
              bio: '专门处理邮件',
              expertise: '邮件',
              responsibilities: '负责 work@example.com 的收发与整理',
              reason: '用户想要一个专门管邮件的 Bot',
            },
          },
          items: [{ key: 'mail:mal_work' }],
          handover_note: '用户习惯每天 9 点看邮件摘要；发票类邮件转给财务。',
          note: '新建邮件助理并把邮箱交给它',
        }),
    ]);
    await sendBatch(core, conversationId, ['新建一个 Bot 专门管邮件，把你负责的邮箱交给它']);
    const approval = await pendingHandover(stack, conversationId);
    await waitForRun(core, conversationId, 'completed');

    // 工具面：对话轮的管家有两个移交工具。
    expect(toolNames(llm.requestsFor('mock-main')[0]!)).toEqual(
      expect.arrayContaining(['inspect_bot_assets', 'propose_handover', 'propose_bot']),
    );
    const payload = botHandoverPayloadSchema.parse(approval.payload);
    expect(payload.target).toMatchObject({
      kind: 'new',
      bot: { name: '邮件助理', model: 'inherit' },
    });
    expect(payload.items).toEqual([
      expect.objectContaining({ key: 'mail:mal_work', assetType: 'mail', action: 'move' }),
    ]);
    expect(payload.items[0]!.blocked).toBeUndefined();
    // 确认前什么都没变。
    expect(boundBots(stack, 'mal_work')).toEqual([butler.id]);
    expect(domain.bots.listActive().map((bot) => bot.name)).not.toContain('邮件助理');

    llm.script('mock-main', [step().replyText('邮件助理建好了，邮箱也交给它了。')]);
    const decided = (await core.rpc.call('approvals.decide', {
      id: approval.id,
      approve: true,
      handoverSelection: ['mail:mal_work'],
    })) as { approval: Approval };
    expect(decided.approval.status).toBe('approved');
    const view = await settled(stack, approval.id);
    expect(view.status).toBe('completed');

    const helper = domain.bots.listActive().find((bot) => bot.name === '邮件助理')!;
    expect(helper).toBeDefined();
    expect(view.toBotId).toBe(helper.id);
    expect(helper.profile.role.responsibilities).toBe('负责 work@example.com 的收发与整理');
    // 新 Bot 继承管家当下的模型设置。
    expect(helper.profile.runtime.model).toBe(butler.profile.runtime.model);
    // M 只绑新 Bot；管家的 <mail_accounts> 段消失。
    expect(boundBots(stack, 'mal_work')).toEqual([helper.id]);
    expect(mailOf(stack).contextSection(butler.id)).toBe('');
    expect(mailOf(stack).contextSection(helper.id)).toContain('work@example.com');

    // 排队中的提醒改投新 Bot，旧作业取消。
    const jobs = core.services
      .mainDb!.prepare(
        "select bot_id, status, dedupe_key from jobs where type = 'mail_alert' order by created_at",
      )
      .all() as Array<{ bot_id: string; status: string; dedupe_key: string }>;
    expect(jobs).toEqual([
      {
        bot_id: butler.id,
        status: 'cancelled',
        dedupe_key: mailAlertDedupeKey('mal_work', 9, butler.id),
      },
      {
        bot_id: helper.id,
        status: 'pending',
        dedupe_key: mailAlertDedupeKey('mal_work', 9, helper.id),
      },
    ]);

    // 两侧交接说明。
    const helperDirect = domain.conversations.listDirectByBot(helper.id)[0]!;
    const helperNotes = eventsOf(await listAllMessages(core, helperDirect.id), BOT_HANDOVER_EVENT);
    expect(helperNotes).toHaveLength(1);
    expect(helperNotes[0]!.content).toMatchObject({
      handover: {
        fromBotId: butler.id,
        toBotId: helper.id,
        note: '用户习惯每天 9 点看邮件摘要；发票类邮件转给财务。',
      },
    });
    const butlerNotes = eventsOf(await listAllMessages(core, butlerDirect), BOT_HANDED_OVER_EVENT);
    expect(butlerNotes).toHaveLength(1);
    // 管家收到 internal follow-up，并据此回复用户。
    const followUp = await waitFor(
      async () =>
        eventsOf(await listAllMessages(core, butlerDirect), BOT_HANDOVER_FOLLOWUP_EVENT)[0],
    );
    expect(followUp.content).toMatchObject({ internal: true });
    expect((followUp.content as { text: string }).text).toContain('邮件助理');
    await waitFor(async () =>
      (await listAllMessages(core, butlerDirect)).find(
        (m) =>
          m.senderType === 'bot' &&
          'text' in m.content &&
          m.content.text.includes('邮件助理建好了'),
      ),
    );
    // 管家下一轮的上下文里有「已移交」记录（包 untrusted），没有邮箱段。
    const lastButlerRequest = JSON.stringify(llm.requestsFor('mock-main').at(-1)!.body.messages);
    expect(lastButlerRequest).toContain('已把以下事项移交给 邮件助理');
    expect(lastButlerRequest).not.toContain('<mail_accounts>');

    // 新信只给新 Bot 入队 mail_alert。
    llm.script('mock-main', [step().replyText('收到新邮件。')]);
    mailOf(stack).ingest('mal_work', [
      {
        uid: 11,
        from: 'boss@example.com',
        to: ['work@example.com'],
        subject: '新信',
        date: '',
        text: 'hello',
        attachments: [],
      },
    ]);
    const fresh = core.services
      .mainDb!.prepare(
        "select bot_id from jobs where type = 'mail_alert' and dedupe_key like 'mail:mal_work:11:%'",
      )
      .all() as Array<{ bot_id: string }>;
    expect(fresh).toEqual([{ bot_id: helper.id }]);
  }, 40_000);

  it('已有目标：连接应用共享（A 保留）、私聊定时任务在 B 私聊重建并出回执卡、A 的原卡标已移交；群任务 B 不在群里置灰；职责改写', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const { conversationId } = await ensureButler(stack);
    const domain = core.services.domain!;
    const alpha = await makeBot(core, '阿尔法');
    const beta = await makeBot(core, '贝塔');
    const other = await makeBot(core, '路人');
    core.services.apps!.store.create({
      id: 'conn_nt',
      connectorId: 'notion',
      label: 'me',
      serverUrl: 'https://mcp.notion.test/mcp',
      status: 'connected',
    });
    await core.rpc.call('bots.update', {
      id: alpha.id,
      profile: {
        ...alpha.profile,
        role: { ...alpha.profile.role, responsibilities: '写日报；管 Notion 笔记' },
        runtime: { ...alpha.profile.runtime, app_connection_ids: ['conn_nt'] },
      },
    });
    const alphaDirect = await openDirect(core, alpha.id);
    const group = await makeGroup(core, '周报群', [alpha.id, other.id]);
    const schedules = core.services.schedules!;
    const daily = schedules.createFromWhen({
      botId: alpha.id,
      conversationId: alphaDirect.id,
      when: '0 9 * * *',
      title: '日报',
      note: '整理昨天的工作写日报',
      origin: 'tool',
    });
    const weekly = schedules.createFromWhen({
      botId: alpha.id,
      conversationId: group.id,
      when: '0 10 * * 1',
      title: '周报',
      note: '汇总本周进展',
      origin: 'tool',
    });

    llm.script('mock-main', [
      step().replyToolCall('propose_handover', {
        from_bot_id: alpha.id,
        to: { bot_id: beta.id },
        items: [
          { key: 'app:conn_nt' },
          { key: `schedule:${daily.id}` },
          { key: `schedule:${weekly.id}` },
        ],
        responsibilities: { to: '写日报；用 Notion 记笔记', from: '管 Notion 笔记' },
        handover_note: '日报每天 9 点发给用户。',
      }),
    ]);
    await sendBatch(core, conversationId, ['把阿尔法的 Notion 连接和日报定时交给贝塔']);
    const approval = await pendingHandover(stack, conversationId);
    const payload = botHandoverPayloadSchema.parse(approval.payload);
    expect(payload.items.find((item) => item.key === 'app:conn_nt')).toMatchObject({
      action: 'share',
    });
    expect(payload.items.find((item) => item.key === `schedule:${weekly.id}`)?.blocked).toContain(
      '不在群',
    );
    expect(payload.responsibilities).toMatchObject({
      to: '写日报；用 Notion 记笔记',
      from: '管 Notion 笔记',
      fromBefore: '写日报；管 Notion 笔记',
    });
    // 置灰的条目不能勾选。
    await expect(
      core.rpc.call('approvals.decide', {
        id: approval.id,
        approve: true,
        handoverSelection: [`schedule:${weekly.id}`],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    llm.script('mock-main', [step().replyText('交接完成。')]);
    await core.rpc.call('approvals.decide', { id: approval.id, approve: true });
    const view = await settled(stack, approval.id);
    expect(view.status).toBe('completed');

    const alphaNow = domain.bots.get(alpha.id)!;
    const betaNow = domain.bots.get(beta.id)!;
    // 共享：A 保留，B 获得。
    expect(alphaNow.profile.runtime.app_connection_ids).toEqual(['conn_nt']);
    expect(betaNow.profile.runtime.app_connection_ids).toEqual(['conn_nt']);
    expect(betaNow.profile.role.responsibilities).toBe('写日报；用 Notion 记笔记');
    expect(alphaNow.profile.role.responsibilities).toBe('管 Notion 笔记');
    // 日报：A 侧取消，在 B 私聊重建（原字段）；群里的周报不动。
    expect(schedules.store.get(daily.id)!.status).toBe('cancelled');
    expect(schedules.store.get(weekly.id)!.status).toBe('active');
    const betaDirect = domain.conversations.listDirectByBot(beta.id)[0]!;
    const rebuilt = schedules.listForBotInConversation(beta.id, betaDirect.id);
    expect(rebuilt).toHaveLength(1);
    expect(rebuilt[0]).toMatchObject({
      kind: 'cron',
      cron: '0 9 * * *',
      title: '日报',
      note: '整理昨天的工作写日报',
      origin: 'tool',
    });
    const betaReceipts = eventsOf(
      await listAllMessages(core, betaDirect.id),
      SCHEDULE_CREATED_EVENT,
    );
    expect(
      betaReceipts.map((m) => (m.content as { schedule?: { id: string } }).schedule?.id),
    ).toContain(rebuilt[0]!.id);
    const alphaReceipt = eventsOf(
      await listAllMessages(core, alphaDirect.id),
      SCHEDULE_CREATED_EVENT,
    ).find((m) => (m.content as { schedule?: { id: string } }).schedule?.id === daily.id)!;
    expect(alphaReceipt.content).toMatchObject({
      text: expect.stringContaining('已移交给 贝塔'),
      schedule: { status: 'cancelled', handedOverTo: { botId: beta.id, name: '贝塔' } },
    });
    // 两侧留痕。
    expect(eventsOf(await listAllMessages(core, betaDirect.id), BOT_HANDOVER_EVENT)).toHaveLength(
      1,
    );
    expect(
      eventsOf(await listAllMessages(core, alphaDirect.id), BOT_HANDED_OVER_EVENT),
    ).toHaveLength(1);
  }, 40_000);

  it('勾掉一项只执行剩余项；拒绝什么都不变并通知「未采纳」；无人值守不自动批', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const { conversationId } = await ensureButler(stack);
    await core.rpc.call('unattended.enable', { acknowledgeRisk: true });
    const alpha = await makeBot(core, '阿尔法');
    const beta = await makeBot(core, '贝塔');
    seedMailAccount(stack, 'mal_a', 'a@example.com', [alpha.id]);
    seedMailAccount(stack, 'mal_b', 'b@example.com', [alpha.id]);
    const propose = () =>
      step().replyToolCall('propose_handover', {
        from_bot_id: alpha.id,
        to: { bot_id: beta.id },
        items: [{ key: 'mail:mal_a' }, { key: 'mail:mal_b', action: 'share' }],
        handover_note: '两个邮箱。',
      });

    llm.script('mock-main', [propose()]);
    await sendBatch(core, conversationId, ['把阿尔法的两个邮箱交给贝塔']);
    const first = await pendingHandover(stack, conversationId);
    // 无人值守：照常挂起等用户。
    expect(first.autoApproved).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(core.services.domain!.approvals.get(first.id)!.status).toBe('pending');

    // 拒绝：什么都不变，管家收到「未采纳」。
    llm.script('mock-main', [step().replyText('好的，不移交了。')]);
    const denied = (await core.rpc.call('approvals.decide', { id: first.id, approve: false })) as {
      approval: Approval;
    };
    expect(denied.approval.status).toBe('denied');
    const followUp = await waitFor(
      async () =>
        eventsOf(await listAllMessages(core, conversationId), BOT_HANDOVER_FOLLOWUP_EVENT)[0],
    );
    expect((followUp.content as { text: string }).text).toContain('没有采纳');
    expect(boundBots(stack, 'mal_a')).toEqual([alpha.id]);
    expect(core.services.handover!.view(first.id)?.status).toBe('denied');
    await botSaid(stack, conversationId, '不移交了');

    // 再提一次，只勾 mal_b（共享）。
    llm.script('mock-main', [propose()]);
    await sendBatch(core, conversationId, ['还是交吧']);
    const second = await pendingHandover(stack, conversationId);
    llm.script('mock-main', [step().replyText('已共享 b 邮箱。')]);
    await core.rpc.call('approvals.decide', {
      id: second.id,
      approve: true,
      handoverSelection: ['mail:mal_b'],
    });
    const view = await settled(stack, second.id);
    expect(view.status).toBe('completed');
    await botSaid(stack, conversationId, '已共享 b 邮箱');
    expect(view.items.map((item) => item.key)).not.toContain('mail:mal_a');
    expect(boundBots(stack, 'mal_a')).toEqual([alpha.id]);
    expect(boundBots(stack, 'mal_b').sort()).toEqual([alpha.id, beta.id].sort());

    // 一项不留（目标已有）= 拒绝。
    llm.script('mock-main', [propose()]);
    await sendBatch(core, conversationId, ['再来一次']);
    const third = await pendingHandover(stack, conversationId);
    llm.script('mock-main', [step().replyText('明白。')]);
    const empty = (await core.rpc.call('approvals.decide', {
      id: third.id,
      approve: true,
      handoverSelection: [],
    })) as { approval: Approval };
    expect(empty.approval.status).toBe('denied');
  }, 40_000);

  it('编造的 key 被退回；同一对话已有待定卡时不能叠加；普通 Bot 与任务里没有移交工具', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const { conversationId } = await ensureButler(stack);
    const alpha = await makeBot(core, '阿尔法');
    const beta = await makeBot(core, '贝塔');
    seedMailAccount(stack, 'mal_a', 'a@example.com', [alpha.id]);

    llm.script('mock-main', [
      step().replyToolCall('propose_handover', {
        from_bot_id: alpha.id,
        to: { bot_id: beta.id },
        items: [{ key: 'mail:mal_made_up' }],
        handover_note: '编的。',
      }),
      step()
        .expect((request) =>
          JSON.stringify(request.body.messages).includes('不在 阿尔法 当下的资产里'),
        )
        .replyToolCall('propose_handover', {
          from_bot_id: alpha.id,
          to: { bot_id: beta.id },
          items: [{ key: 'mail:mal_a' }],
          handover_note: '真的。',
        }),
    ]);
    await sendBatch(core, conversationId, ['把阿尔法的邮箱交给贝塔']);
    const pending = await pendingHandover(stack, conversationId);
    await waitForRun(core, conversationId, 'completed');

    // 叠加：第二张移交卡与管家提议卡都被拒。
    llm.script('mock-main', [
      step().replyToolCall('propose_handover', {
        from_bot_id: alpha.id,
        to: { bot_id: beta.id },
        items: [{ key: 'mail:mal_a' }],
        handover_note: '再来一张。',
      }),
      step().replyToolCall('propose_bot', {
        bot: { name: '新人', bio: '', expertise: '', responsibilities: '打杂', reason: '' },
      }),
      step().replyText('等你先处理上一张卡。'),
    ]);
    await sendBatch(core, conversationId, ['再交一次']);
    await waitFor(async () =>
      (await listAllMessages(core, conversationId)).find(
        (m) => m.senderType === 'bot' && 'text' in m.content && m.content.text.includes('上一张卡'),
      ),
    );
    expect(handoverApprovals(stack, conversationId).filter((a) => a.status === 'pending')).toEqual([
      expect.objectContaining({ id: pending.id }),
    ]);
    const stacked = JSON.stringify(llm.requestsFor('mock-main').at(-1)!.body.messages);
    expect(stacked).toContain('已有一张移交卡或提议卡在等用户确认');
    expect(stacked).toContain('已有一张提议卡在等用户确认');

    // 普通 Bot：对话轮没有移交工具。
    const plain = await openDirect(core, alpha.id);
    llm.script('mock-main', [step().replyText('好的。')]);
    await sendBatch(core, plain.id, ['你好']);
    await waitForRun(core, plain.id, 'completed');
    const plainTools = toolNames(llm.requestsFor('mock-main').at(-1)!);
    expect(plainTools).toContain('list_bots');
    expect(plainTools).not.toContain('inspect_bot_assets');
    expect(plainTools).not.toContain('propose_handover');
  }, 40_000);

  it('任务里没有移交工具，提示词是任务版', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const { conversationId } = await ensureButler(stack);
    llm.script('mock-main', [
      ...viaTask({
        title: '规划移交',
        instruction: '看看该怎么移交',
        writes: false,
        taskSteps: [step().replyText('建议把邮箱交给邮件助理。')],
        relay: '建议已整理。',
      }),
    ]);
    await sendBatch(core, conversationId, ['研究一下怎么移交']);
    await waitFor(
      () => llm.requestsFor('mock-main').find((request) => isTaskRequest(request)) ?? null,
    );
    const taskRequest = llm.requestsFor('mock-main').find((request) => isTaskRequest(request))!;
    expect(toolNames(taskRequest)).not.toContain('propose_handover');
    expect(toolNames(taskRequest)).not.toContain('inspect_bot_assets');
    expect(JSON.stringify(taskRequest.body.messages)).toContain(
      '资产移交（inspect_bot_assets / propose_handover）都在对话轮工具面',
    );
  }, 40_000);

  it('崩溃恢复：执行到一半中断，recover() 继续剩余项，已生效的项不重复（邮箱不重复绑定、定时任务不重复建）', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const { conversationId } = await ensureButler(stack);
    const domain = core.services.domain!;
    const alpha = await makeBot(core, '阿尔法');
    const beta = await makeBot(core, '贝塔');
    seedMailAccount(stack, 'mal_a', 'a@example.com', [alpha.id]);
    const alphaDirect = await openDirect(core, alpha.id);
    const schedules = core.services.schedules!;
    const daily = schedules.createFromWhen({
      botId: alpha.id,
      conversationId: alphaDirect.id,
      when: '0 9 * * *',
      title: '日报',
      note: '写日报',
      origin: 'tool',
    });
    llm.script('mock-main', [
      step().replyToolCall('propose_handover', {
        from_bot_id: alpha.id,
        to: { bot_id: beta.id },
        items: [{ key: 'mail:mal_a' }, { key: `schedule:${daily.id}` }],
        handover_note: '交给你了。',
      }),
    ]);
    await sendBatch(core, conversationId, ['把阿尔法的邮箱和日报交给贝塔']);
    const approval = await pendingHandover(stack, conversationId);
    await waitForRun(core, conversationId, 'completed');
    const handoverId = botHandoverPayloadSchema.parse(approval.payload).handoverId;

    // 模拟「批准后执行到一半崩溃」：卡已批准、条目已落库为 pending；邮箱与定时任务其实
    // 已经生效（apply 完成、还没来得及记账）。
    const db = core.services.mainDb!;
    db.prepare("update approvals set status = 'approved', decided_at = ? where id = ?").run(
      Date.now(),
      approval.id,
    );
    const now = Date.now();
    for (const [key, type, action] of [
      ['mail:mal_a', 'mail', 'move'],
      [`schedule:${daily.id}`, 'schedule', 'move'],
      ['note:handover', 'note', 'write'],
    ] as const) {
      db.prepare(
        `insert into bot_handover_items (handover_id, key, asset_type, action, status, updated_at)
         values (?, ?, ?, ?, 'pending', ?)`,
      ).run(handoverId, key, type, action, now);
    }
    db.prepare("update bot_handovers set status = 'applying' where id = ?").run(handoverId);
    mailOf(stack).addBinding('mal_a', beta.id);
    mailOf(stack).removeBinding('mal_a', alpha.id);
    const betaDirect = await openDirect(core, beta.id);
    schedules.transferTo(daily.id, {
      botId: beta.id,
      botName: '贝塔',
      conversationId: betaDirect.id,
    });

    llm.script('mock-main', [step().replyText('恢复后完成了。')]);
    core.services.handover!.recover();
    const view = await settled(stack, approval.id);
    expect(view.status).toBe('completed');
    expect(view.items.every((item) => item.status === 'done')).toBe(true);
    expect(boundBots(stack, 'mal_a')).toEqual([beta.id]);
    expect(schedules.listForBotInConversation(beta.id, betaDirect.id)).toHaveLength(1);
    expect(eventsOf(await listAllMessages(core, betaDirect.id), BOT_HANDOVER_EVENT)).toHaveLength(
      1,
    );
    // 再恢复一次：什么都不重复。
    core.services.handover!.recover();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(eventsOf(await listAllMessages(core, betaDirect.id), BOT_HANDOVER_EVENT)).toHaveLength(
      1,
    );
    expect(domain.bots.listActive().filter((bot) => bot.name === '贝塔')).toHaveLength(1);
  }, 40_000);

  it('重启后待定的移交卡取消，对应移交记为 cancelled', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const { conversationId } = await ensureButler(stack);
    const alpha = await makeBot(core, '阿尔法');
    const beta = await makeBot(core, '贝塔');
    seedMailAccount(stack, 'mal_a', 'a@example.com', [alpha.id]);
    llm.script('mock-main', [
      step().replyToolCall('propose_handover', {
        from_bot_id: alpha.id,
        to: { bot_id: beta.id },
        items: [{ key: 'mail:mal_a' }],
        handover_note: '交给你了。',
      }),
    ]);
    await sendBatch(core, conversationId, ['把阿尔法的邮箱交给贝塔']);
    const approval = await pendingHandover(stack, conversationId);
    await waitForRun(core, conversationId, 'completed');
    // 启动恢复：审批先全部取消（无回调），再由 recover() 收尾。
    core.services.domain!.approvals.cancelAllPending();
    core.services.handover!.recover();
    expect(core.services.handover!.view(approval.id)?.status).toBe('cancelled');
    expect(boundBots(stack, 'mal_a')).toEqual([alpha.id]);
  }, 40_000);

  it('propose_bot 可指定模型（可用列表里的 ref），不在列表里的被退回', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const { conversationId } = await ensureButler(stack);
    // 与 Bot 详情模型下拉同源：只有存了 Key 的厂商的模型才可选。
    expect(core.services.handover!.modelOptions()).toEqual([]);
    await core.rpc.call('providers.setKey', { provider: 'custom:mock', key: 'sk-test' });
    const options = core.services.handover!.modelOptions();
    expect(options.length).toBeGreaterThan(0);
    const ref = options[0]!.ref;
    llm.script('mock-main', [
      step().replyToolCall('propose_bot', {
        bot: {
          name: '甲',
          bio: '',
          expertise: '',
          responsibilities: '干活',
          reason: '',
          model: 'nope/none',
        },
      }),
      step()
        .expect((request) => JSON.stringify(request.body.messages).includes('不在可用模型列表里'))
        .replyToolCall('propose_bot', {
          bot: {
            name: '甲',
            bio: '',
            expertise: '',
            responsibilities: '干活',
            reason: '',
            model: ref,
          },
        }),
    ]);
    await sendBatch(core, conversationId, ['建一个用某模型的 Bot']);
    const approval = await waitFor(
      () =>
        core.services
          .domain!.approvals.list(conversationId)
          .find((a) => a.kind === 'butler_proposal' && a.status === 'pending') ?? null,
    );
    await waitForRun(core, conversationId, 'completed');
    llm.script('mock-main', [step().replyText('建好了。')]);
    await core.rpc.call('approvals.decide', { id: approval.id, approve: true });
    const created = await waitFor(
      () => core.services.domain!.bots.listActive().find((bot) => bot.name === '甲') ?? null,
    );
    expect(created.profile.runtime.model).toBe(ref);
  }, 40_000);
});
