import { afterEach, describe, expect, it } from 'vitest';
import {
  BUTLER_PROPOSAL_FOLLOWUP_EVENT,
  type Approval,
  type Bot,
  type Message,
} from '@kepcup/shared';
import {
  createTestStack,
  listAllMessages,
  makeBot,
  openDirect,
  sendBatch,
  step,
  waitFor,
  waitForRun,
  type TestStack,
} from '@kepcup/testkit';
import { BUTLER_SETUP_FIRST_QUESTION } from '../../src/domain/butler.js';

/**
 * 管家入职与组队（D70，docs/design/27 §2.2，todo P2）：管家访谈是对话式
 * 新建访谈的变体（ask_question + propose_team，无 save_profile、无目录闸门）；
 * butler_proposal 审批卡非阻塞、无人值守不自动批、可勾掉条目；确认后宿主
 * 确定性创建并以 internal follow-up 通知管家。全程 mock LLM。
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

const TEAM = [
  {
    name: '文书',
    bio: '起草与润色文档',
    expertise: '写作',
    responsibilities: '周报、方案与邮件的起草和润色',
    reason: '你每周都要写周报',
  },
  {
    name: '码农',
    bio: '写代码、修 Bug',
    expertise: '编程',
    responsibilities: '读写项目代码、跑命令、排查问题',
    reason: '你提到在维护一个后端服务',
  },
  {
    name: '研究员',
    bio: '查资料、做调研',
    expertise: '调研',
    responsibilities: '检索资料、交叉验证、整理结论',
    reason: '你常需要做技术选型调研',
  },
];

async function startButlerInterview(
  stack: TestStack,
): Promise<{ butler: Bot; conversationId: string }> {
  const result = (await stack.core.rpc.call('butler.ensure', { interview: true })) as {
    bot: Bot;
    conversationId: string;
  };
  return { butler: result.bot, conversationId: result.conversationId };
}

function butlerApprovals(stack: TestStack, conversationId: string): Approval[] {
  return stack.core.services
    .domain!.approvals.list(conversationId)
    .filter((a) => a.kind === 'butler_proposal');
}

function plainBots(stack: TestStack): Bot[] {
  return stack.core.services.domain!.bots.listActive().filter((b) => b.systemRole !== 'butler');
}

/** Drives the interview to a pending propose_team card. */
async function proposeTeam(stack: TestStack): Promise<{
  butler: Bot;
  conversationId: string;
  approval: Approval;
}> {
  const { core, llm } = stack;
  const { butler, conversationId } = await startButlerInterview(stack);
  llm.script('mock-main', [step().replyToolCall('propose_team', { bots: TEAM, note: '按你说的场景' })]);
  await core.rpc.call('bots.interview.answer', { conversationId, text: '工作：编程与技术' });
  const approval = await waitFor(
    () => butlerApprovals(stack, conversationId).find((a) => a.status === 'pending') ?? null,
    { label: 'pending butler proposal' },
  );
  await waitForRun(core, conversationId, 'completed');
  return { butler, conversationId, approval };
}

