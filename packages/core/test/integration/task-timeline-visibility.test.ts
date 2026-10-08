import { afterEach, describe, expect, it } from 'vitest';
import type { Conversation, Message, Run } from '@kepcup/shared';
import {
  createTestStack,
  listMessages,
  listRuns,
  makeBot,
  makeGroup,
  sendBatch,
  sendDrafts,
  step,
  waitFor,
  type MockChatRequest,
  type TestStack,
} from '@kepcup/testkit';

/**
 * D75 W1-B 泄露契约（docs/design/30 §2.4.3）：群里 X 的私有时间线条目
 * （交代 / 追加 / 提问 / 结果 / 取消 / 失败）在 owner 以外的所有视角、所有读
 * 路径下都不可见——Y 的上下文构建、search_messages、get_messages_around、
 * 对话摘要输入、群聊判断输入、反思输入，以及用户的 messages.list、会话预览、
 * 未读数；X 自己的上下文里看得到，且按 seq 与用户消息交错。
 */

const stacks: TestStack[] = [];

afterEach(async () => {
  for (const stack of stacks.splice(0)) await stack.cleanup();
});

/** Every private-entry text carries one of these; none may reach a non-owner. */
const LEAK_MARKERS = [
  'leak_brief',
  'leak_inject',
  'leak_question',
  'leak_result',
  'leak_brief_two',
  'leak_cancel',
  'leak_error',
  'leak_failure',
  'leak_tail',
];

function bodyText(request: MockChatRequest): string {
  return JSON.stringify(request.body);
}

function leaksIn(text: string): string[] {
  return LEAK_MARKERS.filter((marker) => text.includes(marker));
}

function systemText(request: MockChatRequest): string {
  const first = request.body.messages?.[0];
  return typeof first?.content === 'string' ? first.content : '';
}

/** Tool-result message bodies of one request, in order. */
function toolResults(request: MockChatRequest): string[] {
  return (request.body.messages ?? [])
    .filter((m) => m.role === 'tool')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));
}

function waitForBotRun(
  core: TestStack['core'],
  conversationId: string,
  botId: string,
  loopType: Run['loopType'],
): Promise<Run> {
  return waitFor(
    async () =>
      (await listRuns(core, conversationId)).find(
        (r) => r.botId === botId && r.loopType === loopType && r.status === 'completed',
      ) ?? null,
    { label: `${loopType} run of ${botId} completed` },
  );
}

function waitForRequest(
  llm: TestStack['llm'],
  model: string,
  match: (request: MockChatRequest) => boolean,
  label: string,
): Promise<MockChatRequest> {
  return waitFor(() => llm.requestsFor(model).find(match) ?? null, { label, timeoutMs: 30_000 });
}

