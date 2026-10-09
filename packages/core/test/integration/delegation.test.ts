import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DELEGATION_FOLLOWUP_EVENT,
  DELEGATION_RESULT_MAX_CHARS,
  type Bot,
  type Delegation,
  type Message,
} from '@kepcup/shared';
import { createMemoryKeystore } from '@kepcup/core';
import {
  createTestStack,
  listAllMessages,
  listMessages,
  makeBot,
  openDirect,
  sendBatch,
  step,
  waitFor,
  waitForRun,
  type MockChatRequest,
  type TestStack,
} from '@kepcup/testkit';

/**
 * 跨 Bot 委派 A→B（D71，docs/design/27 §3，todo P3）：异步工具、投递闸门
 * （B 忙 / 免打扰排队）、B 侧用户代发消息、A 侧发出卡 + 截断结果卡、internal
 * follow-up、取消、删除级联、重启恢复。全程 mock LLM（A、B 共用 mock-main，
 * 用请求内容区分谁在请求）。
 */

const stacks: TestStack[] = [];
const homes: string[] = [];

afterEach(async () => {
  for (const stack of stacks.splice(0)) await stack.cleanup();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function start(options: Parameters<typeof createTestStack>[0] = {}): Promise<TestStack> {
  const stack = await createTestStack(options);
  stacks.push(stack);
  return stack;
}

const body = (req: MockChatRequest) => JSON.stringify(req.body.messages);
/** B's delegated run: its trigger carries reason="delegation". */
const isDelegatedTrigger = (req: MockChatRequest) =>
  req.lastUserText().includes('<trigger reason="delegation"');
/** A's follow-up run: the injected delegation_result event. */
const isFollowUp = (req: MockChatRequest) => req.lastUserText().includes('委派结果通知');
/** A's second LLM turn in the delegating run: the tool result is in context. */
const isAfterDelegateCall = (req: MockChatRequest) =>
  body(req).includes('delegation_id') && !isFollowUp(req) && !isDelegatedTrigger(req);

interface Pair {
  a: Bot;
  b: Bot;
  aConv: string;
}

async function pair(stack: TestStack): Promise<Pair> {
  const a = await makeBot(stack.core, '小甲');
  const b = await makeBot(stack.core, '小乙');
  const aConv = (await openDirect(stack.core, a.id)).id;
  return { a, b, aConv };
}

function delegationsOf(stack: TestStack): Delegation[] {
  const db = stack.core.services.domain!.delegations;
  return (
    stack.core.services.mainDb!.prepare('select id from delegations order by created_at').all() as Array<{
      id: string;
    }>
  ).map((row) => db.getOrThrow(row.id));
}

async function waitDelegation(
  stack: TestStack,
  predicate: (d: Delegation) => boolean,
  label = 'delegation state',
): Promise<Delegation> {
  return waitFor(() => delegationsOf(stack).find(predicate) ?? null, { label, timeoutMs: 20_000 });
}

function cards(messages: Message[], cardType: string): Message[] {
  return messages.filter(
    (m) => m.kind === 'card' && 'cardType' in m.content && m.content.cardType === cardType,
  );
}

function bConversation(stack: TestStack, b: Bot): string {
  const conv = stack.core.services.domain!.conversations
    .listDirectByBot(b.id)
    .find((c) => !c.readOnly);
  if (!conv) throw new Error('B has no direct conversation');
  return conv.id;
}

describe('cross-bot delegation A→B (D71)', () => {
  it('主路径：B 私聊出现代发消息、A 侧发出卡 + 截断结果卡、A 收到 internal follow-up', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const { a, b, aConv } = await pair(stack);
    const longReply = `调研结论：${'很长的内容。'.repeat(500)}`;
    llm.script('mock-main', [
      step()
        .expect((req) => req.lastUserText().includes('帮我问问小乙'))
        .replyToolCall('delegate_to_bot', { bot_id: b.id, task: '请整理一份发布清单' }),
      step().expect(isAfterDelegateCall).replyText('已经转交给小乙了，结果出来会贴在这里。'),
      step().expect(isDelegatedTrigger).replyText(longReply),
      step().expect(isFollowUp).replyText('小乙已经整理好了，见上面的结果卡。'),
    ]);
    await sendBatch(core, aConv, ['帮我问问小乙']);

    const done = await waitDelegation(stack, (d) => d.status === 'completed');
    expect(done.fromBotId).toBe(a.id);
    expect(done.toBotId).toBe(b.id);
    expect(done.fromConversationId).toBe(aConv);
    expect(done.runId).not.toBeNull();
    expect(done.resultExcerpt!.length).toBeLessThanOrEqual(DELEGATION_RESULT_MAX_CHARS + 1);
    expect(done.resultExcerpt!.endsWith('…')).toBe(true);

    // B 侧：用户代发消息（origin=delegation），B 的终回复就是结果原文。
    const bConv = bConversation(stack, b);
    expect(done.toConversationId).toBe(bConv);
    const bMessages = await listMessages(core, bConv);
    const proxied = bMessages.find((m) => m.id === done.toMessageId)!;
    expect(proxied.senderType).toBe('user');
    expect(proxied.content).toMatchObject({
      text: '请整理一份发布清单',
      origin: 'delegation',
      delegationId: done.id,
      delegatedBy: a.id,
    });
    const reply = bMessages.find((m) => m.id === done.resultMessageId)!;
    expect(reply.senderBotId).toBe(b.id);
    expect((reply.content as { text: string }).text).toBe(longReply);

    // A 侧：发出卡 + 结果卡（用户可见），follow-up 只在内部。
    const aVisible = await listMessages(core, aConv);
    expect(cards(aVisible, 'delegation_sent')).toHaveLength(1);
    expect(cards(aVisible, 'delegation_result')).toHaveLength(1);
    expect(
      aVisible.some((m) => 'event' in m.content && m.content.event === DELEGATION_FOLLOWUP_EVENT),
    ).toBe(false);
    const aAll = await listAllMessages(core, aConv);
    const followUp = aAll.find(
      (m) => 'event' in m.content && m.content.event === DELEGATION_FOLLOWUP_EVENT,
    )!;
    expect(followUp.content).toMatchObject({ internal: true });
    await waitFor(async () =>
      (await listMessages(core, aConv)).find(
        (m) => m.senderBotId === a.id && (m.content as { text?: string }).text?.includes('结果卡'),
      ),
    );

    // 工具面与上下文：A 有 delegate_to_bot / list_bots；B 的被委派 run 没有
    // delegate_to_bot，触发段带来源；A 的 follow-up run 里委派卡被正确渲染。
    const requests = llm.requestsFor('mock-main');
    const toolNames = (req: MockChatRequest) =>
      (req.body.tools as Array<{ function: { name: string } }>).map((t) => t.function.name);
    const aFirst = requests.find((req) => req.lastUserText().includes('帮我问问小乙'))!;
    expect(toolNames(aFirst)).toEqual(expect.arrayContaining(['delegate_to_bot', 'list_bots']));
    const bReq = requests.find(isDelegatedTrigger)!;
    expect(toolNames(bReq)).not.toContain('delegate_to_bot');
    expect(body(bReq)).toContain('由 小甲 代为转交');
    // A 之后的一轮：上下文里两张委派卡按委派状态渲染（不是「审批记录已清理」）。
    llm.script('mock-main', [
      step().expect((req) => req.lastUserText().includes('再总结一下')).replyText('好的。'),
    ]);
    await sendBatch(core, aConv, ['再总结一下']);
    await waitFor(async () =>
      (await listMessages(core, aConv)).find(
        (m) => m.senderBotId === a.id && (m.content as { text?: string }).text === '好的。',
      ),
    );
    const later = llm.requestsFor('mock-main').find((req) => req.lastUserText().includes('再总结一下'))!;
    expect(later.lastUserText()).toContain('已委托给 小乙');
    expect(later.lastUserText()).toContain('小乙 的回复');
    expect(later.lastUserText()).not.toContain('审批记录已清理');
  }, 40_000);

  it('B 正忙：委派排队（submitted、B 私聊没有代发消息），B 空闲后才投递，结果对应委派任务', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const { b, aConv } = await pair(stack);
    const bConv = (await openDirect(core, b.id)).id;
    const bOwn = step()
      .expect((req) => req.lastUserText().includes('乙先忙这个'))
      .hold()
      .replyText('自己的事做完了');
    llm.script('mock-main', [
      bOwn,
      step()
        .expect((req) => req.lastUserText().includes('交给小乙'))
        .replyToolCall('delegate_to_bot', { bot_id: b.id, task: '帮忙核对数字' }),
      step().expect(isAfterDelegateCall).replyText('转交了，小乙忙完就处理。'),
      step().expect(isDelegatedTrigger).replyText('数字核对完毕，没有问题。'),
      step().expect(isFollowUp).replyText('好了。'),
    ]);
    await sendBatch(core, bConv, ['乙先忙这个']);
    const busyRun = await waitForRun(core, bConv, 'running');

    await sendBatch(core, aConv, ['交给小乙']);
    const queued = await waitDelegation(stack, (d) => d.status === 'submitted');
    await waitForRun(core, aConv, 'completed');
    expect(queued.runId).toBeNull();
    expect(queued.toMessageId).toBeNull();
    const bBefore = await listMessages(core, bConv);
    expect(bBefore.some((m) => 'origin' in m.content)).toBe(false);

    bOwn.release();
    const done = await waitDelegation(stack, (d) => d.status === 'completed');
    expect(done.runId).not.toBe(busyRun.id);
    expect(done.resultExcerpt).toBe('数字核对完毕，没有问题。');
    const run = core.services.domain!.runs.get(done.runId!)!;
    expect(run.triggerReason).toBe('delegation');
    expect(run.triggerMessageIds).toEqual([done.toMessageId]);
  }, 40_000);

  it('B 的执行失败 → 委派 failed，A 侧结果卡与 follow-up 说明原因', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const { b, aConv } = await pair(stack);
    llm.script('mock-main', [
      step()
        .expect((req) => req.lastUserText().includes('让小乙做'))
        .replyToolCall('delegate_to_bot', { bot_id: b.id, task: '做一件会失败的事' }),
      step().expect(isAfterDelegateCall).replyText('转交了。'),
      step().expect(isDelegatedTrigger).failWith(401, 'Incorrect API key provided'),
      step().expect(isFollowUp).replyText('小乙没做成。'),
    ]);
    await sendBatch(core, aConv, ['让小乙做']);
    const failed = await waitDelegation(stack, (d) => d.status === 'failed');
    expect(failed.errorText).toContain('小乙');
    expect(failed.resultCardId).not.toBeNull();
    const followUp = await waitFor(async () =>
      (await listAllMessages(core, aConv)).find(
        (m) => 'event' in m.content && m.content.event === DELEGATION_FOLLOWUP_EVENT,
      ),
    );
    expect((followUp.content as { text: string }).text).toContain('没有完成');
  }, 40_000);

  it('取消：处理中的委派被取消会中止 B 的 run，A 侧不贴结果卡、不发 follow-up', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const { b, aConv } = await pair(stack);
    llm.script('mock-main', [
      step()
        .expect((req) => req.lastUserText().includes('交给小乙'))
        .replyToolCall('delegate_to_bot', { bot_id: b.id, task: '慢慢做' }),
      step().expect(isAfterDelegateCall).replyText('转交了。'),
      step().expect(isDelegatedTrigger).hold().replyText('不会到这里'),
    ]);
    await sendBatch(core, aConv, ['交给小乙']);
    const working = await waitDelegation(stack, (d) => d.status === 'working');
    await waitForRun(core, working.toConversationId!, 'running');

    const result = (await core.rpc.call('delegations.cancel', { id: working.id })) as {
      delegation: Delegation;
    };
    expect(result.delegation.status).toBe('cancelled');
    await waitFor(() => {
      const run = core.services.domain!.runs.get(working.runId!);
      return run !== null && run.status === 'cancelled' ? run : null;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const aAll = await listAllMessages(core, aConv);
    expect(cards(aAll, 'delegation_result')).toHaveLength(0);
    expect(
      aAll.some((m) => 'event' in m.content && m.content.event === DELEGATION_FOLLOWUP_EVENT),
    ).toBe(false);
    expect(delegationsOf(stack)[0]!.status).toBe('cancelled');
    // 未知 id 报 NOT_FOUND（不静默返回 null）。
    await expect(core.rpc.call('delegations.cancel', { id: 'dlg_nope' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  }, 40_000);

  it('删除 B / 删除 B 的私聊：活动委派落 cancelled，B 的 run 被中止', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const { b, aConv } = await pair(stack);
    llm.script('mock-main', [
      step()
        .expect((req) => req.lastUserText().includes('交给小乙'))
        .replyToolCall('delegate_to_bot', { bot_id: b.id, task: '长任务' }),
      step().expect(isAfterDelegateCall).replyText('转交了。'),
      step().expect(isDelegatedTrigger).hold().replyText('不会到这里'),
    ]);
    await sendBatch(core, aConv, ['交给小乙']);
    const working = await waitDelegation(stack, (d) => d.status === 'working');
    await core.rpc.call('conversations.delete', { id: working.toConversationId! });
    const cancelled = await waitDelegation(stack, (d) => d.status === 'cancelled');
    expect(cancelled.errorText).toBe('对话已删除');

    // 再来一次，这次删 Bot。
    const c = await makeBot(core, '小丙');
    llm.script('mock-main', [
      step()
        .expect((req) => req.lastUserText().includes('交给小丙'))
        .replyToolCall('delegate_to_bot', { bot_id: c.id, task: '另一个长任务' }),
      step().expect(isAfterDelegateCall).replyText('转交了。'),
      step().expect(isDelegatedTrigger).hold().replyText('不会到这里'),
    ]);
    await sendBatch(core, aConv, ['交给小丙']);
    const second = await waitDelegation(stack, (d) => d.toBotId === c.id && d.status === 'working');
    await core.rpc.call('bots.delete', { id: c.id });
    const gone = await waitDelegation(stack, (d) => d.id === second.id && d.status === 'cancelled');
    expect(gone.errorText).toBe('Bot 已删除');
  }, 40_000);

  it('B 在免打扰时段：委派排队并登记 delegation_delivery 任务，到点后投递', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const { b, aConv } = await pair(stack);
    // 00:00–00:00 = 全天免打扰。
    await core.rpc.call('bots.update', {
      id: b.id,
      profile: { ...b.profile, behavior: { ...b.profile.behavior, quiet_hours: ['00:00', '00:00'] } },
    });
    llm.script('mock-main', [
      step()
        .expect((req) => req.lastUserText().includes('交给小乙'))
        .replyToolCall('delegate_to_bot', { bot_id: b.id, task: '明早处理' }),
      step().expect(isAfterDelegateCall).replyText('等小乙免打扰结束就发。'),
      step().expect(isDelegatedTrigger).replyText('处理好了。'),
      step().expect(isFollowUp).replyText('好。'),
    ]);
    await sendBatch(core, aConv, ['交给小乙']);
    const queued = await waitDelegation(stack, (d) => d.status === 'submitted');
    await waitForRun(core, aConv, 'completed');
    const job = await waitFor(
      () =>
        (stack.core.services.mainDb!
          .prepare("select * from jobs where type = 'delegation_delivery' and status = 'pending'")
          .get() as { id: string; bot_id: string; run_after: number } | undefined) ?? null,
    );
    expect(job.bot_id).toBe(b.id);
    expect(job.run_after).toBeGreaterThan(Date.now());
    expect(queued.toMessageId).toBeNull();

    // 免打扰解除后到点触发：重新过闸门并投递。
    const fresh = core.services.domain!.bots.get(b.id)!;
    await core.rpc.call('bots.update', {
      id: b.id,
      profile: { ...fresh.profile, behavior: { ...fresh.profile.behavior, quiet_hours: null } },
    });
    core.services.orchestrator!.deliverParkedDelegation(job as never);
    const done = await waitDelegation(stack, (d) => d.status === 'completed');
    expect(done.resultExcerpt).toBe('处理好了。');
  }, 40_000);

  it('重启恢复：处理中的委派在重启后落 failed，A 侧贴失败结果卡', async () => {
    const keystore = createMemoryKeystore();
    const home = await mkdtemp(path.join(tmpdir(), 'kepcup-delegation-'));
    homes.push(home);
    const first = await createTestStack({ home, keystore });
    stacks.push(first);
    const { b, aConv } = await pair(first);
    first.llm.script('mock-main', [
      step()
        .expect((req) => req.lastUserText().includes('交给小乙'))
        .replyToolCall('delegate_to_bot', { bot_id: b.id, task: '永远不会完成' }),
      step().expect(isAfterDelegateCall).replyText('转交了。'),
      step().expect(isDelegatedTrigger).hold().replyText('不会到这里'),
    ]);
    await sendBatch(first.core, aConv, ['交给小乙']);
    const working = await waitDelegation(first, (d) => d.status === 'working');
    await waitForRun(first.core, working.toConversationId!, 'running');
    // 模拟崩溃：不 settle 直接关掉。
    await first.core.close();
    await first.llm.stop();
    stacks.pop();

    const second = await start({ home, keystore });
    const after = second.core.services.domain!.delegations.getOrThrow(working.id);
    expect(after.status).toBe('failed');
    expect(after.errorText).toContain('中断');
    const aAll = await listAllMessages(second.core, aConv);
    expect(cards(aAll, 'delegation_result')).toHaveLength(1);
  }, 40_000);

  it('重启恢复：崩溃在「消息已落、run 未起」窗口 → 复用既有代发消息重投，不重发', async () => {
    const keystore = createMemoryKeystore();
    const home = await mkdtemp(path.join(tmpdir(), 'kepcup-delegation-'));
    homes.push(home);
    const first = await createTestStack({ home, keystore });
    stacks.push(first);
    const { a, b } = await pair(first);
    // 直接构造崩溃窗口的中间态（与 #tryDeliver 的事务提交后、投递前一致）：
    // 委派行 working、代发消息已在 B 私聊、run_id 尚未回填。
    const delegations = first.core.services.domain!.delegations;
    const messages = first.core.services.domain!.messages;
    const aConv = (await openDirect(first.core, a.id)).id;
    const created = delegations.create({
      fromBotId: a.id,
      toBotId: b.id,
      fromConversationId: aConv,
      taskText: '窗口里的任务',
      depth: 1,
      fromRunId: null,
    });
    const bConv = (await openDirect(first.core, b.id)).id;
    const message = messages.append({
      conversationId: bConv,
      senderType: 'user',
      kind: 'text',
      text: '窗口里的任务',
      delegation: { delegationId: created.id, delegatedBy: a.id },
    });
    delegations.transition(created.id, ['submitted'], 'working', {
      toConversationId: bConv,
      toMessageId: message.id,
    });
    // 模拟崩溃：不投递直接关掉。
    await first.core.close();
    await first.llm.stop();
    stacks.pop();

    const second = await start({ home, keystore });
    second.llm.script('mock-main', [
      step().expect(isDelegatedTrigger).replyText('处理好了。'),
      step().expect(isFollowUp).replyText('收到，已经告诉用户。'),
    ]);
    const done = await waitDelegation(second, (d) => d.id === created.id && d.status === 'completed');
    expect(done.runId).not.toBeNull();
    expect(done.resultExcerpt).toBe('处理好了。');
    // B 私聊仍只有一条代发消息（复用既有消息，不重发）。
    const bMessages = await listMessages(second.core, bConv);
    const proxied = bMessages.filter((m) => m.senderType === 'user');
    expect(proxied).toHaveLength(1);
    expect(proxied[0]!.id).toBe(message.id);
    const aAll = await listAllMessages(second.core, aConv);
    expect(cards(aAll, 'delegation_result')).toHaveLength(1);
  }, 40_000);
});

describe('W6: delegation intent + 跟随任务（DEV-012 方案二）', () => {
  const isTaskWake = (req: MockChatRequest) => req.lastUserText().includes('<trigger reason="task"');

  it('request：B 的委派轮派任务 → A 的结果卡是任务结果而不是「我去做」，follow-up 要求转述实质', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const { b, aConv } = await pair(stack);
    const taskStep = step().inTask().hold().replyText('TASK-RESULT：X 的三条结论');
    llm.script('mock-main', [
      step()
        .inTurn()
        .expect((req) => req.lastUserText().includes('让小乙查 X'))
        .replyToolCall('delegate_to_bot', { bot_id: b.id, task: '查 X 并整理' }),
      step().inTurn().expect(isAfterDelegateCall).replyText('已经转交给小乙。'),
      step()
        .inTurn()
        .expect(isDelegatedTrigger)
        .replyToolCall('start_task', {
          title: '查 X',
          instruction: '查 X 并整理成三条结论',
          source_message_ids: [],
          writes: false,
        }),
      step().inTurn().expect(isDelegatedTrigger).replyText('好的，我去做'),
      taskStep,
      step().inTurn().expect(isTaskWake).replyText('X 查好了。'),
      step().inTurn().expect(isFollowUp).replyText('小乙查到了 X 的三条结论。'),
    ]);
    await sendBatch(core, aConv, ['让小乙查 X']);

    // 委派轮已回「我去做」，任务还在跑：委派等任务，A 侧还没有结果卡。
    const awaiting = await waitDelegation(stack, (d) => d.status === 'awaiting_tasks');
    expect(awaiting.taskIds).toHaveLength(1);
    await waitFor(() => (taskStep.consumed ? true : null), { label: 'task running' });
    expect(cards(await listAllMessages(core, aConv), 'delegation_result')).toHaveLength(0);
    taskStep.release();
    const done = await waitDelegation(stack, (d) => d.status === 'completed');
    expect(done.intent).toBe('request');
    expect(done.resultExcerpt).toBe('TASK-RESULT：X 的三条结论');
    expect(done.resultMessageId).toBeNull();
    const task = core.services.domain!.runs.get(done.taskIds[0]!)!;
    expect(task).toMatchObject({ loopType: 'task', status: 'completed', originRunId: done.runId });

    const aAll = await listAllMessages(core, aConv);
    expect(cards(aAll, 'delegation_result')).toHaveLength(1);
    const followUp = aAll.find(
      (m) => 'event' in m.content && m.content.event === DELEGATION_FOLLOWUP_EVENT,
    )!;
    const followText = (followUp.content as { text: string }).text;
    expect(followText).toContain('TASK-RESULT');
    expect(followText).not.toContain('我去做');
    expect(followText).toContain('不要只说');
    await waitFor(async () =>
      (await listMessages(core, aConv)).find(
        (m) => (m.content as { text?: string }).text === '小乙查到了 X 的三条结论。',
      ),
    );
    // B 的唤醒提示：intent 属性 + 按 intent 的宿主说明；A 的工具说明含「写在回复里不算发送」。
    const requests = llm.requestsFor('mock-main');
    const bReq = requests.find(isDelegatedTrigger)!;
    expect(bReq.lastUserText()).toContain('intent="request"');
    expect(bReq.lastUserText()).toContain('它们的结果会自动贴回给对方');
    const aFirst = requests.find((req) => req.lastUserText().includes('让小乙查 X'))!;
    expect(JSON.stringify(aFirst.body.tools)).toContain('不会发给 B');
  }, 60_000);

  it('request：B 派出的任务失败 → B 消费失败结果后委派 failed，结果卡标注任务状态', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const { b, aConv } = await pair(stack);
    const wake = step().inTurn().expect(isTaskWake).hold().replyText('任务失败了，我跟用户说一下。');
    llm.script('mock-main', [
      step()
        .inTurn()
        .expect((req) => req.lastUserText().includes('让小乙部署'))
        .replyToolCall('delegate_to_bot', { bot_id: b.id, task: '部署一下' }),
      step().inTurn().expect(isAfterDelegateCall).replyText('转交了。'),
      step()
        .inTurn()
        .expect(isDelegatedTrigger)
        .replyToolCall('start_task', {
          title: '部署',
          instruction: '部署',
          source_message_ids: [],
          writes: false,
        }),
      step().inTurn().expect(isDelegatedTrigger).replyText('我去部署'),
      step().inTask().failWith(401, 'Incorrect API key provided'),
      wake,
      step().inTurn().expect(isFollowUp).replyText('小乙没部署成。'),
    ]);
    await sendBatch(core, aConv, ['让小乙部署']);
    const awaiting = await waitDelegation(stack, (d) => d.status === 'awaiting_tasks');
    // 任务已失败，但 B 还没消费它的失败结果（B 那一轮可能接续）：仍在等。
    await waitFor(() => (wake.consumed ? true : null), { label: 'B woken by the failure' });
    const taskId = awaiting.taskIds[0]!;
    expect(core.services.domain!.runs.get(taskId)!.status).toBe('failed');
    expect(core.services.domain!.delegations.getOrThrow(awaiting.id).status).toBe('awaiting_tasks');
    wake.release();
    const failed = await waitDelegation(stack, (d) => d.status === 'failed');
    expect(failed.errorText).toContain('【部署】（失败）');
    expect(failed.resultCardId).not.toBeNull();
    const followUp = await waitFor(async () =>
      (await listAllMessages(core, aConv)).find(
        (m) => 'event' in m.content && m.content.event === DELEGATION_FOLLOWUP_EVENT,
      ),
    );
    expect((followUp.content as { text: string }).text).toContain('没有完成');
  }, 60_000);

  it('fyi：送达即结算，B 的回复不贴回 A，A 不收结果卡与 follow-up', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const { b, aConv } = await pair(stack);
    llm.script('mock-main', [
      step()
        .inTurn()
        .expect((req) => req.lastUserText().includes('告诉小乙'))
        .replyToolCall('delegate_to_bot', { bot_id: b.id, task: '下周一放假', intent: 'fyi' }),
      step().inTurn().expect(isAfterDelegateCall).replyText('已经告诉小乙了。'),
      step().inTurn().expect(isDelegatedTrigger).replyText('FYI-ACK 知道了'),
    ]);
    await sendBatch(core, aConv, ['告诉小乙下周一放假']);
    const done = await waitDelegation(stack, (d) => d.status === 'completed');
    expect(done).toMatchObject({ intent: 'fyi', resultExcerpt: null, resultCardId: null });
    const bConv = bConversation(stack, b);
    await waitFor(async () =>
      (await listMessages(core, bConv)).find((m) => (m.content as { text?: string }).text === 'FYI-ACK 知道了'),
    );
    await waitForRun(core, aConv, 'completed');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const aAll = await listAllMessages(core, aConv);
    expect(cards(aAll, 'delegation_result')).toHaveLength(0);
    expect(
      aAll.some((m) => 'event' in m.content && m.content.event === DELEGATION_FOLLOWUP_EVENT),
    ).toBe(false);
    expect(aAll.some((m) => (m.content as { text?: string }).text?.includes('FYI-ACK'))).toBe(false);
    const bReq = llm.requestsFor('mock-main').find(isDelegatedTrigger)!;
    expect(bReq.lastUserText()).toContain('intent="fyi"');
    expect(bReq.lastUserText()).toContain('不需要回复对方');
  }, 60_000);

  it('取消等待任务中的委派 → 一并取消 B 派出的任务，A 侧不贴结果卡', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const { b, aConv } = await pair(stack);
    const slowTask = step().inTask().hold().replyText('不会到这里');
    llm.script('mock-main', [
      step()
        .inTurn()
        .expect((req) => req.lastUserText().includes('交给小乙'))
        .replyToolCall('delegate_to_bot', { bot_id: b.id, task: '做个长任务' }),
      step().inTurn().expect(isAfterDelegateCall).replyText('转交了。'),
      step()
        .inTurn()
        .expect(isDelegatedTrigger)
        .replyToolCall('start_task', {
          title: '长任务',
          instruction: '慢慢做',
          source_message_ids: [],
          writes: false,
        }),
      step().inTurn().expect(isDelegatedTrigger).replyText('我去做'),
      slowTask,
    ]);
    await sendBatch(core, aConv, ['交给小乙']);
    const awaiting = await waitDelegation(stack, (d) => d.status === 'awaiting_tasks');
    const taskId = awaiting.taskIds[0]!;
    await waitFor(() => (slowTask.consumed ? true : null), { label: 'task running' });

    const result = (await core.rpc.call('delegations.cancel', { id: awaiting.id })) as {
      delegation: Delegation;
    };
    expect(result.delegation.status).toBe('cancelled');
    const task = await waitFor(() => {
      const run = core.services.domain!.runs.get(taskId);
      return run !== null && run.status === 'cancelled' ? run : null;
    });
    expect(task.error).toContain('用户取消');
    slowTask.release();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const aAll = await listAllMessages(core, aConv);
    expect(cards(aAll, 'delegation_result')).toHaveLength(0);
    expect(
      aAll.some((m) => 'event' in m.content && m.content.event === DELEGATION_FOLLOWUP_EVENT),
    ).toBe(false);
  }, 60_000);
});