describe('butler interview + team proposal (D70 P2)', () => {
  it('新用户：管家进入访谈，首问是管家版；首答直接投递（无目录闸门），工具面是访谈变体', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const { butler, conversationId } = await startButlerInterview(stack);
    expect(butler.setupState).toBe('interviewing');
    const all = await listAllMessages(core, conversationId);
    const card = all.find((m) => m.kind === 'system_event');
    expect(card?.content).toMatchObject({
      event: 'bot_setup_question',
      text: BUTLER_SETUP_FIRST_QUESTION,
    });

    llm.script('mock-main', [
      step().replyToolCall('ask_question', {
        acknowledgement: '好的。',
        question: '你最常做的是哪类任务？',
        options: ['写代码', '写文档'],
      }),
    ]);
    await core.rpc.call('bots.interview.answer', { conversationId, text: '工作：编程与技术' });
    await waitForRun(core, conversationId, 'completed');

    // 无目录卡：首答直接开跑。
    const after = await listAllMessages(core, conversationId);
    expect(after.some((m) => 'event' in m.content && m.content.event === 'bot_setup_path_question')).toBe(
      false,
    );
    const request = llm.requestsFor('mock-main')[0]!;
    const tools = (request.body.tools as Array<{ function: { name: string } }>).map(
      (tool) => tool.function.name,
    );
    expect(tools).toEqual(
      expect.arrayContaining(['ask_question', 'finish_setup', 'propose_team', 'list_bots']),
    );
    expect(tools).not.toContain('save_profile');
    const prompt = JSON.stringify(request.body.messages);
    expect(prompt).toContain('<butler_rules>');
    expect(prompt).toContain('入门访谈');
  }, 30_000);

  it('propose_team：卡片挂起、零新 Bot、访谈结束；勾掉一项确认后只建剩余项并通知管家', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const { butler, conversationId, approval } = await proposeTeam(stack);

    // 未确认：零领域 Bot；访谈态已清；run 以 terminate 结束（无终回复气泡）。
    expect(plainBots(stack)).toHaveLength(0);
    expect(core.services.domain!.bots.get(butler.id)!.setupState ?? null).toBeNull();
    expect(approval.payload).toMatchObject({ proposalType: 'team' });

    llm.script('mock-main', [step().replyText('团队建好了，去找他们聊吧。')]);
    const decided = (await core.rpc.call('approvals.decide', {
      id: approval.id,
      approve: true,
      selection: [0, 2],
    })) as { approval: Approval };
    expect(decided.approval.status).toBe('approved');
    expect(decided.approval.decision?.selection).toEqual([0, 2]);

    const created = await waitFor(() => (plainBots(stack).length === 2 ? plainBots(stack) : null));
    expect(created.map((b) => b.name).sort()).toEqual(['文书', '研究员'].sort());
    const writer = created.find((b) => b.name === '文书')!;
    expect(writer.profile.role.responsibilities).toBe(TEAM[0]!.responsibilities);
    expect(writer.bio).toBe(TEAM[0]!.bio);
    expect(writer.avatar).toMatch(/^preset:/);
    // 新联系人的私聊已打开（左栏可见）。
    expect(core.services.domain!.conversations.listDirectByBot(writer.id)).toHaveLength(1);

    // internal follow-up 唤醒管家（不进用户可见消息流）。
    const followUp = await waitFor(async () =>
      (await listAllMessages(core, conversationId)).find(
        (m) => 'event' in m.content && m.content.event === BUTLER_PROPOSAL_FOLLOWUP_EVENT,
      ),
    );
    expect(followUp.content).toMatchObject({ internal: true });
    expect((followUp.content as { text: string }).text).toContain('文书');
    await waitFor(async () =>
      (await listAllMessages(core, conversationId)).find(
        (m: Message) =>
          m.senderType === 'bot' && 'text' in m.content && m.content.text.includes('团队建好了'),
      ),
    );
  }, 30_000);

  it('确认后新 Bot 的私聊实时推给左栏：conversation.updated 负载带 bot（不刷新即可见）', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const { approval } = await proposeTeam(stack);
    const pushed: Array<{ id: string; directBotId: string | null; bot: Bot | null | undefined }> = [];
    const off = core.onEvent('conversation.updated', ({ conversation }) => {
      pushed.push({
        id: conversation.id,
        directBotId: conversation.directBotId,
        bot: conversation.bot,
      });
    });

    llm.script('mock-main', [step().replyText('团队建好了。')]);
    await core.rpc.call('approvals.decide', { id: approval.id, approve: true });
    const created = await waitFor(() => (plainBots(stack).length === 3 ? plainBots(stack) : null));
    off();

    for (const bot of created) {
      const [direct] = core.services.domain!.conversations.listDirectByBot(bot.id);
      const event = pushed.find((p) => p.id === direct!.id);
      // renderer 把「单聊无 bot」视为已删除而丢弃——负载必须带上新 Bot。
      expect(event?.directBotId).toBe(bot.id);
      expect(event?.bot).toMatchObject({ id: bot.id, name: bot.name, status: 'active' });
    }
  }, 30_000);

  it('拒绝 / 一项不留：零新 Bot；可以再次提议；同一时间只允许一张待确认提议', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const { conversationId, approval } = await proposeTeam(stack);

    llm.script('mock-main', [
      // 第二张提议在第一张待确认时被拒（工具报错），模型随后正常收尾。
      step().replyToolCall('propose_bot', { bot: TEAM[0] }),
      step().replyText('好的，等你先处理上一张卡。'),
    ]);
    await sendBatch(core, conversationId, ['再给我加一个写作 Bot']);
    await waitFor(async () =>
      (await listAllMessages(core, conversationId)).find(
        (m) => m.senderType === 'bot' && 'text' in m.content && m.content.text.includes('上一张卡'),
      ),
    );
    expect(butlerApprovals(stack, conversationId)).toHaveLength(1);

    // 一项不留的「确认」等同拒绝。
    llm.script('mock-main', [step().replyText('明白，那我们再看看需要什么。')]);
    const decided = (await core.rpc.call('approvals.decide', {
      id: approval.id,
      approve: true,
      selection: [],
    })) as { approval: Approval };
    expect(decided.approval.status).toBe('denied');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(plainBots(stack)).toHaveLength(0);

    // 越界的勾选被拒绝。
    llm.script('mock-main', [step().replyToolCall('propose_team', { bots: TEAM })]);
    await sendBatch(core, conversationId, ['还是按刚才的来吧']);
    const second = await waitFor(
      () => butlerApprovals(stack, conversationId).find((a) => a.status === 'pending') ?? null,
    );
    await expect(
      core.rpc.call('approvals.decide', { id: second.id, approve: true, selection: [5] }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(core.services.domain!.approvals.get(second.id)!.status).toBe('pending');
  }, 40_000);

  it('无人值守模式：butler_proposal 不自动批准，照常挂起等用户', async () => {
    const stack = await start();
    const { core } = stack;
    await core.rpc.call('unattended.enable', { acknowledgeRisk: true });
    const { approval } = await proposeTeam(stack);
    expect(approval.status).toBe('pending');
    expect(approval.autoApproved).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(plainBots(stack)).toHaveLength(0);
  }, 30_000);

  it('普通 Bot：有只读 list_bots，没有 propose_*；list_bots 返回其他 Bot 名片', async () => {
    const stack = await start();
    const { core, llm } = stack;
    await stack.core.rpc.call('butler.ensure', {});
    const other = await makeBot(core, '老王');
    const bot = await makeBot(core, '小艾');
    const conv = await openDirect(core, bot.id);
    llm.script('mock-main', [step().replyToolCall('list_bots', {}), step().replyText('查到了。')]);
    await sendBatch(core, conv.id, ['通讯录里都有谁？']);
    await waitForRun(core, conv.id, 'completed');
    const requests = llm.requestsFor('mock-main');
    const tools = (requests[0]!.body.tools as Array<{ function: { name: string } }>).map(
      (tool) => tool.function.name,
    );
    expect(tools).toContain('list_bots');
    expect(tools).not.toContain('propose_team');
    expect(tools).not.toContain('propose_bot');
    expect(tools).not.toContain('propose_group');
    const toolResult = JSON.stringify(requests[1]!.body.messages);
    expect(toolResult).toContain(other.id);
    expect(toolResult).toContain('（管家）');
    expect(toolResult).not.toContain(`${bot.id} |`);
  }, 30_000);

  it('propose_group：确认后建群（含定位描述与成员）', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const { conversationId } = (await core.rpc.call('butler.ensure', {})) as {
      conversationId: string;
    };
    const a = await makeBot(core, '甲');
    const b = await makeBot(core, '乙');
    llm.script('mock-main', [
      step().replyToolCall('propose_group', {
        title: '发布小组',
        description: '负责版本发布的准备与复盘',
        member_bot_ids: [a.id, b.id],
        reason: '发布要多人配合',
      }),
    ]);
    await sendBatch(core, conversationId, ['帮我张罗一个发布小组']);
    const approval = await waitFor(
      () => butlerApprovals(stack, conversationId).find((x) => x.status === 'pending') ?? null,
    );
    llm.script('mock-main', [step().replyText('群建好了。')]);
    await core.rpc.call('approvals.decide', { id: approval.id, approve: true });
    const group = await waitFor(() =>
      core.services.domain!.conversations.list().find((c) => c.type === 'group' && c.title === '发布小组'),
    );
    expect(group.description).toBe('负责版本发布的准备与复盘');
    expect(core.services.domain!.conversations.memberBotIds(group.id).sort()).toEqual(
      [a.id, b.id].sort(),
    );
  }, 30_000);
});