describe('私有时间线泄露契约（D75 §2.4.3）', () => {
  it('X 的私有条目对 Y 与用户的所有读路径都不可见，X 自己按 seq 交错看到', async () => {
    const stack = await createTestStack();
    stacks.push(stack);
    const { core, llm } = stack;
    const domain = core.services.domain!;
    const x = await makeBot(core, '阿甲');
    const y = await makeBot(core, '阿乙');
    const conv = await makeGroup(core, '斑马调研', [x.id, y.id]);
    const cid = conv.id;
    const t1 = 'run_task_one';
    const t2 = 'run_task_two';
    const t3 = 'run_task_three';

    // --- fixture: X's private round-trips interleaved with shared rows -------
    const user = (text: string): Message =>
      domain.messages.append({ conversationId: cid, senderType: 'user', kind: 'text', text });
    const privateEntry = (
      taskId: string,
      phase: 'brief' | 'inject' | 'cancel' | 'question' | 'result' | 'failure',
      text: string,
      extra: { status?: 'cancelled'; error?: string; title?: string } = {},
    ): Message =>
      domain.messages.appendTaskEvent({
        conversationId: cid,
        ownerBotId: x.id,
        taskId,
        phase,
        text,
        ...extra,
      }).message;

    const u1 = user('zebra user_first 请调研斑马');
    const brief = privateEntry(t1, 'brief', 'zebra leak_brief 查斑马分布', { title: '斑马调研' });
    domain.messages.append({
      conversationId: cid,
      senderType: 'bot',
      senderBotId: x.id,
      kind: 'text',
      text: 'zebra progress_visible 正在查资料',
      taskOrigin: { taskId: t1 },
    });
    privateEntry(t1, 'inject', 'zebra leak_inject 顺便查习性');
    privateEntry(t1, 'question', 'zebra leak_question 要查哪个洲');
    const result = privateEntry(t1, 'result', 'zebra leak_result 斑马分布在非洲');
    privateEntry(t2, 'brief', 'zebra leak_brief_two 画分布图');
    privateEntry(t2, 'cancel', 'zebra leak_cancel 用户不要图了');
    const failure = privateEntry(t2, 'failure', 'zebra leak_failure 最后在画图', {
      status: 'cancelled',
      error: 'leak_error',
    });
    const u2 = user('zebra user_second 还有别的吗');
    privateEntry(t3, 'brief', 'zebra leak_tail 收尾任务');

    // --- user: messages.list RPC, preview, unread ----------------------------
    const visible = await listMessages(core, cid);
    expect(visible.some((m) => m.kind === 'task_event' || m.ownerBotId !== null)).toBe(false);
    expect(leaksIn(JSON.stringify(visible))).toEqual([]);
    expect(visible.map((m) => (m.content as { text?: string }).text ?? '')).toEqual(
      expect.arrayContaining([
        'zebra user_first 请调研斑马',
        'zebra progress_visible 正在查资料',
        'zebra user_second 还有别的吗',
      ]),
    );
    await core.rpc.call('conversations.markRead', { conversationId: cid, seq: u1.seq });
    const listed = (await core.rpc.call('conversations.list')) as {
      conversations: Array<Conversation & { unreadCount?: number; lastMessageText?: string }>;
    };
    const view = listed.conversations.find((c) => c.id === cid)!;
    expect(view.lastMessageText).toBe('zebra user_second 还有别的吗');
    // Visible after user_first: the progress line and user_second only.
    expect(view.unreadCount).toBe(2);
    expect(view.lastSeq - view.lastReadSeq).toBeGreaterThan(2);
    const got = (await core.rpc.call('conversations.get', { id: cid })) as {
      conversation: Conversation & { unreadCount?: number };
    };
    expect(got.conversation.unreadCount).toBe(2);
    // Private rows do not move the conversation's list time (preview order).
    expect(view.lastMessageAt).toBe(u2.createdAt);

    // --- scripts ---------------------------------------------------------------
    const isY = (r: MockChatRequest) => systemText(r).includes('名字：阿乙');
    const isX = (r: MockChatRequest) => systemText(r).includes('名字：阿甲');
    llm.script('mock-main', [
      step().expect(isY).replyToolCall('search_messages', { query: 'zebra' }),
      step().expect(isY).replyToolCall('get_messages_around', { message_id: u1.id, n: 20 }),
      step().expect(isY).replyToolCall('get_messages_around', { message_id: brief.id }),
      step().expect(isY).replyText('阿乙答完'),
      step().expect(isX).replyText('阿甲答完'),
    ]);
    const triageFor = (name: string) => (r: MockChatRequest) =>
      r.lastUserText().includes(`你的名片：${name}`);
    llm.script('mock-light', [
      step()
        .expect(triageFor('阿甲'))
        .replyJson({ decision: 'no_action', confidence: 0.1, reason: '不归我' }),
      step()
        .expect(triageFor('阿乙'))
        .replyJson({ decision: 'no_action', confidence: 0.1, reason: '不归我' }),
      step()
        .expect((r) => r.lastUserText().includes('<previous_summary>'))
        .replyJson({ summary: '用户在调研斑马。' }),
    ]);

    // --- Y: context construction + search_messages + get_messages_around -------
    await sendDrafts(core, cid, [{ text: 'ask_y 你怎么看', mentions: [y.id] }]);
    await waitForBotRun(core, cid, y.id, 'turn');
    const yRequests = llm.requestsFor('mock-main').filter(isY);
    expect(yRequests).toHaveLength(4);
    for (const request of yRequests) expect(leaksIn(bodyText(request))).toEqual([]);
    // The context really carried the shared timeline (incl. X's visible progress).
    expect(yRequests[0]!.lastUserText()).toContain('user_first');
    expect(yRequests[0]!.lastUserText()).toContain(`阿甲（任务 ${t1}）`);
    expect(yRequests[0]!.lastUserText()).toContain('progress_visible');
    const yTools = toolResults(yRequests[3]!);
    expect(yTools).toHaveLength(3);
    // search_messages found the shared hits, none of X's entries.
    expect(yTools[0]).toContain('user_first');
    expect(yTools[0]).toContain('progress_visible');
    expect(yTools[0]).toContain('user_second');
    // get_messages_around over the whole stretch: shared rows only.
    expect(yTools[1]).toContain('user_first');
    expect(yTools[1]).toContain('user_second');
    // X's private row as an anchor answers like a missing message.
    expect(yTools[2]).toContain('消息不存在');

    // --- triage input (group judgement): Y sees none, X sees its own --------
    await sendBatch(core, cid, ['broadcast_probe 大家看看']);
    const yTriage = await waitForRequest(llm, 'mock-light', triageFor('阿乙'), 'Y triage');
    const xTriage = await waitForRequest(llm, 'mock-light', triageFor('阿甲'), 'X triage');
    expect(yTriage.lastUserText()).toContain('broadcast_probe');
    expect(leaksIn(bodyText(yTriage))).toEqual([]);
    expect(xTriage.lastUserText()).toContain('leak_tail');
    await waitForBotRun(core, cid, y.id, 'triage');
    await waitForBotRun(core, cid, x.id, 'triage');

    // --- summary job input: shared rows only ----------------------------------
    domain.jobs.enqueue({
      type: 'conversation_summary',
      conversationId: cid,
      payload: { targetSeq: domain.conversations.get(cid)!.lastSeq },
      priority: 2,
      dedupeKey: `conversation_summary:${cid}`,
    });
    const summaryRequest = await waitForRequest(
      llm,
      'mock-light',
      (r) => r.lastUserText().includes('<previous_summary>'),
      'summary request',
    );
    expect(summaryRequest.lastUserText()).toContain('user_first');
    expect(summaryRequest.lastUserText()).toContain('progress_visible');
    expect(leaksIn(bodyText(summaryRequest))).toEqual([]);

    // --- reflection input: only the owner's private rows ----------------------
    const probeY = user('reflect_probe_y 我喜欢斑马');
    const probeX = user('reflect_probe_x 我也喜欢长颈鹿');
    const privateIds = [brief.id, result.id, failure.id];
    for (const [botId, probe] of [
      [y.id, probeY],
      [x.id, probeX],
    ] as const) {
      domain.jobs.enqueue({
        type: 'reflection',
        botId,
        conversationId: cid,
        payload: { triggerMessageIds: [probe.id, ...privateIds], batchId: null },
        priority: 2,
      });
    }
    const yReflection = await waitForRequest(
      llm,
      'mock-light',
      (r) => r.lastUserText().includes('reflect_probe_y'),
      'Y reflection request',
    );
    expect(leaksIn(bodyText(yReflection))).toEqual([]);
    const xReflection = await waitForRequest(
      llm,
      'mock-light',
      (r) => r.lastUserText().includes('reflect_probe_x'),
      'X reflection request',
    );
    expect(xReflection.lastUserText()).toContain('leak_result');

    // --- X: own entries interleaved by seq with the user's messages ----------
    await sendDrafts(core, cid, [{ text: 'ask_x 结论呢', mentions: [x.id] }]);
    await waitForBotRun(core, cid, x.id, 'turn');
    const xRequest = llm.requestsFor('mock-main').find(isX)!;
    const xText = xRequest.lastUserText();
    const order = [
      'user_first',
      'leak_brief ',
      'progress_visible',
      'leak_inject',
      'leak_question',
      'leak_result',
      'leak_brief_two',
      'leak_cancel',
      'leak_failure',
      'user_second',
      'leak_tail',
    ].map((marker) => xText.indexOf(marker));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(xText).toContain(`你→任务 ${t1}（交代）] 斑马调研：zebra leak_brief`);
    expect(xText).toContain(`你（任务 ${t1}）] zebra progress_visible`);
    expect(xText).toContain(`任务 ${t1}→你（结果）] zebra leak_result`);
    expect(xText).toContain(
      `任务 ${t2}→你（失败）] 状态：已取消；错误：leak_error。zebra leak_failure`,
    );

    // The user still sees none of it after all the runs.
    expect(leaksIn(JSON.stringify(await listMessages(core, cid)))).toEqual([]);
  }, 60_000);
});
