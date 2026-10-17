import { afterEach, describe, expect, it } from 'vitest';
import { PROPOSE_BOTS_MAX, PROPOSE_BOTS_MIN, type Approval } from '@kepcup/shared';
import {
  createTestStack,
  listAllMessages,
  makeBot,
  makeProject,
  sendBatch,
  step,
  waitFor,
  type TestStack,
} from '@kepcup/testkit';

/**
 * WP4 §4.2（D92 T1a）：`propose_project`（负责人必须在成员里、管家不得加入、
 * 成员 ≥ 2；失败以工具结果返回不出卡）、卡上改负责人（`approvals.decide`
 * 带 `leadBotId`）、`propose_bots` 数量边界（3~5，原组队提议工具的行为）、
 * `suggest_route` 的 `route='project'`。
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

function butlerApprovals(stack: TestStack, conversationId: string): Approval[] {
  return stack.core.services
    .domain!.approvals.list(conversationId)
    .filter((a) => a.kind === 'butler_proposal');
}

async function butlerChat(stack: TestStack): Promise<string> {
  const result = (await stack.core.rpc.call('butler.ensure', {})) as {
    conversationId: string;
  };
  return result.conversationId;
}

function pendingApproval(
  stack: TestStack,
  conversationId: string,
  excludeIds: string[] = [],
): Promise<Approval> {
  return waitFor(
    () =>
      butlerApprovals(stack, conversationId).find(
        (a) => a.status === 'pending' && !excludeIds.includes(a.id),
      ) ?? null,
    { label: 'pending butler proposal' },
  );
}

describe('propose_project（WP4 §4.2）', () => {
  it('负责人不在成员里 / 含管家 / 成员 < 2：工具失败结果，不出卡', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const conversationId = await butlerChat(stack);
    const a = await makeBot(core, '甲');
    const b = await makeBot(core, '乙');
    const butlerId = core.services.domain!.bots
      .listActive()
      .find((bot) => bot.systemRole === 'butler')!.id;

    llm.script('mock-main', [
      // lead_bot_id 不在 member_bot_ids 里。
      step().replyToolCall('propose_project', {
        title: '坏例子一',
        goal: '目标',
        lead_bot_id: b.id,
        member_bot_ids: [a.id],
        reason: 'r',
      }),
      // 成员里含管家。
      step().replyToolCall('propose_project', {
        title: '坏例子二',
        goal: '目标',
        lead_bot_id: butlerId,
        member_bot_ids: [a.id, butlerId],
        reason: 'r',
      }),
      // 成员不足 2。
      step().replyToolCall('propose_project', {
        title: '坏例子三',
        goal: '目标',
        lead_bot_id: a.id,
        member_bot_ids: [a.id],
        reason: 'r',
      }),
      step().replyText('三次都被工具退回了。'),
    ]);
    await sendBatch(core, conversationId, ['帮我建个项目组']);

    await waitFor(async () =>
      (await listAllMessages(core, conversationId)).find(
        (m) => m.senderType === 'bot' && 'text' in m.content && m.content.text.includes('退回'),
      ) ?? null,
    );
    expect(butlerApprovals(stack, conversationId)).toHaveLength(0);
  }, 30_000);

  it('成功出卡（载荷带负责人）；用户批准且改了负责人 → 建出的项目组用改后的负责人', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const conversationId = await butlerChat(stack);
    const a = await makeBot(core, '甲');
    const b = await makeBot(core, '乙');
    llm.script('mock-main', [
      step().replyToolCall('propose_project', {
        title: '发布项目组',
        goal: '负责版本发布的准备与复盘',
        lead_bot_id: a.id,
        member_bot_ids: [a.id, b.id],
        reason: '发布要多人配合',
      }),
    ]);
    await sendBatch(core, conversationId, ['张罗一个发布项目组']);
    const approval = await pendingApproval(stack, conversationId);
    expect(approval.payload).toMatchObject({
      proposalType: 'project',
      title: '发布项目组',
      goal: '负责版本发布的准备与复盘',
      leadBotId: a.id,
      memberBotIds: [a.id, b.id],
    });

    llm.script('mock-main', [step().replyText('项目组建好了。')]);
    // 卡上改负责人为乙。
    const decided = (await core.rpc.call('approvals.decide', {
      id: approval.id,
      approve: true,
      leadBotId: b.id,
    })) as { approval: Approval };
    expect(decided.approval.decision?.leadBotId).toBe(b.id);

    const project = await waitFor(() =>
      core.services.domain!.conversations.list().find((c) => c.type === 'project' && c.title === '发布项目组'),
    );
    expect(project.leadBotId).toBe(b.id);
    expect(project.goal).toBe('负责版本发布的准备与复盘');
    expect(core.services.domain!.conversations.memberBotIds(project.id).sort()).toEqual(
      [a.id, b.id].sort(),
    );
  }, 30_000);

  it('decide 的 leadBotId 不在载荷成员里 / 用于非 project 提议：INVALID_INPUT，卡保持挂起', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const conversationId = await butlerChat(stack);
    const a = await makeBot(core, '甲');
    const b = await makeBot(core, '乙');
    const c = await makeBot(core, '丙');

    // project 卡：leadBotId 是外人。
    llm.script('mock-main', [
      step().replyToolCall('propose_project', {
        title: '项目组一',
        goal: '目标',
        lead_bot_id: a.id,
        member_bot_ids: [a.id, b.id],
      }),
    ]);
    await sendBatch(core, conversationId, ['建项目组一']);
    const projectCard = await pendingApproval(stack, conversationId);
    await expect(
      core.rpc.call('approvals.decide', { id: projectCard.id, approve: true, leadBotId: c.id }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(core.services.domain!.approvals.get(projectCard.id)!.status).toBe('pending');
    // 拒掉这张卡，才能提下一张（同一对话同时只允许一张待确认提议）。
    llm.script('mock-main', [step().replyText('好的，先不建了。')]);
    await core.rpc.call('approvals.decide', { id: projectCard.id, approve: false });

    // bots 卡：leadBotId 根本不支持。
    llm.script('mock-main', [
      step().replyToolCall('propose_bots', {
        bots: [
          { name: '文书', bio: 'b', expertise: 'e', responsibilities: 'r', reason: '因为' },
          { name: '码农', bio: 'b', expertise: 'e', responsibilities: 'r', reason: '因为' },
          { name: '研究员', bio: 'b', expertise: 'e', responsibilities: 'r', reason: '因为' },
        ],
      }),
    ]);
    await sendBatch(core, conversationId, ['组个团队']);
    const botsCard = await pendingApproval(stack, conversationId, [projectCard.id]);
    await expect(
      core.rpc.call('approvals.decide', { id: botsCard.id, approve: true, leadBotId: a.id }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(core.services.domain!.approvals.get(botsCard.id)!.status).toBe('pending');
  }, 30_000);
});

describe('propose_bots 数量边界（WP4 §4.2，原组队提议工具的行为）', () => {
  it(`少于 ${PROPOSE_BOTS_MIN} 个或超过 ${PROPOSE_BOTS_MAX} 个：工具失败；边界内出卡`, async () => {
    const stack = await start();
    const { core, llm } = stack;
    const conversationId = await butlerChat(stack);
    const bot = (name: string) => ({ name, bio: 'b', expertise: 'e', responsibilities: 'r', reason: '因为' });
    llm.script('mock-main', [
      step().replyToolCall('propose_bots', { bots: [bot('一'), bot('二')] }),
      step().replyText('两个不够。'),
    ]);
    await sendBatch(core, conversationId, ['组个两人团队']);
    await waitFor(async () =>
      (await listAllMessages(core, conversationId)).find(
        (m) => m.senderType === 'bot' && 'text' in m.content && m.content.text.includes('不够'),
      ) ?? null,
    );
    expect(butlerApprovals(stack, conversationId)).toHaveLength(0);

    llm.script('mock-main', [step().replyToolCall('propose_bots', { bots: [bot('一'), bot('二'), bot('三')] })]);
    await sendBatch(core, conversationId, ['那就三个']);
    const approval = await pendingApproval(stack, conversationId);
    expect(approval.payload).toMatchObject({ proposalType: 'bots' });
  }, 30_000);
});

describe("suggest_route route='project'（WP4 §4.2）", () => {
  it('指向已有项目组的路由卡；conversation_id 缺失时工具报错', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const conversationId = await butlerChat(stack);
    const a = await makeBot(core, '甲');
    const b = await makeBot(core, '乙');
    const project = await makeProject(core, '已有项目组', [a.id, b.id]);

    llm.script('mock-main', [
      step().replyToolCall('suggest_route', { route: 'project', task: 'x', reason: '给个理由' }),
      step().replyText('少 conversation_id 被退回了。'),
    ]);
    await sendBatch(core, conversationId, ['这件事去哪处理？']);
    await waitFor(async () =>
      (await listAllMessages(core, conversationId)).find(
        (m) => m.senderType === 'bot' && 'text' in m.content && m.content.text.includes('退回'),
      ) ?? null,
    );

    llm.script('mock-main', [
      step().replyToolCall('suggest_route', {
        route: 'project',
        conversation_id: project.id,
        reason: '这件事是项目组的事',
      }),
    ]);
    await sendBatch(core, conversationId, ['那就去项目组吧']);
    await waitFor(async () =>
      (await listAllMessages(core, conversationId)).find(
        (m) =>
          m.kind === 'system_event' &&
          'event' in m.content &&
          m.content.event === 'route_suggestion',
      ) ?? null,
    );
    const cards = (await listAllMessages(core, conversationId)).filter(
      (m) => m.kind === 'system_event' && 'event' in m.content && m.content.event === 'route_suggestion',
    );
    expect(cards).toHaveLength(1);
    expect(cards[0]!.content).toMatchObject({
      route: { kind: 'project', conversationId: project.id },
    });
  }, 30_000);
});
