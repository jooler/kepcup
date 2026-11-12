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
 * 跨 Bot 委派 A→B（D71 v2 / D113，docs/design/27 §3）：异步工具、免打扰排队、
 * 交换会话（bot_direct）里 A 的任务消息与 B 的回复、双侧药丸卡（B 私聊没有任何
 * 代发用户消息、A 私聊没有结果卡）、执行归属映射（B 的任务落 B 私聊）、internal
 * follow-up（A 向用户转述）、取消、删除级联、重启恢复。全程 mock LLM。
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

describe('cross-bot delegation A→B (D71 v2)', () => {
  it('主路径：A/B 在交换会话里直接沟通，用户对话各只有一枚药丸，A 收到 follow-up 并向用户转述', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const { a, b, aConv } = await pair(stack);
    const longReply = `调研结论：${'很长的内容。'.repeat(500)}`;
    llm.script('mock-main', [
      step()
        .expect((req) => req.lastUserText().includes('帮我问问小乙'))
        .replyToolCall('delegate_to_bot', { bot_id: b.id, task: '请整理一份发布清单' }),
      step().expect(isAfterDelegateCall).replyText('已经转交给小乙了，结果出来我会告诉你。'),
      step().expect(isDelegatedTrigger).replyText(longReply),
      step().expect(isFollowUp).replyText('小乙已经整理好了：发布清单三条，都在上面。'),
    ]);
    await sendBatch(core, aConv, ['帮我问问小乙']);

    const done = await waitDelegation(stack, (d) => d.status === 'completed');
    expect(done.fromBotId).toBe(a.id);
    expect(done.toBotId).toBe(b.id);
    expect(done.fromConversationId).toBe(aConv);
    expect(done.runId).not.toBeNull();
    expect(done.resultExcerpt!.length).toBeLessThanOrEqual(DELEGATION_RESULT_MAX_CHARS + 1);
    expect(done.resultExcerpt!.endsWith('…')).toBe(true);
    expect(done.resultCardId).toBeNull();

    // 交换会话：bot_direct 类型；A 的任务消息是 bot 消息（origin=delegation），
    // B 的终回复就是结果原文——都只在这里，不在任何用户对话里。
    const exchange = core.services.domain!.conversations.getOrThrow(done.exchangeConversationId!);
    expect(exchange.type).toBe('bot_direct');
    expect(exchange.fromBotId).toBe(a.id);
    expect(exchange.toBotId).toBe(b.id);
    const exchangeMessages = await listMessages(core, exchange.id);
    const taskMessage = exchangeMessages.find((m) => m.id === done.toMessageId)!;
    expect(taskMessage.senderType).toBe('bot');
    expect(taskMessage.senderBotId).toBe(a.id);
    expect(taskMessage.content).toMatchObject({
      text: '请整理一份发布清单',
      origin: 'delegation',
      delegationId: done.id,
      delegatedBy: a.id,
    });
    const reply = exchangeMessages.find((m) => m.id === done.resultMessageId)!;
    expect(reply.senderBotId).toBe(b.id);
    expect((reply.content as { text: string }).text).toBe(longReply);

    // B 的用户私聊：只有接收药丸，没有任何代发用户消息 / 委托文本。
    const bConv = bConversation(stack, b);
    expect(done.toConversationId).toBe(bConv);
    const bMessages = await listMessages(core, bConv);
    expect(cards(bMessages, 'delegation_received')).toHaveLength(1);
    expect(bMessages.some((m) => m.senderType === 'user')).toBe(false);
    expect(bMessages.some((m) => 'origin' in m.content && m.content.origin === 'delegation')).toBe(
      false,
    );

    // A 侧：只有发出药丸（无结果卡），follow-up 只在内部，A 自己的消息向用户转述。
    const aVisible = await listMessages(core, aConv);
    expect(cards(aVisible, 'delegation_sent')).toHaveLength(1);
    expect(cards(aVisible, 'delegation_result')).toHaveLength(0);
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
        (m) => m.senderBotId === a.id && (m.content as { text?: string }).text?.includes('整理好了'),
      ),
    );

    // 工具面与上下文：A 有 delegate_to_bot / list_bots；B 的被委派 run 没有
    // delegate_to_bot；触发段说明「代用户转交」，A 的任务消息按发送者（小甲）渲染。
    const requests = llm.requestsFor('mock-main');
    const toolNames = (req: MockChatRequest) =>
      (req.body.tools as Array<{ function: { name: string } }>).map((t) => t.function.name);
    const aFirst = requests.find((req) => req.lastUserText().includes('帮我问问小乙'))!;
    expect(toolNames(aFirst)).toEqual(expect.arrayContaining(['delegate_to_bot', 'list_bots']));
    const bReq = requests.find(isDelegatedTrigger)!;
    expect(toolNames(bReq)).not.toContain('delegate_to_bot');
    expect(body(bReq)).toContain('代用户转交');
    expect(body(bReq)).not.toContain('由 小甲 代为转交');
    expect(body(bReq)).toContain('| 小甲]');
    // A 之后的一轮：上下文里发出药丸按委派状态渲染；没有结果卡渲染。
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
    expect(later.lastUserText()).not.toContain('小乙 的回复');
    expect(later.lastUserText()).not.toContain('审批记录已清理');
  }, 40_000);

  it('B 正忙：委派不再排队——立刻投进交换会话并行执行，B 的私聊只多一枚药丸', async () => {
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
      step().expect(isAfterDelegateCall).replyText('转交了，小乙正在处理。'),
      step().expect(isDelegatedTrigger).replyText('数字核对完毕，没有问题。'),
      step().expect(isFollowUp).replyText('核对完了，没有问题。'),
    ]);
    await sendBatch(core, bConv, ['乙先忙这个']);
    const busyRun = await waitForRun(core, bConv, 'running');

    await sendBatch(core, aConv, ['交给小乙']);
    // 不排队：直接投进交换会话（B 自己的 run 不受影响，委派在交换会话里并行
    // 起 run）。负载下委派轮可能在首次轮询前就跑完——等 runId 回填即可，
    // 不锚定 working 状态窗口。
    const working = await waitDelegation(stack, (d) => d.runId !== null);
    expect(working.runId).not.toBeNull();
    expect(working.runId).not.toBe(busyRun.id);
    const run = core.services.domain!.runs.get(working.runId!)!;
    expect(run.triggerReason).toBe('delegation');
    expect(run.triggerMessageIds).toEqual([working.toMessageId]);
    expect(run.conversationId).toBe(working.exchangeConversationId);
    bOwn.release();

    const done = await waitDelegation(stack, (d) => d.status === 'completed');
    expect(done.runId).not.toBe(busyRun.id);
    expect(done.resultExcerpt).toBe('数字核对完毕，没有问题。');
    // B 的私聊只多了一枚接收药丸，没有委托文本（B 自己与用户的对话不受影响）。
    const bMessages = await listMessages(core, bConv);
    expect(cards(bMessages, 'delegation_received')).toHaveLength(1);
    expect(bMessages.some((m) => 'origin' in m.content && m.content.origin === 'delegation')).toBe(
      false,
    );
  }, 40_000);

  it('B 的执行失败 → 委派 failed，A 私聊不贴结果卡、follow-up 说明原因', async () => {
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
    expect(failed.resultCardId).toBeNull();
    const followUp = await waitFor(async () =>
      (await listAllMessages(core, aConv)).find(
        (m) => 'event' in m.content && m.content.event === DELEGATION_FOLLOWUP_EVENT,
      ),
    );
    expect((followUp.content as { text: string }).text).toContain('没有完成');
    const aAll = await listAllMessages(core, aConv);
    expect(cards(aAll, 'delegation_result')).toHaveLength(0);
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
    await waitForRun(core, working.exchangeConversationId!, 'running');

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

  it('B 在免打扰时段：委派排队并登记 delegation_delivery 任务，到点后投递（B 私聊落药丸）', async () => {
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
    // 排队中：交换会话还没有消息，B 私聊没有药丸（免打扰 parked 在 openDirect 之前，
    // B 的私聊要显式打开）。
    const bConv = (await openDirect(core, b.id)).id;
    expect(cards(await listMessages(core, bConv), 'delegation_received')).toHaveLength(0);

    // 免打扰解除后到点触发：重新过闸门并投递。
    const fresh = core.services.domain!.bots.get(b.id)!;
    await core.rpc.call('bots.update', {
      id: b.id,
      profile: { ...fresh.profile, behavior: { ...fresh.profile.behavior, quiet_hours: null } },
    });
    core.services.orchestrator!.deliverParkedDelegation(job as never);
    const done = await waitDelegation(stack, (d) => d.status === 'completed');
    expect(done.resultExcerpt).toBe('处理好了。');
    expect(cards(await listMessages(core, bConv), 'delegation_received')).toHaveLength(1);
  }, 40_000);

  it('重启恢复：处理中的委派在重启后落 failed，A 私聊不贴结果卡', async () => {
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
    await waitForRun(first.core, working.exchangeConversationId!, 'running');
    // 模拟崩溃：不 settle 直接关掉。
    await first.core.close();
    await first.llm.stop();
    stacks.pop();

    const second = await start({ home, keystore });
    const after = second.core.services.domain!.delegations.getOrThrow(working.id);
    expect(after.status).toBe('failed');
    expect(after.errorText).toContain('中断');
    expect(after.resultCardId).toBeNull();
    const aAll = await listAllMessages(second.core, aConv);
    expect(cards(aAll, 'delegation_result')).toHaveLength(0);
  }, 40_000);

  it('重启恢复：崩溃在「消息已落、run 未起」窗口 → 复用交换会话里的任务消息重投，不重发', async () => {
    const keystore = createMemoryKeystore();
    const home = await mkdtemp(path.join(tmpdir(), 'kepcup-delegation-'));
    homes.push(home);
    const first = await createTestStack({ home, keystore });
    stacks.push(first);
    const { a, b } = await pair(first);
    // 直接构造崩溃窗口的中间态（与 #tryDeliver 的事务提交后、投递前一致）：
    // 委派行 working、任务消息已在交换会话、run_id 尚未回填。
    const domain = first.core.services.domain!;
    const aConv = (await openDirect(first.core, a.id)).id;
    const created = domain.delegations.create({
      fromBotId: a.id,
      toBotId: b.id,
      fromConversationId: aConv,
      taskText: '窗口里的任务',
      depth: 1,
      fromRunId: null,
    });
    const exchange = domain.conversations.openExchange(a.id, b.id);
    domain.delegations.patch(created.id, { exchangeConversationId: exchange.id });
    const message = domain.messages.append({
      conversationId: exchange.id,
      senderType: 'bot',
      senderBotId: a.id,
      kind: 'text',
      text: '窗口里的任务',
      delegation: { delegationId: created.id, delegatedBy: a.id },
    });
    domain.delegations.transition(created.id, ['submitted'], 'working', {
      toConversationId: (await openDirect(first.core, b.id)).id,
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
    // 交换会话仍只有一条任务消息（复用既有消息，不重发）。
    const exchangeMessages = await listMessages(second.core, exchange.id);
    const tasks = exchangeMessages.filter((m) => m.senderType === 'bot' && m.senderBotId === a.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.id).toBe(message.id);
  }, 40_000);
});

describe('W6: delegation intent + 跟随任务（DEV-012 方案二）', () => {
  const isTaskWake = (req: MockChatRequest) => req.lastUserText().includes('<trigger reason="task"');

  it('request：B 的委派轮派任务 → 任务落交换会话（执行隔离），结果经 follow-up 由 A 转述', async () => {
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

    // 委派轮已回「我去做」，任务还在跑：委派等任务，A 私聊没有结果卡。
    const awaiting = await waitDelegation(stack, (d) => d.status === 'awaiting_tasks');
    expect(awaiting.taskIds).toHaveLength(1);
    await waitFor(() => (taskStep.consumed ? true : null), { label: 'task running' });
    // v2.3 执行隔离：B 派出的任务落在交换会话里，B 的用户私聊不出现执行产物。
    const task = core.services.domain!.runs.get(awaiting.taskIds[0]!)!;
    expect(task.conversationId).toBe(awaiting.exchangeConversationId);
    expect(task.conversationId).not.toBe(awaiting.toConversationId);
    expect(cards(await listAllMessages(core, aConv), 'delegation_result')).toHaveLength(0);
    taskStep.release();
    const done = await waitDelegation(stack, (d) => d.status === 'completed');
    expect(done.intent).toBe('request');
    expect(done.resultExcerpt).toBe('TASK-RESULT：X 的三条结论');
    expect(done.resultMessageId).toBeNull();
    expect(done.resultCardId).toBeNull();
    const settledTask = await waitFor(() => {
      const settled = core.services.domain!.runs.get(awaiting.taskIds[0]!)!;
      return settled.status === 'completed' ? settled : null;
    }, { label: 'task completed' });
    expect(settledTask).toMatchObject({ loopType: 'task', status: 'completed', originRunId: done.runId });

    const aAll = await listAllMessages(core, aConv);
    expect(cards(aAll, 'delegation_result')).toHaveLength(0);
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
    // B 的唤醒提示：intent 属性 + 按 intent 的宿主说明（结果交给对方转述给用户）；
    // A 的工具说明含「写在回复里不算发送」。
    const requests = llm.requestsFor('mock-main');
    const bReq = requests.find(isDelegatedTrigger)!;
    expect(bReq.lastUserText()).toContain('intent="request"');
    expect(bReq.lastUserText()).toContain('它们的结果会自动交给对方、由它转述给用户');
    const aFirst = requests.find((req) => req.lastUserText().includes('让小乙查 X'))!;
    expect(JSON.stringify(aFirst.body.tools)).toContain('不会发给 B');
  }, 60_000);

  it('审批归属映射（真实接线）：working 委派轮身份插入的审批行与卡片落发起方 A 的私聊', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const { b, aConv } = await pair(stack);
    // B 的委派轮 hold 在 LLM 边界（start_task 已执行、轮还没回复）：行仍是 working。
    const turnHold = step().inTurn().hold().replyText('好的，我去做');
    const taskStep = step().inTask().hold().replyText('TASK-RESULT：X 的结论');
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
          instruction: '查 X 并整理',
          source_message_ids: [],
          writes: false,
        }),
      turnHold,
      taskStep,
      step().inTurn().expect(isTaskWake).replyText('X 查好了。'),
      step().inTurn().expect(isFollowUp).replyText('小乙查到了。'),
    ]);
    await sendBatch(core, aConv, ['让小乙查 X']);
    const row = await waitDelegation(stack, (d) => d.status === 'working' && d.runId !== null);
    await waitFor(() => (turnHold.consumed ? true : null), { label: 'turn held mid-flight' });
    // 委派轮跑在交换会话里——若 orchestrator 没把 resolver 注册进 approvals，
    // 审批行会落交换会话；真实接线下必须落到发起方 A 的用户私聊（v2.3 §3.7：
    // 谁发出委派，用户就在谁的对话里操作）。
    const exchange = row.exchangeConversationId!;
    const approval = core.services.domain!.approvals.submitNonBlocking(
      { runId: row.runId!, botId: b.id, conversationId: exchange, loopType: 'turn' },
      'access',
      { path: '/tmp/demo', access: 'read' },
      () => {},
    );
    expect(approval.conversationId).toBe(aConv);
    expect(approval.conversationId).not.toBe(exchange);
    // approvals.list（界面同一条 RPC）按会话取卡：A 私聊有、交换会话没有。
    // （测试环境 unattended 自动裁决时卡是 ephemeral 不落消息表，行归属是判别点。）
    const inA = (await core.rpc.call('approvals.list', { conversationId: aConv })) as {
      approvals: Array<{ id: string }>;
    };
    expect(inA.approvals.some((a) => a.id === approval.id)).toBe(true);
    const inExchange = (await core.rpc.call('approvals.list', { conversationId: exchange })) as {
      approvals: Array<{ id: string }>;
    };
    expect(inExchange.approvals.some((a) => a.id === approval.id)).toBe(false);
    // 任务详情页同源：TaskView.userConversationId 与卡片落点同一 resolver——
    // 委派任务给出发起方 A 的私聊（详情页审批条 / 提问条据它取数），任务行
    // 仍住交换会话。
    const delegatedTask = core.services.domain!.runs.listTasks({ conversationId: exchange })[0]!;
    const view = core.services.orchestrator!.tasks.view(delegatedTask.id)!;
    expect(view.conversationId).toBe(exchange);
    expect(view.userConversationId).toBe(aConv);
    turnHold.release();
    taskStep.release();
    await waitDelegation(stack, (d) => d.id === row.id && d.status === 'completed');
  }, 60_000);

  it('v2.3：委派任务的 ask_user 提问卡落发起方 A 的私聊，用户在 A 的对话里作答', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const { b, aConv } = await pair(stack);
    const resumed = step()
      .inTask()
      .expect((req) => body(req).includes('用户的回答：A 方案'))
      .replyText('RESULT 按 A 方案完成');
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
          instruction: '查 X 并整理',
          source_message_ids: [],
          writes: false,
        }),
      step().inTurn().expect(isDelegatedTrigger).replyText('好的，我去做'),
      step()
        .inTask()
        .replyToolCall('ask_user', { question: '用哪个方案？', options: ['A 方案', 'B 方案'] }),
      resumed,
      step().inTurn().expect(isTaskWake).replyText('X 查好了。'),
      step().inTurn().expect(isFollowUp).replyText('小乙查好了。'),
    ]);
    await sendBatch(core, aConv, ['让小乙查 X']);
    const awaiting = await waitDelegation(stack, (d) => d.status === 'awaiting_tasks');
    // 提问卡出现在发起方 A 的私聊（谁发出委派，用户就在谁的对话里操作）。
    const question = await waitFor(
      async () =>
        (await listMessages(core, aConv)).find(
          (m) =>
            m.kind === 'system_event' &&
            'event' in m.content &&
            m.content.event === 'task_question',
        ) ?? null,
      { label: 'question card in A chat' },
    );
    expect(question!.content).toMatchObject({ text: '用哪个方案？', options: ['A 方案', 'B 方案'] });
    // 交换会话与执行方 B 的私聊都没有提问卡。
    const exchangeMessages = await listMessages(core, awaiting.exchangeConversationId!);
    expect(
      exchangeMessages.some(
        (m) => m.kind === 'system_event' && 'event' in m.content && m.content.event === 'task_question',
      ),
    ).toBe(false);
    const bConv = bConversation(stack, b);
    expect(
      (await listMessages(core, bConv)).some(
        (m) => m.kind === 'system_event' && 'event' in m.content && m.content.event === 'task_question',
      ),
    ).toBe(false);
    // 用户在 A 的对话里作答 → 任务继续，委派以任务结果结算。
    await core.rpc.call('tasks.answer', { messageId: question!.id, answer: 'A 方案' });
    await waitFor(() => (resumed.consumed ? true : null), { label: 'task resumed by the answer' });
    await waitDelegation(stack, (d) => d.id === awaiting.id && d.status === 'completed');
  }, 60_000);

  it('request：B 派出的任务失败 → B 消费失败结果后委派 failed，follow-up 标注任务状态', async () => {    const stack = await start();
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
    expect(failed.resultCardId).toBeNull();
    const followUp = await waitFor(async () =>
      (await listAllMessages(core, aConv)).find(
        (m) => 'event' in m.content && m.content.event === DELEGATION_FOLLOWUP_EVENT,
      ),
    );
    expect((followUp.content as { text: string }).text).toContain('没有完成');
    expect(cards(await listAllMessages(core, aConv), 'delegation_result')).toHaveLength(0);
  }, 60_000);

  it('fyi：送达即结算，B 的回复留在交换会话，A 不收结果卡与 follow-up', async () => {
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
    await waitFor(async () =>
      (await listMessages(core, done.exchangeConversationId!)).find(
        (m) => (m.content as { text?: string }).text === 'FYI-ACK 知道了',
      ),
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

describe('委派的追加与检索（D114）', () => {
  const isTaskWake = (req: MockChatRequest) => req.lastUserText().includes('<trigger reason="task"');

  it('在跑任务的委派收到补充 → 直接注入任务 loop；list_delegations 能检索历史', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const { a, b, aConv } = await pair(stack);
    const taskStep = step().inTask().hold().replyText('TASK-RESULT：X 的三条结论（含 Y 对比）');
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
    ]);
    await sendBatch(core, aConv, ['让小乙查 X']);

    // 委派轮已回「我去做」、任务在跑：委派 awaiting，脚本队列清空——
    // 此时拿到 delegation_id 再注册第二段脚本（替换脚本不影响已匹配的 held 步骤）。
    const awaiting = await waitDelegation(stack, (d) => d.status === 'awaiting_tasks');
    await waitFor(() => (taskStep.consumed ? true : null), { label: 'task running' });
    const task = core.services.domain!.runs.get(awaiting.taskIds[0]!)!;
    expect(task.conversationId).toBe(awaiting.exchangeConversationId);
    llm.script('mock-main', [
      step()
        .inTurn()
        .expect((req) => req.lastUserText().includes('补充上 Y 的对比'))
        .replyToolCall('update_delegation', {
          delegation_id: awaiting.id,
          message: '补充：加上 Y 的对比',
        }),
      step()
        .inTurn()
        .expect((req) => body(req).includes('已把补充直接注入'))
        .replyText('已经把补充告诉小乙了。'),
      // 注入被 steer 进在跑任务：引擎在当前请求结束后发起续跑请求——它的
      // 最终回复就是任务的终态结果（吸收了补充）。
      step().inTask().replyText('TASK-RESULT：X 的三条结论（含 Y 对比）'),
      step().inTurn().expect(isTaskWake).replyText('X 查好了。'),
      step().inTurn().expect(isFollowUp).replyText('小乙查好了，含 Y 对比。'),
      step()
        .inTurn()
        .expect((req) => req.lastUserText().includes('委托过小乙'))
        .replyToolCall('list_delegations', {}),
      step()
        .inTurn()
        .expect((req) => body(req).includes('共 1 条委派'))
        .replyText('你之前让小乙整理过 X，已经完成。'),
    ]);

    // 用户让 A 补充 → update_delegation → 注入在跑任务的 loop。
    await sendBatch(core, aConv, ['让小乙补充上 Y 的对比']);
    await waitFor(async () =>
      (await listMessages(core, aConv)).find(
        (m) => m.senderBotId === a.id && (m.content as { text?: string }).text === '已经把补充告诉小乙了。',
      ),
    );
    // 注入条目落在交换会话的任务往返里（发起方标注 + untrusted 包裹的补充原文），
    // 不进执行方 B 的用户私聊（v2.3 执行隔离）。
    const injectEntry = await waitFor(async () => {
      const entries = await listAllMessages(core, awaiting.exchangeConversationId!);
      return (
        entries.find(
          (m) =>
            m.kind === 'task_event' &&
            'phase' in m.content &&
            m.content.phase === 'inject' &&
            (m.content as { text?: string }).text?.includes('Y 的对比'),
        ) ?? null
      );
    });
    const injectText = (injectEntry.content as { text: string }).text;
    expect(injectText).toContain('发起方');
    expect(injectText).toContain('<untrusted>');
    expect(
      (await listAllMessages(core, awaiting.toConversationId!)).some(
        (m) => m.kind === 'task_event' && 'phase' in m.content && m.content.phase === 'inject',
      ),
    ).toBe(false);
    // 补充原文也存档在交换会话里（delegationUpdate 标记）。
    const exchangeMessages = await listMessages(core, awaiting.exchangeConversationId!);
    expect(
      exchangeMessages.some(
        (m) =>
          (m.content as { delegationUpdate?: boolean }).delegationUpdate === true &&
          (m.content as { text?: string }).text === '补充：加上 Y 的对比',
      ),
    ).toBe(true);

    // 任务完成 → 委派结算（结果 = 任务结果）→ A 收到 follow-up。
    taskStep.release();
    const done = await waitDelegation(stack, (d) => d.id === awaiting.id && d.status === 'completed');
    expect(done.resultExcerpt).toContain('TASK-RESULT');
    await waitFor(async () =>
      (await listMessages(core, aConv)).find(
        (m) => m.senderBotId === a.id && (m.content as { text?: string }).text === '小乙查好了，含 Y 对比。',
      ),
    );

    // 检索：A 调 list_delegations，工具结果带委派行与结果摘要，A 向用户转述。
    await sendBatch(core, aConv, ['我委托过小乙什么？转述一下']);
    await waitFor(async () =>
      (await listMessages(core, aConv)).find(
        (m) =>
          m.senderBotId === a.id &&
          (m.content as { text?: string }).text === '你之前让小乙整理过 X，已经完成。',
      ),
    );
    const listed = llm
      .requestsFor('mock-main')
      .find((req) => JSON.stringify(req.body).includes('共 1 条委派'));
    expect(listed).toBeDefined();
    expect(JSON.stringify(listed!.body)).toContain(`发给 小乙`);
    expect(JSON.stringify(listed!.body)).toContain('TASK-RESULT');
  }, 90_000);
});
