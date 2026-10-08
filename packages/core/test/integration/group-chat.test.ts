import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Run } from '@kepcup/shared';
import {
  createTestStack,
  listMessages,
  listRuns,
  makeBot,
  makeGroup,
  sendDrafts,
  step,
  waitFor,
  waitForEvent,
  waitForMessage,
  type TestStack,
} from '@kepcup/testkit';

const stacks: TestStack[] = [];

afterEach(async () => {
  for (const stack of stacks.splice(0)) await stack.cleanup();
});

async function start(env: NodeJS.ProcessEnv = {}): Promise<TestStack> {
  const stack = await createTestStack({ env });
  stacks.push(stack);
  return stack;
}

function systemText(request: { body: { messages?: Array<{ role: string; content?: unknown }> } }): string {
  const first = request.body.messages?.[0];
  return typeof first?.content === 'string' ? first.content : '';
}

/** Triage requests of one bot (the light-model user message carries the card). */
function triageRequestsFor(llm: TestStack['llm'], name: string) {
  return llm.requestsFor('mock-light').filter((r) => r.lastUserText().includes(`你的名片：${name}`));
}

/** Run of one bot in one conversation with response loopType and status. */
function waitForBotRun(
  core: TestStack['core'],
  conversationId: string,
  botId: string,
  status: Run['status'],
  options: { timeoutMs?: number } = {},
): Promise<Run> {
  return waitFor(
    async () =>
      (await listRuns(core, conversationId)).find(
        (r) => r.botId === botId && r.loopType === 'turn' && r.status === status,
      ) ?? null,
    { ...options, label: `response run of ${botId} in ${status}` },
  );
}

async function botRuns(
  core: TestStack['core'],
  conversationId: string,
  botId: string,
): Promise<Run[]> {
  return (await listRuns(core, conversationId)).filter((r) => r.botId === botId && r.loopType === 'turn');
}

async function stepsOf(core: TestStack['core'], runId: string): Promise<Array<Record<string, unknown>>> {
  const result = (await core.rpc.call('runs.steps', { runId })) as {
    steps: Array<{ type: string; payload: Record<string, unknown> }>;
  };
  return result.steps.map((s) => ({ type: s.type, ...s.payload }) as Record<string, unknown>);
}

async function threeBots(core: TestStack['core']) {
  const a = await makeBot(core, '阿甲');
  const b = await makeBot(core, '阿乙');
  const c = await makeBot(core, '阿丙');
  const conv = await makeGroup(core, '项目讨论', [a.id, b.id, c.id]);
  return { a, b, c, conv };
}

