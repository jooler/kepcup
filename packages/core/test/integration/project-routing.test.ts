import { afterEach, describe, expect, it } from 'vitest';
import type { Conversation, Run } from '@kepcup/shared';
import {
  createTestStack,
  listMessages,
  listRuns,
  makeBot,
  makeProject,
  sendDrafts,
  step,
  waitFor,
  waitForMessage,
  type TestStack,
} from '@kepcup/testkit';

/**
 * D92 T1a silent routing end to end (WP3 §5.6): one project team — lead L
 * (阿领), members M (阿甲) and N (阿乙). Every scenario drives the real core
 * (mailbox → ProjectTurnCoordinator → gate/continuation → turn) against the
 * mock LLM and asserts the routing invariants: silence in the UI, run-row
 * reasons, must-reply toolsets and the guarded lead fallback.
 */

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

/** Supervisor-turn request of one bot (its name sits in the system prompt). */
function turnRequestsOf(llm: TestStack['llm'], name: string) {
  return llm.requestsFor('mock-main').filter((r) => systemText(r).includes(`名字：${name}`));
}

function toolNames(request: { body: { tools?: unknown } }): string[] {
  return ((request.body.tools ?? []) as Array<{ function?: { name?: string } }>)
    .map((t) => t.function?.name ?? '')
    .filter((name) => name.length > 0);
}

/** Turn run of one bot in one conversation with the given status. */
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
    { ...options, label: `turn run of ${botId} in ${status}` },
  );
}

async function turnRuns(core: TestStack['core'], conversationId: string): Promise<Run[]> {
  return (await listRuns(core, conversationId)).filter((r) => r.loopType === 'turn');
}

async function team(core: TestStack['core']): Promise<{
  lead: Awaited<ReturnType<typeof makeBot>>;
  m: Awaited<ReturnType<typeof makeBot>>;
  n: Awaited<ReturnType<typeof makeBot>>;
  conv: Conversation;
}> {
  const lead = await makeBot(core, '阿领');
  const m = await makeBot(core, '阿甲');
  const n = await makeBot(core, '阿乙');
  const conv = await makeProject(core, '项目组', [lead.id, m.id, n.id], { leadBotId: lead.id });
  return { lead, m, n, conv };
}

/** The gate request of the lead (its user message carries the member roster). */
function gateRequests(llm: TestStack['llm']) {
  return llm.requestsFor('mock-light').filter((r) => r.lastUserText().includes('成员名册：'));
}

/** The continuation-check request of one member (its card opens the user message). */
function continuationRequests(llm: TestStack['llm'], name: string) {
  return llm.requestsFor('mock-light').filter((r) => r.lastUserText().includes(`你的名片：${name}`));
}

describe('project silent routing (D92 T1a WP3)', () => {
  it('① a message @-ing nobody with no prior reply: the gate routes to M, who answers (routed, must reply)', async () => {
    const { core, llm } = await start();
    const { lead, m, conv } = await team(core);
    const phases: string[] = [];
    core.onEvent('project.turn', (payload) => {
      phases.push((payload as { phase: string }).phase);
    });

    llm.script('mock-light', [
      step()
        .expect((r) => r.lastUserText().includes('成员名册：'))
        .replyJson({ decision: 'route', targets: [m.id], reason: '归阿甲' }),
    ]);
    llm.script('mock-main', [
      step().expect((r) => systemText(r).includes('名字：阿甲')).replyText('阿甲来答'),
    ]);

    await sendDrafts(core, conv.id, [{ text: '这个谁来处理' }]);
    const run = await waitForBotRun(core, conv.id, m.id, 'completed');
    expect(run.triggerReason).toBe('routed');

    // Silence in the UI: the visible message list is exactly the user message
    // and M's reply — nothing from the lead, no system message, no card.
    const messages = await listMessages(core, conv.id);
    expect(
      messages.map((msg) => [msg.senderType, msg.senderBotId, msg.kind]),
    ).toEqual([
      ['user', null, 'text'],
      ['bot', m.id, 'text'],
    ]);
    // The gate's own run is on record (triage loop, routing_gate), the lead
    // never got a supervisor turn.
    const gateRun = (await listRuns(core, conv.id)).find((r) => r.loopType === 'triage');
    expect(gateRun).toMatchObject({ botId: lead.id, triggerReason: 'routing_gate' });
    expect((await turnRuns(core, conv.id)).map((r) => r.botId)).toEqual([m.id]);

    // The phase walked routing -> running.
    expect(phases[0]).toBe('routing');
    expect(phases).toContain('running');

    // `routed` is a must-reply reason: no skip_reply in M's turn tools.
    const mRequest = turnRequestsOf(llm, '阿甲').at(-1)!;
    expect(toolNames(mRequest)).not.toContain('skip_reply');
  }, 30_000);

  it('② a claiming last replier continues the conversation (continuation, skip_reply available)', async () => {
    const { core, llm } = await start();
    const { m, conv } = await team(core);

    // M replies once (explicit @) so it becomes the last replier.
    llm.script('mock-main', [
      step().expect((r) => systemText(r).includes('名字：阿甲')).replyText('阿甲先答一轮'),
    ]);
    await sendDrafts(core, conv.id, [{ text: '阿甲你在吗', mentions: [m.id] }]);
    await waitForBotRun(core, conv.id, m.id, 'completed');

    llm.script('mock-light', [
      step()
        .expect((r) => r.lastUserText().includes('你的名片：阿甲'))
        .replyJson({ decision: 'respond', confidence: 0.9, reason: '在延续我的工作' }),
    ]);
    llm.script('mock-main', [
      step().expect((r) => systemText(r).includes('名字：阿甲')).replyText('阿甲继续'),
    ]);

    await sendDrafts(core, conv.id, [{ text: '接着说说刚才的' }]);
    // Wait for the SECOND M run (the first one is the earlier @ turn).
    const continuationRun = await waitFor(
      async () =>
        (await listRuns(core, conv.id)).find(
          (r) => r.botId === m.id && r.loopType === 'turn' && r.triggerReason === 'continuation' &&
            r.status === 'completed',
        ) ?? null,
      { label: 'continuation turn of M' },
    );
    expect(continuationRun.triggerReason).toBe('continuation');
    // No gate ran at all.
    expect(
      (await listRuns(core, conv.id)).filter((r) => r.triggerReason === 'routing_gate'),
    ).toEqual([]);
    expect(continuationRequests(llm, '阿甲')).toHaveLength(1);
    expect(gateRequests(llm)).toHaveLength(0);
    // `continuation` may skip: skip_reply IS in the tools.
    const mRequest = turnRequestsOf(llm, '阿甲').at(-1)!;
    expect(toolNames(mRequest)).toContain('skip_reply');
  }, 30_000);

  it('③ an unclaimed continuation degrades to the gate, whose self hands the lead a must-reply turn', async () => {
    const { core, llm } = await start();
    const { lead, m, conv } = await team(core);

    llm.script('mock-main', [
      step().expect((r) => systemText(r).includes('名字：阿甲')).replyText('阿甲先答一轮'),
    ]);
    await sendDrafts(core, conv.id, [{ text: '阿甲你在吗', mentions: [m.id] }]);
    await waitForBotRun(core, conv.id, m.id, 'completed');

    llm.script('mock-light', [
      step()
        .expect((r) => r.lastUserText().includes('你的名片：阿甲'))
        .replyJson({ decision: 'not_mine', confidence: 0.9, reason: '是别人的事' }),
      step()
        .expect((r) => r.lastUserText().includes('成员名册：'))
        .replyJson({ decision: 'self', targets: [], reason: '整体问题归我' }),
    ]);
    llm.script('mock-main', [
      step().expect((r) => systemText(r).includes('名字：阿领')).replyText('阿领来答'),
    ]);

    await sendDrafts(core, conv.id, [{ text: '那这个项目整体怎么样了' }]);
    const leadRun = await waitForBotRun(core, conv.id, lead.id, 'completed');
    expect(leadRun.triggerReason).toBe('lead_fallback');
    expect(continuationRequests(llm, '阿甲')).toHaveLength(1);
    expect(gateRequests(llm)).toHaveLength(1);
    // Must reply: no skip_reply; the reply is visible.
    const leadRequest = turnRequestsOf(llm, '阿领').at(-1)!;
    expect(toolNames(leadRequest)).not.toContain('skip_reply');
    await waitForMessage(core, conv.id, (msg) => msg.senderBotId === lead.id);
  }, 30_000);

  it('④ a gate none ends silently with no trace; the next message still routes', async () => {
    const { core, llm } = await start();
    const { m, conv } = await team(core);

    llm.script('mock-light', [
      step()
        .expect((r) => r.lastUserText().includes('成员名册：'))
        .replyJson({ decision: 'none', targets: [], reason: '纯致谢' }),
      step()
        .expect((r) => r.lastUserText().includes('成员名册：'))
        .replyJson({ decision: 'route', targets: [m.id], reason: '这次归阿甲' }),
    ]);
    llm.script('mock-main', [
      step().expect((r) => systemText(r).includes('名字：阿甲')).replyText('阿甲来答'),
    ]);

    await sendDrafts(core, conv.id, [{ text: '谢谢大家' }]);
    await waitFor(
      async () => {
        const runs = await listRuns(core, conv.id);
        return runs.some((r) => r.triggerReason === 'routing_gate' && r.status === 'completed')
          ? true
          : null;
      },
      { label: 'gate run settled' },
    );
    // Give any wrongly dispatched turn time to appear; there must be none.
    await new Promise((r) => setTimeout(r, 800));
    expect(await turnRuns(core, conv.id)).toEqual([]);
    const messagesAfterThanks = await listMessages(core, conv.id);
    expect(messagesAfterThanks.map((msg) => msg.senderType)).toEqual(['user']);

    // Not stuck: the next batchless message routes normally.
    await sendDrafts(core, conv.id, [{ text: '这个请处理一下' }]);
    const run = await waitForBotRun(core, conv.id, m.id, 'completed');
    expect(run.triggerReason).toBe('routed');
  }, 30_000);

  it('⑤ a routed member with no visible reply falls back to the lead exactly once', async () => {
    const { core, llm } = await start();
    const { lead, m, conv } = await team(core);

    llm.script('mock-light', [
      step()
        .expect((r) => r.lastUserText().includes('成员名册：'))
        .replyJson({ decision: 'route', targets: [m.id], reason: '归阿甲' }),
    ]);
    llm.script('mock-main', [
      // M's must-reply turn produces an empty final text: no visible reply.
      step().expect((r) => systemText(r).includes('名字：阿甲')).replyText(''),
      // The guarded round falls through to the lead once.
      step().expect((r) => systemText(r).includes('名字：阿领')).replyText('阿领兜底回复'),
    ]);

    await sendDrafts(core, conv.id, [{ text: '帮我看看这个' }]);
    const mRun = await waitForBotRun(core, conv.id, m.id, 'completed');
    expect(mRun.triggerReason).toBe('routed');
    const leadRun = await waitForBotRun(core, conv.id, lead.id, 'completed');
    expect(leadRun.triggerReason).toBe('lead_fallback');
    // Exactly one fallback (run ids are time-ordered ULIDs): M silent again
    // would not re-run anything — but the lead replied, so the round settles
    // as replied either way.
    const allTurns = (await turnRuns(core, conv.id)).sort((x, y) => (x.id < y.id ? -1 : 1));
    expect(allTurns.map((r) => [r.botId, r.triggerReason])).toEqual([
      [m.id, 'routed'],
      [lead.id, 'lead_fallback'],
    ]);
    await waitForMessage(core, conv.id, (msg) => msg.senderBotId === lead.id);
  }, 30_000);

  it('⑥ an explicit @ never runs the continuation check or the gate', async () => {
    const { core, llm } = await start();
    const { n, conv } = await team(core);

    llm.script('mock-main', [
      step().expect((r) => systemText(r).includes('名字：阿乙')).replyText('阿乙来答'),
    ]);
    await sendDrafts(core, conv.id, [{ text: '阿乙你来', mentions: [n.id] }]);
    await waitForBotRun(core, conv.id, n.id, 'completed');
    expect(
      (await listRuns(core, conv.id)).filter((r) => r.loopType === 'triage'),
    ).toEqual([]);
    const run = await waitForBotRun(core, conv.id, n.id, 'completed');
    expect(run.triggerReason).toBe('mention');
  }, 30_000);

  it('⑦ the lead turns a full reply into a visible @ via send_message (bot_mention, episode hop 1)', async () => {
    const { core, llm } = await start();
    const { lead, m, conv } = await team(core);

    llm.script('mock-light', [
      step()
        .expect((r) => r.lastUserText().includes('成员名册：'))
        .replyJson({ decision: 'self', targets: [], reason: '我说明一下' }),
    ]);
    llm.script('mock-main', [
      step()
        .expect((r) => systemText(r).includes('名字：阿领'))
        .replyToolCall('send_message', {
          text: '请阿甲帮忙看一下',
          mention_bot_ids: [m.id],
        }),
      step().expect((r) => systemText(r).includes('名字：阿领')).replyText('阿领说明完毕'),
      step().expect((r) => systemText(r).includes('名字：阿甲')).replyText('阿甲收到'),
    ]);

    await sendDrafts(core, conv.id, [{ text: '这个项目谁来盯' }]);
    const leadRun = await waitForBotRun(core, conv.id, lead.id, 'completed');
    expect(leadRun.triggerReason).toBe('lead_fallback');
    const mRun = await waitForBotRun(core, conv.id, m.id, 'completed');
    expect(mRun.triggerReason).toBe('bot_mention');
    expect(mRun.episodeId).toBeTruthy();
    expect(mRun.episodeHop).toBe(1);
    await waitForMessage(core, conv.id, (msg) => msg.senderBotId === lead.id && msg.mentions.includes(m.id));
  }, 30_000);

  it('⑧ an unparsable gate verdict degrades to the lead (the message is never dropped)', async () => {
    const { core, llm } = await start();
    const { lead, conv } = await team(core);

    llm.script('mock-light', [
      step().expect((r) => r.lastUserText().includes('成员名册：')).replyText('完全不是 JSON'),
    ]);
    llm.script('mock-main', [
      step().expect((r) => systemText(r).includes('名字：阿领')).replyText('阿领接住'),
    ]);

    await sendDrafts(core, conv.id, [{ text: '这个没人认领吧' }]);
    const leadRun = await waitForBotRun(core, conv.id, lead.id, 'completed');
    expect(leadRun.triggerReason).toBe('lead_fallback');
    expect((await listRuns(core, conv.id)).find((r) => r.loopType === 'triage')).toMatchObject({
      status: 'failed',
      triggerReason: 'routing_gate',
    });
    await waitForMessage(core, conv.id, (msg) => msg.senderBotId === lead.id);
  }, 30_000);

  it('⑨ a workbench dispatch naming the responsible bot goes to it directly, without routing', async () => {
    const { core, llm } = await start();
    const { m, conv } = await team(core);

    llm.script('mock-main', [
      step().expect((r) => systemText(r).includes('名字：阿甲')).replyText('阿甲盘点完成'),
    ]);
    await core.rpc.call('todos.create', {
      title: '盘点库存',
      assignee: { kind: 'group', conversationId: conv.id, leadBotId: m.id },
      when: 'now',
    });

    const run = await waitForBotRun(core, conv.id, m.id, 'completed');
    expect(run.triggerReason).toBe('mention');
    expect(
      (await listRuns(core, conv.id)).filter((r) => r.loopType === 'triage'),
    ).toEqual([]);
    await waitForMessage(core, conv.id, (msg) => msg.senderBotId === m.id);
  }, 30_000);
});