describe('group conversations', () => {
  it('creates, renames and manages members; creation requires at least 2 members', async () => {
    const { core } = await start();
    const { a, b, c, conv } = await threeBots(core);
    expect(conv.type).toBe('group');
    expect(conv.title).toBe('项目讨论');

    await expect(
      core.rpc.call('groups.create', { title: 'x', memberBotIds: [a.id] }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    const renamed = (await core.rpc.call('groups.rename', {
      conversationId: conv.id,
      title: '新群名',
    })) as { conversation: { title: string } };
    expect(renamed.conversation.title).toBe('新群名');

    const d = await makeBot(core, '阿丁');
    const added = (await core.rpc.call('groups.addMembers', {
      conversationId: conv.id,
      botIds: [d.id],
    })) as { members: Array<{ bot: { id: string } }> };
    expect(added.members.map((m) => m.bot.id).sort()).toEqual([a.id, b.id, c.id, d.id].sort());

    await core.rpc.call('groups.removeMember', { conversationId: conv.id, botId: d.id });
    const members = (await core.rpc.call('conversations.members', {
      conversationId: conv.id,
    })) as { members: Array<{ bot: { id: string } }> };
    expect(members.members.map((m) => m.bot.id).sort()).toEqual([a.id, b.id, c.id].sort());
  });

  it('@ A → only A executes and no triage request is sent', async () => {
    const { core, llm } = await start();
    const { a, conv } = await threeBots(core);
    llm.script('mock-main', [step().replyText('阿甲收到')]);

    await sendDrafts(core, conv.id, [{ text: '帮我看下', mentions: [a.id] }]);
    await waitForBotRun(core, conv.id, a.id, 'completed');
    await waitForMessage(core, conv.id, (m) => m.senderBotId === a.id);

    const runs = await listRuns(core, conv.id);
    // P07 起：响应之后还有一个后台反思 run（loopType=reflection）。响应 run
    // 只有一个，且没有发送任何群聊判断请求（triage 的输入含 <triage_batch>；
    // 反思的输入含 <trigger_messages>，两者共用轻量模型）。
    const responseRuns = runs.filter((r) => r.loopType === 'turn');
    expect(responseRuns).toHaveLength(1);
    expect(responseRuns[0]).toMatchObject({ botId: a.id, triggerReason: 'mention' });
    expect(runs.filter((r) => r.loopType !== 'turn').every((r) => r.loopType === 'reflection')).toBe(true);
    expect(llm.requestsFor('mock-light').filter((req) => req.lastUserText().includes('<triage_batch>'))).toHaveLength(0);
  });

  it('a batch @-ing A and B executes them in order; B sees A\'s reply and the sequence hint', async () => {
    const { core, llm } = await start();
    const { a, b, conv } = await threeBots(core);
    void conv;
    llm.script('mock-main', [
      step().replyText('阿甲的答复'),
      step().replyText('阿乙的补充'),
    ]);

    await sendDrafts(core, conv.id, [
      { text: '第一个问题', mentions: [a.id] },
      { text: '第二个问题', mentions: [b.id] },
    ]);
    await waitForBotRun(core, conv.id, a.id, 'completed');
    await waitForBotRun(core, conv.id, b.id, 'completed');

    const responses = llm.requestsFor('mock-main');
    expect(responses).toHaveLength(2);
    const aIndex = responses.findIndex((r) => systemText(r).includes('名字：阿甲'));
    const bIndex = responses.findIndex((r) => systemText(r).includes('名字：阿乙'));
    expect(aIndex).toBeGreaterThanOrEqual(0);
    expect(bIndex).toBeGreaterThan(aIndex);

    const bRequest = responses[bIndex]!;
    expect(bRequest.lastUserText()).toContain('阿甲的答复');
    expect(bRequest.lastUserText()).toContain('在你之前，阿甲已经回复');

    // 只在响应 run 里断言：P07 起每个响应 run 还有一个同 Bot 的反思 run
    // （triggerReason=background，created_at 更新排在前），find 命中它会得到
    // 'background'——套件高负载下反思先落库时此断言偶发翻车。
    const responseRuns = (await listRuns(core, conv.id)).filter((r) => r.loopType === 'turn');
    for (const id of [a.id, b.id]) {
      expect(responseRuns.find((r) => r.botId === id)?.triggerReason).toBe('mention');
    }
  });

  it('no explicit target: responders run by confidence, later bot sees the earlier reply and skip_reply sends nothing', async () => {
    const { core, llm } = await start();
    const { a, b, conv } = await threeBots(core);

    // A prior exchange so the triage hint has a "recent interlocutor".
    llm.script('mock-main', [step().replyText('阿甲打过招呼')]);
    await sendDrafts(core, conv.id, [{ text: '先在吗', mentions: [a.id] }]);
    await waitForBotRun(core, conv.id, a.id, 'completed');

    llm.script('mock-light', [
      step().expect((r) => r.lastUserText().includes('你的名片：阿甲')).replyJson({ decision: 'respond', confidence: 0.9, reason: '归我' }),
      step().expect((r) => r.lastUserText().includes('你的名片：阿乙')).replyJson({ decision: 'respond', confidence: 0.6, reason: '也可以' }),
      step().expect((r) => r.lastUserText().includes('你的名片：阿丙')).replyJson({ decision: 'no_action', confidence: 0.2, reason: '无需回应' }),
    ]);
    llm.script('mock-main', [
      step().expect((r) => r.lastUserText().includes('谁来处理一下')).replyText('阿甲先答'),
      step().expect((r) => r.lastUserText().includes('谁来处理一下')).replyToolCall('skip_reply', { reason: '已经有人回答了' }),
    ]);

    await sendBatchless(core, conv.id, '大家好，这个问题谁来处理一下');
    await waitForBotRun(core, conv.id, a.id, 'completed');
    await waitForBotRun(core, conv.id, b.id, 'completed');

    const responses = llm.requestsFor('mock-main');
    const aIndex = responses.findIndex((r) => systemText(r).includes('名字：阿甲'));
    const bIndex = responses.findIndex((r) => systemText(r).includes('名字：阿乙'));
    expect(bIndex).toBeGreaterThan(aIndex);
    expect(responses[bIndex]!.lastUserText()).toContain('阿甲先答');
    expect(responses[bIndex]!.lastUserText()).toContain('在你之前，阿甲已经回复');

    // Triages actually asked the light model, with the designed inputs.
    const triage = triageRequestsFor(llm, '阿甲').at(-1)!;
    expect(triage.lastUserText()).toContain('<triage_recent_messages>');
    expect(triage.lastUserText()).toContain('阿甲打过招呼');
    expect(triage.lastUserText()).toContain('<triage_batch>');
    expect(triage.lastUserText()).toContain('最近一次与用户交流的 Bot 是 阿甲');
    // The own card is trusted input: it sits before the first <untrusted>
    // (BR-P05-005) while the recent messages stay wrapped.
    const triageText = triage.lastUserText();
    expect(triageText.indexOf('你的名片：阿甲')).toBeGreaterThanOrEqual(0);
    expect(triageText.indexOf('你的名片：阿甲')).toBeLessThan(triageText.indexOf('<untrusted>'));
    expect(triageText.indexOf('<triage_recent_messages>')).toBeGreaterThan(triageText.indexOf('<untrusted>'));

    const messages = await listMessages(core, conv.id);
    const bMessages = messages.filter((m) => m.senderBotId === b.id);
    expect(bMessages).toHaveLength(0); // skip_reply: no message

    const runs = await listRuns(core, conv.id);
    expect(runs.find((r) => r.botId === a.id && r.loopType === 'turn')?.triggerReason).toBe('broadcast');
    expect(runs.find((r) => r.botId === b.id && r.loopType === 'turn')?.triggerReason).toBe('broadcast');
    expect(runs.filter((r) => r.loopType === 'triage')).toHaveLength(3);
  }, 30_000);

  it('all not_mine inserts the no-claim system message; all no_action stays silent', async () => {
    const { core, llm } = await start();
    const { a, b, c, conv } = await threeBots(core);

    const notMine = (reason: string) =>
      step().expect((r) => r.lastUserText().includes(`你的名片：${reason}`)).replyJson({ decision: 'not_mine', confidence: 0.5, reason: '不归我' });
    llm.script('mock-light', [
      notMine('阿甲'),
      notMine('阿乙'),
      notMine('阿丙'),
    ]);

    await sendBatchless(core, conv.id, '这个问题需要有人处理');
    const systemMessage = await waitForMessage(
      core,
      conv.id,
      (m) => m.kind === 'system_event' && m.content.event === 'group_no_claim',
    );
    expect(systemMessage.content.text).toContain('请指定一个 Bot');
    expect(systemMessage.content.botIds?.sort()).toEqual([a.id, b.id, c.id].sort());
    expect((systemMessage.content as { batchId?: string }).batchId).toBeTruthy();
    expect((await botRuns(core, conv.id, a.id)).length).toBe(0);

    // All no_action: no further system message.
    const systemCount = (await listMessages(core, conv.id)).filter(
      (m) => m.kind === 'system_event' && m.content.event === 'group_no_claim',
    ).length;
    llm.script('mock-light', [
      step().replyJson({ decision: 'no_action', confidence: 0.3, reason: '寒暄' }),
      step().replyJson({ decision: 'no_action', confidence: 0.3, reason: '寒暄' }),
      step().replyJson({ decision: 'no_action', confidence: 0.3, reason: '寒暄' }),
    ]);
    await sendBatchless(core, conv.id, '谢谢大家');
    await waitFor(() => llm.requestsFor('mock-light').length >= 6, { label: 'second triage wave' });
    // Let the in-flight triage calls settle before cleanup tears the core down.
    await waitFor(
      async () => {
        const triageRuns = (await listRuns(core, conv.id)).filter((r) => r.loopType === 'triage');
        return triageRuns.length === 6 && triageRuns.every((r) => r.status !== 'running' && r.status !== 'queued')
          ? true
          : null;
      },
      { label: 'second wave settled' },
    );
    await waitFor(
      async () =>
        (await listMessages(core, conv.id)).filter(
          (m) => m.kind === 'system_event' && m.content.event === 'group_no_claim',
        ).length === systemCount
          ? true
          : null,
      { label: 'no new system message' },
    );
  }, 30_000);

  it('triage timeout counts as no_action', async () => {
    const { core, llm } = await start({ KEPCUP_TRIAGE_TIMEOUT_MS: '400' });
    const { a, conv } = await threeBots(core);

    llm.script('mock-light', [
      step().expect((r) => r.lastUserText().includes('你的名片：阿甲')).hold(),
      step().expect((r) => r.lastUserText().includes('你的名片：阿乙')).replyJson({ decision: 'not_mine', confidence: 0.5, reason: '不归我' }),
      step().expect((r) => r.lastUserText().includes('你的名片：阿丙')).replyJson({ decision: 'not_mine', confidence: 0.5, reason: '不归我' }),
    ]);

    await sendBatchless(core, conv.id, '需要有人看看');
    // A's triage hangs; timeout -> no_action. B/C are not_mine -> system message.
    const systemMessage = await waitForMessage(
      core,
      conv.id,
      (m) => m.kind === 'system_event' && m.content.event === 'group_no_claim',
      { timeoutMs: 8_000 },
    );
    expect(systemMessage).toBeTruthy();
    expect((await botRuns(core, conv.id, a.id)).length).toBe(0);
    llm.releaseAll();
  }, 20_000);

  it('clicking a bot in the no-claim message re-dispatches the batch as an @', async () => {
    const { core, llm } = await start();
    const { a, conv } = await threeBots(core);

    llm.script('mock-light', [
      step().replyJson({ decision: 'not_mine', confidence: 0.5, reason: '不归我' }),
      step().replyJson({ decision: 'not_mine', confidence: 0.5, reason: '不归我' }),
      step().replyJson({ decision: 'not_mine', confidence: 0.5, reason: '不归我' }),
    ]);
    await sendBatchless(core, conv.id, '这个谁来处理');
    const systemMessage = await waitForMessage(
      core,
      conv.id,
      (m) => m.kind === 'system_event' && m.content.event === 'group_no_claim',
    );

    llm.script('mock-main', [step().replyText('好吧，我来看看')]);
    await core.rpc.call('groups.redistribute', {
      conversationId: conv.id,
      batchId: (systemMessage.content as { batchId: string }).batchId,
      botId: a.id,
    });

    const run = await waitForBotRun(core, conv.id, a.id, 'completed');
    expect(run.triggerReason).toBe('mention');
    await waitForMessage(core, conv.id, (m) => m.senderBotId === a.id);
  }, 30_000);

  it('send_message @ B triggers B as a chain run (depth 1)', async () => {
    const { core, llm } = await start();
    const { a, b, conv } = await threeBots(core);

    llm.script('mock-main', [
      step().expect((r) => systemText(r).includes('名字：阿甲')).replyToolCall('send_message', {
        text: '请阿乙帮忙看一下',
        mention_bot_ids: [b.id],
      }),
      step().expect((r) => systemText(r).includes('名字：阿甲')).replyText('阿甲完成'),
      step().expect((r) => systemText(r).includes('名字：阿乙')).replyText('阿乙来了'),
    ]);

    await sendDrafts(core, conv.id, [{ text: '阿甲你来', mentions: [a.id] }]);
    await waitForBotRun(core, conv.id, a.id, 'completed');
    const bRun = await waitForBotRun(core, conv.id, b.id, 'completed');
    expect(bRun.triggerReason).toBe('chain');
    expect(bRun.chainId).toBeTruthy();
    expect(bRun.chainDepth).toBe(1);

    const mentionsMessage = await waitForMessage(
      core,
      conv.id,
      (m) => m.senderBotId === a.id && m.mentions.includes(b.id),
    );
    expect(bRun.triggerMessageIds).toContain(mentionsMessage.id);
    await waitForMessage(core, conv.id, (m) => m.senderBotId === b.id);
  }, 30_000);

  it('chains stop after 3 levels', async () => {
    const { core, llm } = await start();
    const { a, b, c, conv } = await threeBots(core);
    const d = await makeBot(core, '阿丁');
    const e = await makeBot(core, '阿戊');
    await core.rpc.call('groups.addMembers', { conversationId: conv.id, botIds: [d.id, e.id] });

    const chainStep = (name: string, targetId: string) =>
      step()
        .expect((r) => systemText(r).includes(`名字：${name}`))
        .replyToolCall('send_message', { text: '请接力', mention_bot_ids: [targetId] });
    const finalStep = (name: string) =>
      step().expect((r) => systemText(r).includes(`名字：${name}`)).replyText(`${name}完成`);

    llm.script('mock-main', [
      chainStep('阿甲', b.id),
      finalStep('阿甲'),
      chainStep('阿乙', c.id),
      finalStep('阿乙'),
      chainStep('阿丙', d.id),
      finalStep('阿丙'),
      chainStep('阿丁', e.id),
      finalStep('阿丁'),
    ]);

    await sendDrafts(core, conv.id, [{ text: '开始接力', mentions: [a.id] }]);
    await waitForBotRun(core, conv.id, d.id, 'completed');
    await waitFor(
      async () => ((await botRuns(core, conv.id, e.id)).length === 0 ? true : null),
      { label: 'E never triggered' },
    );

    for (const [bot, depth] of [[b, 1], [c, 2], [d, 3]] as const) {
      const runs = await botRuns(core, conv.id, bot.id);
      expect(runs[0]?.chainDepth).toBe(depth);
      expect(runs[0]?.chainId).toBeTruthy();
    }
    // The depth-limit note is visible in the tool result of D's run.
    const dRun = (await botRuns(core, conv.id, d.id))[0]!;
    const steps = await stepsOf(core, dRun.id);
    const toolResults = steps.filter((s) => s['type'] === 'tool_result');
    expect(
      toolResults.some((s) => String(s['content']).includes('已达连锁层数上限')),
    ).toBe(true);
  }, 40_000);

  it('chain token budget stops the chain', async () => {
    const { core, llm } = await start();
    const { a, b, c, conv } = await threeBots(core);

    llm.script('mock-main', [
      step().expect((r) => systemText(r).includes('名字：阿甲')).replyToolCall('send_message', {
        text: '请阿乙接手',
        mention_bot_ids: [b.id],
      }),
      step().expect((r) => systemText(r).includes('名字：阿甲')).replyText('阿甲完成'),
      step()
        .expect((r) => systemText(r).includes('名字：阿乙'))
        .replyToolCall('send_message', { text: '请阿丙接手', mention_bot_ids: [c.id] }, { prompt_tokens: 150_000, completion_tokens: 60_000 }),
      step().expect((r) => systemText(r).includes('名字：阿乙')).replyText('阿乙完成'),
    ]);

    await sendDrafts(core, conv.id, [{ text: '预算测试', mentions: [a.id] }]);
    await waitForBotRun(core, conv.id, a.id, 'completed');
    await waitForBotRun(core, conv.id, b.id, 'completed');
    await waitFor(
      async () => ((await botRuns(core, conv.id, c.id)).length === 0 ? true : null),
      { label: 'C never triggered' },
    );
    const bRun = (await botRuns(core, conv.id, b.id))[0]!;
    const steps = await stepsOf(core, bRun.id);
    expect(
      steps.some((s) => s['type'] === 'tool_result' && String(s['content']).includes('预算已用尽')),
    ).toBe(true);
  }, 40_000);

  it('an @ inside the final text does not trigger anyone', async () => {
    const { core, llm } = await start();
    const { a, b, conv } = await threeBots(core);
    llm.script('mock-main', [step().replyText(`这个问题可以问 @阿乙`)]);

    await sendDrafts(core, conv.id, [{ text: '随便说说', mentions: [a.id] }]);
    await waitForBotRun(core, conv.id, a.id, 'completed');
    await waitForMessage(core, conv.id, (m) => m.senderBotId === a.id);
    await waitFor(
      async () => ((await botRuns(core, conv.id, b.id)).length === 0 ? true : null),
      { label: 'B never triggered' },
    );
  }, 30_000);

  it('a batch flushed mid-turn is injected into the running bot and re-dispatched after the turn', async () => {
    const { core, llm } = await start();
    const { a, b, conv } = await threeBots(core);

    llm.script('mock-main', [
      step().expect((r) => systemText(r).includes('名字：阿甲')).hold().replyText('阿甲第一批'),
      step().expect((r) => systemText(r).includes('名字：阿甲')).replyText('阿甲看到追加了'),
      step().expect((r) => systemText(r).includes('名字：阿乙')).replyText('阿乙第一批'),
      step().expect((r) => systemText(r).includes('名字：阿乙')).replyText('阿乙第二批'),
    ]);

    await sendDrafts(core, conv.id, [
      { text: '第一批甲', mentions: [a.id] },
      { text: '第一批乙', mentions: [b.id] },
    ]);
    await waitForBotRun(core, conv.id, a.id, 'running');
    await waitFor(() => (llm.requestsFor('mock-main').length >= 1 ? true : null), { label: 'A first request' });

    const second = await sendDrafts(core, conv.id, [{ text: '第二批（追加了）', mentions: [b.id] }]);
    llm.releaseAll();

    await waitForBotRun(core, conv.id, a.id, 'completed');
    await waitForBotRun(core, conv.id, b.id, 'completed');
    // Re-dispatch after the turn: B executes the second batch too.
    await waitForBotRunCount(core, conv.id, b.id, 2, { timeoutMs: 20_000 });

    const requests = llm.requestsFor('mock-main');
    const aSecond = requests.filter((r) => systemText(r).includes('名字：阿甲'))[1];
    expect(aSecond).toBeTruthy();
    expect(aSecond!.lastUserText()).toContain('<new_messages>');
    expect(aSecond!.lastUserText()).toContain('第二批（追加了）');

    const bAll = await waitForBotRunCount(core, conv.id, b.id, 2);
    const secondIds = second.map((m) => m.id);
    const redispatched = bAll.find((r) => r.triggerMessageIds.length === 1 && r.triggerMessageIds[0] === secondIds[0]);
    expect(redispatched).toBeTruthy();
    expect(redispatched!.triggerReason).toBe('mention');
    // A was injected with the second batch mid-run, so it is not re-triggered.
    expect(await botRuns(core, conv.id, a.id)).toHaveLength(1);
  }, 40_000);

  it('removing a queued bot skips it; removing the running bot cancels it and the next continues', async () => {
    const { core, llm } = await start();
    const { a, b, conv } = await threeBots(core);

    // Case 1: B queued behind A; B removed before its slot.
    llm.script('mock-main', [
      step().expect((r) => systemText(r).includes('名字：阿甲')).hold().replyText('阿甲完成'),
      step().expect((r) => systemText(r).includes('名字：阿乙')).replyText('阿乙不应执行'),
    ]);
    await sendDrafts(core, conv.id, [
      { text: '先甲后乙', mentions: [a.id, b.id] },
    ]);
    await waitForBotRun(core, conv.id, a.id, 'running');
    await waitFor(() => (llm.requestsFor('mock-main').length >= 1 ? true : null), { label: 'A request' });
    await core.rpc.call('groups.removeMember', { conversationId: conv.id, botId: b.id });
    llm.releaseAll();
    await waitForBotRun(core, conv.id, a.id, 'completed');
    await waitFor(
      async () => ((await botRuns(core, conv.id, b.id)).length === 0 ? true : null),
      { label: 'B skipped' },
    );

    // Case 2: A running; A removed -> its run is cancelled, next member continues.
    const b2 = await makeBot(core, '阿乙二号');
    await core.rpc.call('groups.addMembers', { conversationId: conv.id, botIds: [b2.id] });
    llm.script('mock-main', [
      step().expect((r) => systemText(r).includes('名字：阿甲')).hold().replyText('阿甲将被取消'),
      step().expect((r) => systemText(r).includes('名字：阿乙二号')).replyText('阿乙二号接棒'),
    ]);
    await sendDrafts(core, conv.id, [
      { text: '再试一次', mentions: [a.id, b2.id] },
    ]);
    await waitForBotRun(core, conv.id, a.id, 'running');
    await waitFor(() => (llm.requestsFor('mock-main').length >= 2 ? true : null), { label: 'A second request' });
    await core.rpc.call('groups.removeMember', { conversationId: conv.id, botId: a.id });
    const aRun = await waitForBotRun(core, conv.id, a.id, 'cancelled');
    expect(aRun).toBeTruthy();
    await waitForBotRun(core, conv.id, b2.id, 'completed');
    await waitForMessage(core, conv.id, (m) => m.senderBotId === b2.id);
    llm.releaseAll();
  }, 40_000);

  it('removing a member cleans workspace, grants and pending approvals; re-added bot searches full history', async () => {
    const { core, llm } = await start();
    const { a, b, conv } = await threeBots(core);
    const paths = core.services.paths;

    await sendDrafts(core, conv.id, [{ text: '历史消息：独特关键词 zebra_marker', mentions: [a.id] }]);
    llm.script('mock-main', [step().replyText('收到历史消息')]);
    await waitForBotRun(core, conv.id, a.id, 'completed');

    // B runs once: reads an out-of-workspace path -> approval -> approved for
    // the conversation (grant), then finishes.
    const outsideDir = mkdtempSync(path.join(tmpdir(), 'group-outside-'));
    const outsideFile = path.join(outsideDir, 'secret.txt');
    writeFileSync(outsideFile, '机密内容');
    llm.script('mock-main', [
      step().expect((r) => systemText(r).includes('名字：阿乙')).replyToolCall('read', { path: outsideFile }),
      step().expect((r) => systemText(r).includes('名字：阿乙')).replyText('读到了'),
    ]);
    await sendDrafts(core, conv.id, [{ text: '读一下那个文件', mentions: [b.id] }]);
    await waitForEvent(core, 'approval.created', (p) => p.approval.botId === b.id);
    const approvals = (await core.rpc.call('approvals.list', { conversationId: conv.id })) as {
      approvals: Array<{ id: string; status: string }>;
    };
    const pending = approvals.approvals.find((x) => x.status === 'pending');
    expect(pending).toBeTruthy();
    await core.rpc.call('approvals.decide', { id: pending!.id, approve: true, duration: 'conversation' });
    await waitForBotRun(core, conv.id, b.id, 'completed');

    const workspaceDir = path.join(paths.home, 'bots', b.id, 'workspaces', conv.id);
    expect(existsSync(workspaceDir)).toBe(true);
    let grants = (await core.rpc.call('grants.list', { conversationId: conv.id })) as {
      grants: Array<{ botId: string }>;
    };
    expect(grants.grants.some((g) => g.botId === b.id)).toBe(true);

    // Second run leaves a pending approval behind when the member is removed.
    const outsideFile2 = path.join(outsideDir, 'another.txt');
    writeFileSync(outsideFile2, '其他内容');
    llm.script('mock-main', [
      step().expect((r) => systemText(r).includes('名字：阿乙')).replyToolCall('read', { path: outsideFile2 }),
      step().expect((r) => systemText(r).includes('名字：阿乙')).replyText('不会走到这里'),
    ]);
    await sendDrafts(core, conv.id, [{ text: '再读一个文件', mentions: [b.id] }]);
    await waitForEvent(
      core,
      'approval.created',
      (p) =>
        p.approval.botId === b.id &&
        (p.approval.payload as { path?: string } | undefined)?.path === realpathSync(outsideFile2),
    );

    await core.rpc.call('groups.removeMember', { conversationId: conv.id, botId: b.id });

    expect(existsSync(workspaceDir)).toBe(false);
    grants = (await core.rpc.call('grants.list', { conversationId: conv.id })) as {
      grants: Array<{ botId: string }>;
    };
    expect(grants.grants.some((g) => g.botId === b.id)).toBe(false);
    const after = (await core.rpc.call('approvals.list', { conversationId: conv.id })) as {
      approvals: Array<{ botId: string | null; status: string; payload: { path?: string } }>;
    };
    expect(
      after.approvals.some(
        (x) => x.payload?.path === realpathSync(outsideFile2) && x.status === 'cancelled',
      ),
    ).toBe(true);

    // Re-added: the bot reads the FULL history again (search finds pre-removal messages).
    await core.rpc.call('groups.addMembers', { conversationId: conv.id, botIds: [b.id] });
    llm.script('mock-main', [
      step().expect((r) => systemText(r).includes('名字：阿乙')).replyToolCall('search_messages', { query: 'zebra_marker' }),
      step().expect((r) => systemText(r).includes('名字：阿乙')).replyText('查到了历史消息'),
    ]);
    await sendDrafts(core, conv.id, [{ text: '你记得之前那条消息吗', mentions: [b.id] }]);
    const searchRun = await waitFor(
      async () => {
        const runs = await botRuns(core, conv.id, b.id);
        const newest = runs[0];
        return newest && newest.status === 'completed' && runs.length >= 3 ? newest : null;
      },
      { label: 'search run completed' },
    );
    const searchSteps = await stepsOf(core, searchRun.id);
    expect(
      searchSteps.some(
        (s) => s['type'] === 'tool_result' && String(s['content']).includes('zebra_marker'),
      ),
    ).toBe(true);
    rmSync(outsideDir, { recursive: true, force: true });
  }, 60_000);

  it('a group-bound project is shared by all members and still lease-protected', async () => {
    const { core, llm } = await start();
    const { a, b, conv } = await threeBots(core);

    const projectDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'group-project-')));
    const selected = (await core.rpc.call('projects.select', {
      conversationId: conv.id,
      path: projectDir,
    })) as { project: { id: string; path: string } };
    expect(selected.project.path).toBe(projectDir);

    // One script for the whole scenario: script() replaces the queue, so the
    // held step for A must live in the same queue as B's later steps.
    llm.script('mock-main', [
      step().expect((r) => systemText(r).includes('名字：阿甲')).replyToolCall('write', {
        path: 'from-group.txt',
        content: '群聊成员甲写入',
      }),
      step().expect((r) => systemText(r).includes('名字：阿甲')).hold().replyText('甲完成'),
      step().expect((r) => systemText(r).includes('名字：阿乙')).replyToolCall('write', {
        path: 'from-direct.txt',
        content: '乙写入',
      }),
      step().expect((r) => systemText(r).includes('名字：阿乙')).replyText('乙完成'),
    ]);
    await sendDrafts(core, conv.id, [{ text: '建一个文件', mentions: [a.id] }]);
    await waitFor(
      () => (existsSync(path.join(projectDir, 'from-group.txt')) ? true : null),
      { label: 'A group write' },
    );

    // While A still holds the lease, a run from B (direct conversation bound to
    // the same project) waits for the lease.
    const direct = await (async () => {
      const result = (await core.rpc.call('conversations.openDirect', { botId: b.id })) as {
        conversation: { id: string };
      };
      return result.conversation;
    })();
    await core.rpc.call('projects.select', { conversationId: direct.id, path: projectDir });
    const leaseEventPromise = waitForEvent(core, 'lease.waiting', (p) => p.conversationId === direct.id);
    await sendDrafts(core, direct.id, [{ text: '你也写一个' }]);
    await waitFor(
      async () =>
        (await listRuns(core, direct.id)).find((r) => r.status === 'waiting_lease') ?? null,
      { label: 'B waiting for lease' },
    );
    const leaseEvent = await leaseEventPromise;

    llm.releaseAll();
    await waitForBotRun(core, conv.id, a.id, 'completed');
    const bRun = await waitFor(
      async () =>
        (await listRuns(core, direct.id)).find((r) => r.botId === b.id && r.status === 'completed') ?? null,
      { label: 'B completes after lease' },
    );
    expect(bRun).toBeTruthy();
    expect(leaseEvent.holder.botId).toBe(a.id);
    expect(existsSync(path.join(projectDir, 'from-direct.txt'))).toBe(true);
    rmSync(projectDir, { recursive: true, force: true });
  }, 60_000);

  it('group.turn events report triage, current bot and queue', async () => {
    const { core, llm } = await start();
    const { a, b, conv } = await threeBots(core);

    llm.script('mock-main', [
      step().expect((r) => systemText(r).includes('名字：阿甲')).hold().replyText('甲完成'),
      step().expect((r) => systemText(r).includes('名字：阿乙')).replyText('乙完成'),
    ]);
    const runningEvent = waitForEvent(
      core,
      'group.turn',
      (p) => p.phase === 'running' && p.currentBotId === a.id && p.queue.includes(b.id),
      {},
    );
    await sendDrafts(core, conv.id, [
      { text: '甲先乙后', mentions: [a.id, b.id] },
    ]);
    const running = await runningEvent;
    expect(running.batchId).toBeTruthy();
    const idlePromise = waitForEvent(
      core,
      'group.turn',
      (p) => p.phase === 'idle' && p.queue.length === 0 && p.currentBotId === null,
      { timeoutMs: 20_000 },
    );
    llm.releaseAll();
    await idlePromise;
    await waitForBotRun(core, conv.id, a.id, 'completed');
    await waitForBotRun(core, conv.id, b.id, 'completed');
  }, 30_000);

  // --- 审查修复回归（BR-P05-001/002/003/004） ---------------------------------

  it('deleting the conversation mid-turn spawns no new runs and no model requests', async () => {
    const { core, llm } = await start();
    const { a, b, conv } = await threeBots(core);
    llm.script('mock-main', [
      step().expect((r) => systemText(r).includes('名字：阿甲')).hold().replyText('甲将被中止'),
    ]);

    await sendDrafts(core, conv.id, [{ text: '先甲后乙', mentions: [a.id, b.id] }]);
    await waitForBotRun(core, conv.id, a.id, 'running');
    await waitFor(() => (llm.requestsFor('mock-main').length >= 1 ? true : null), { label: 'A request' });

    // New runs start as queued; any spawn during teardown shows up here.
    const spawned: Run[] = [];
    const off = core.onEvent('run.status', (p) => {
      const run = (p as { run: Run }).run;
      if (run.status === 'queued') spawned.push(run);
    });
    await core.rpc.call('conversations.delete', { id: conv.id });
    await waitForBotRun(core, conv.id, a.id, 'cancelled').catch(() => null);
    await new Promise((r) => setTimeout(r, 1_000));
    off();

    expect(spawned).toHaveLength(0);
    expect(llm.requestsFor('mock-main')).toHaveLength(1);
    // The turn finished without delivering to B: no reply beyond the original.
    const messages = await listMessages(core, conv.id);
    expect(messages.some((m) => m.senderType === 'bot')).toBe(false);
    llm.releaseAll();
  }, 30_000);

  it('deleting during triage neither posts the no-claim message nor starts a turn', async () => {
    const { core, llm } = await start();
    const { conv } = await threeBots(core);

    llm.script('mock-light', [
      step().expect((r) => r.lastUserText().includes('你的名片：阿甲')).hold(),
      step().expect((r) => r.lastUserText().includes('你的名片：阿乙')).replyJson({ decision: 'not_mine', confidence: 0.5, reason: '不归我' }),
      step().expect((r) => r.lastUserText().includes('你的名片：阿丙')).replyJson({ decision: 'not_mine', confidence: 0.5, reason: '不归我' }),
    ]);
    await sendBatchless(core, conv.id, '需要有人处理');
    await waitFor(() => (llm.requestsFor('mock-light').length >= 3 ? true : null), { label: 'triage wave' });

    await core.rpc.call('conversations.delete', { id: conv.id });
    llm.releaseAll();
    await new Promise((r) => setTimeout(r, 1_000));

    // The cleared coordinator must not react to the late triage completion:
    // no system message, no response run, no model request.
    expect(llm.requestsFor('mock-main')).toHaveLength(0);
  }, 30_000);

  it('a chain run holding the mailbox does not absorb the turn delivery (BR-P05-002)', async () => {
    const { core, llm } = await start();
    const { a, b, conv } = await threeBots(core);

    const aFinal = step().expect((r) => systemText(r).includes('名字：阿甲')).hold().replyText('甲完成');
    const bChain = step().expect((r) => systemText(r).includes('名字：阿乙')).hold().replyText('乙连锁');
    llm.script('mock-main', [
      step().expect((r) => systemText(r).includes('名字：阿甲')).replyToolCall('send_message', {
        text: '请阿乙先看连锁',
        mention_bot_ids: [b.id],
      }),
      aFinal,
      bChain,
      step().expect((r) => systemText(r).includes('名字：阿乙')).replyText('乙轮次'),
    ]);

    const batch = await sendDrafts(core, conv.id, [
      { text: '轮次批次给乙', mentions: [a.id, b.id] },
    ]);
    await waitForBotRun(core, conv.id, a.id, 'running');
    await waitFor(() => (llm.requestsFor('mock-main').length >= 3 ? true : null), { label: 'A final + B chain held' });

    // A finishes while B's chain run still holds B's mailbox.
    aFinal.release();
    await waitForBotRun(core, conv.id, a.id, 'completed');
    await new Promise((r) => setTimeout(r, 800));
    // The turn waits (no fresh delivery steered into the chain run).
    expect(await botRuns(core, conv.id, b.id)).toHaveLength(1);
    // The chain run was never steered: no <new_messages> injection anywhere.
    const chainRequests = llm.requestsFor('mock-main').filter((r) => systemText(r).includes('名字：阿乙'));
    expect(chainRequests.length).toBeGreaterThanOrEqual(1);
    expect(chainRequests.every((r) => !r.lastUserText().includes('<new_messages>'))).toBe(true);

    // Chain run ends -> mailbox idle -> the turn delivers as its own run.
    bChain.release();
    const bRuns = await waitForBotRunCount(core, conv.id, b.id, 2, { timeoutMs: 20_000 });
    const turnRun = bRuns[0]!; // newest first
    expect(turnRun.triggerReason).toBe('mention');
    expect(turnRun.chainId).toBe(null);
    expect(turnRun.triggerMessageIds).toEqual(batch.map((m) => m.id));
    const chainRun = bRuns[1]!;
    expect(chainRun.triggerReason).toBe('chain');
  }, 40_000);

  it('chain budget counts the root run usage across runs (BR-P05-003)', async () => {
    const { core, llm } = await start();
    const { a, b, c, conv } = await threeBots(core);

    llm.script('mock-main', [
      step().expect((r) => systemText(r).includes('名字：阿甲')).replyToolCall('send_message', {
        text: '请阿乙接手',
        mention_bot_ids: [b.id],
      }, { prompt_tokens: 100_000, completion_tokens: 50_000 }),
      step().expect((r) => systemText(r).includes('名字：阿甲')).replyText('甲完成'),
      step().expect((r) => systemText(r).includes('名字：阿乙')).replyToolCall('send_message', {
        text: '请阿丙接手',
        mention_bot_ids: [c.id],
      }, { prompt_tokens: 60_000, completion_tokens: 0 }),
      step().expect((r) => systemText(r).includes('名字：阿乙')).replyText('乙完成'),
    ]);

    await sendDrafts(core, conv.id, [{ text: '预算含根 run', mentions: [a.id] }]);
    await waitForBotRun(core, conv.id, a.id, 'completed');
    await waitForBotRun(core, conv.id, b.id, 'completed');
    await waitFor(
      async () => ((await botRuns(core, conv.id, c.id)).length === 0 ? true : null),
      { label: 'C never triggered' },
    );

    // The root run is bound to the chain (depth 0) with the same chain id.
    const aRun = (await botRuns(core, conv.id, a.id))[0]!;
    const bRun = (await botRuns(core, conv.id, b.id))[0]!;
    expect(aRun.chainId).toBeTruthy();
    expect(aRun.chainDepth).toBe(0);
    expect(bRun.chainId).toBe(aRun.chainId);
    expect(bRun.chainDepth).toBe(1);
    const bSteps = await stepsOf(core, bRun.id);
    expect(
      bSteps.some((s) => s['type'] === 'tool_result' && String(s['content']).includes('预算已用尽')),
    ).toBe(true);
  }, 40_000);

  it('editing a delivered user message in a group re-dispatches it (BR-P05-004)', async () => {
    const { core, llm } = await start();
    const { a, conv } = await threeBots(core);

    llm.script('mock-main', [
      step().expect((r) => systemText(r).includes('名字：阿甲')).replyText('第一次回复'),
      step().expect((r) => systemText(r).includes('名字：阿甲')).replyText('编辑后的回复'),
    ]);
    const batch = await sendDrafts(core, conv.id, [{ text: '原始消息', mentions: [a.id] }]);
    await waitForBotRun(core, conv.id, a.id, 'completed');

    await core.rpc.call('messages.edit', { id: batch[0]!.id, text: '编辑后的消息' });
    const aRuns = await waitForBotRunCount(core, conv.id, a.id, 2, { timeoutMs: 20_000 });
    const second = aRuns[0]!; // newest first
    expect(second.triggerMessageIds).toEqual([batch[0]!.id]);
    expect(second.triggerReason).toBe('mention');
    await waitForMessage(core, conv.id, (m) => m.senderBotId === a.id);
    const editedBubble = await waitForMessage(
      core,
      conv.id,
      (m) => m.senderType === 'bot' && 'text' in m.content && m.content.text === '编辑后的回复',
    );
    expect(editedBubble).toBeTruthy();
  }, 30_000);

  it('deleting a bot pushes conversation.updated for every group it was in (03-data-model 删除 Bot)', async () => {
    const { core } = await start();
    const { a, b, c, conv } = await threeBots(core);

    // 删除级联先删成员行；开放中的群 UI 依赖该事件重载成员列表——已删除 Bot
    // 从成员卡/@ 候选消失，其历史消息发送者回退为 id（设计/01 删除 Bot）。
    const groupUpdated = waitForEvent<{ conversation: { id: string; type: string } }>(
      core,
      'conversation.updated',
      (p) => p.conversation.id === conv.id,
    );
    const deleted = waitForEvent<{ id: string }>(
      core,
      'bot.deleted',
      (p) => p.id === a.id,
    );
    await core.rpc.call('bots.delete', { id: a.id });
    expect((await groupUpdated).conversation.type).toBe('group');
    await deleted;

    const members = (await core.rpc.call('conversations.members', {
      conversationId: conv.id,
    })) as { members: Array<{ bot: { id: string } }> };
    expect(members.members.map((m) => m.bot.id).sort()).toEqual([b.id, c.id].sort());
    // Bot 行转为占位（仅剩 id），供历史消息渲染发送者。
    const placeholder = (await core.rpc.call('bots.get', { id: a.id })) as {
      bot: { status: string; name: string };
    };
    expect(placeholder.bot.status).toBe('deleted');
    expect(placeholder.bot.name).toBe('');
  }, 20_000);
});

// -- helpers ------------------------------------------------------------------


/** Flushes a single draft without mentions (group broadcast batch). */
async function sendBatchless(
  core: TestStack['core'],
  conversationId: string,
  text: string,
): Promise<void> {
  await sendDrafts(core, conversationId, [{ text }]);
}

/** Resolves when the bot has at least `count` response runs. */
async function waitForBotRunCount(
  core: TestStack['core'],
  conversationId: string,
  botId: string,
  count: number,
  options: { timeoutMs?: number } = {},
): Promise<Run[]> {
  return waitFor(async () => {
    const runs = await botRuns(core, conversationId, botId);
    return runs.length >= count ? runs : null;
  }, { ...options, label: `${count} response runs of ${botId}` });
}
