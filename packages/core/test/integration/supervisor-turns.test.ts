import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Bot, Message, Run, RunStep, TaskEventContent } from '@kepcup/shared';
import {
  agentTurn,
  createTestStack,
  fakeAgentSpawner,
  isTaskRequest,
  listMessages,
  makeBot,
  makeGroup,
  openDirect,
  sendBatch,
  sendDrafts,
  step,
  waitFor,
  type CoreHarness,
  type FakeAcpAgentHandle,
  type MockChatRequest,
  type TestStack,
} from '@kepcup/testkit';
import { resolvePaths, workspacePathFor } from '../../src/infra/paths.js';

/**
 * D75 W2 对话轮（docs/design/30-supervisor-and-tasks.md §2.1、§3.2–§3.3、§4、
 * §6.2、§7.1）端到端：对话轮派任务并立即回复、结算后马上能处理新消息、任务
 * 结果唤醒新一轮并 forward_task_result、同时结算的任务合并为一轮、对话轮内写
 * 工具被拒、对话轮运行中到达的消息进下一轮、inject_task / cancel_task、群聊
 * 顺序响应不等任务。脚本用模拟模型服务的 turn / task 两条泳道（inTurn / inTask）。
 */

const stacks: TestStack[] = [];

afterEach(async () => {
  for (const stack of stacks.splice(0)) {
    stack.llm.releaseAll();
    await stack.cleanup();
  }
});

async function start(): Promise<TestStack> {
  const stack = await createTestStack();
  stacks.push(stack);
  return stack;
}

function domain(stack: { core: CoreHarness }) {
  return stack.core.services.domain!;
}

function runsOf(stack: TestStack, conversationId: string, loopType: Run['loopType']): Run[] {
  return domain(stack)
    .runs.listByConversation(conversationId, 100)
    .filter((run) => run.loopType === loopType)
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
}

const isTerminal = (run: Run): boolean =>
  run.status === 'completed' ||
  run.status === 'failed' ||
  run.status === 'cancelled' ||
  run.status === 'interrupted';

function waitRun(stack: TestStack, id: string, statuses: Run['status'][], label: string) {
  return waitFor(
    () => {
      const run = domain(stack).runs.get(id);
      return run !== null && statuses.includes(run.status) ? run : null;
    },
    { label, timeoutMs: 20_000 },
  );
}

function waitTurns(
  stack: TestStack,
  conversationId: string,
  count: number,
  label: string,
): Promise<Run[]> {
  return waitFor(
    () => {
      const turns = runsOf(stack, conversationId, 'turn');
      return turns.length >= count && turns.slice(0, count).every(isTerminal) ? turns : null;
    },
    { label, timeoutMs: 20_000 },
  );
}

function textOf(message: Message): string {
  return 'text' in message.content ? message.content.text : '';
}

function waitVisible(stack: TestStack, conversationId: string, fragment: string): Promise<Message> {
  return waitFor(
    async () =>
      (await listMessages(stack.core, conversationId)).find((m) => textOf(m).includes(fragment)) ??
      null,
    { label: `visible message containing ${fragment}`, timeoutMs: 20_000 },
  );
}

function waitRequest(
  stack: TestStack,
  predicate: (req: MockChatRequest) => boolean,
  label: string,
): Promise<MockChatRequest> {
  return waitFor(() => stack.llm.requestsFor('mock-main').find(predicate) ?? null, {
    label,
    timeoutMs: 20_000,
  });
}

function toolNames(req: MockChatRequest): string[] {
  return ((req.body.tools ?? []) as Array<{ function?: { name?: string } }>).map(
    (tool) => tool.function?.name ?? '',
  );
}

/** The first user message of a request: context + <tasks> + trigger. */
function firstUserText(req: MockChatRequest): string {
  const first = (req.body.messages ?? []).find((m) => m.role === 'user');
  return typeof first?.content === 'string' ? first.content : JSON.stringify(first?.content ?? '');
}

function entries(stack: TestStack, taskId: string): TaskEventContent[] {
  return domain(stack)
    .messages.taskEvents(taskId)
    .map((m) => m.content as TaskEventContent);
}

function stepsOf(stack: TestStack, runId: string): RunStep[] {
  return domain(stack).runs.stepsFor(runId);
}

const turnWith = (fragment: string) => (req: MockChatRequest) =>
  !isTaskRequest(req) && req.lastUserText().includes(fragment);
const isWake = (req: MockChatRequest) =>
  !isTaskRequest(req) && req.lastUserText().includes('<trigger reason="task"');

/** The bot's only task in the conversation (start_task args are scripted). */
function onlyTaskId(stack: TestStack, conversationId: string): string {
  const tasks = runsOf(stack, conversationId, 'task');
  if (tasks.length !== 1) throw new Error(`expected one task, got ${tasks.length}`);
  return tasks[0]!.id;
}

describe('D75 supervisor turns (W2)', () => {
  it('turn starts a task and replies, settles at once, takes the next message, then relays the result via forward_task_result', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const bot = await makeBot(core, '小艾');
    const conv = await openDirect(core, bot.id);

    const taskWrite = step()
      .inTask()
      .replyTextAndToolCall('TASK-PROGRESS 先写报告文件', 'write', {
        path: 'report.md',
        content: 'REPORT-BODY',
      });
    const taskFinal = step().inTask().hold().replyText('RESULT-FULL 报告已写入 report.md，共三节');
    llm.script('mock-main', [
      step()
        .inTurn()
        .expect(turnWith('写一份报告'))
        .replyToolCall('start_task', {
          title: '写报告',
          instruction: 'TASK-REPORT 写一份报告到 report.md',
          source_message_ids: [],
          writes: true,
        }),
      step().inTurn().replyText('ACK-1 好的，我开始写报告了'),
      taskWrite,
      taskFinal,
      step().inTurn().expect(turnWith('今天星期几')).replyText('REPLY-2 今天星期四；报告还在写'),
      step()
        .inTurn()
        .expect(isWake)
        .replyToolCall('forward_task_result', () => ({ task_id: onlyTaskId(stack, conv.id) })),
      step().inTurn().replyText('BRIDGE 详情如上，要我再改吗？'),
    ]);

    await sendBatch(core, conv.id, ['帮我写一份报告']);
    await waitVisible(stack, conv.id, 'ACK-1');
    const [turn1] = await waitTurns(stack, conv.id, 1, 'turn 1 settled');
    expect(turn1!.status).toBe('completed');
    const taskId = onlyTaskId(stack, conv.id);
    expect(domain(stack).runs.getOrThrow(taskId)).toMatchObject({
      taskTitle: '写报告',
      taskWrites: true,
      originRunId: turn1!.id,
    });
    // The turn's toolset: read-only queries + task management, no writes.
    const turn1Request = llm.requestsFor('mock-main').find(turnWith('写一份报告'))!;
    const turnTools = toolNames(turn1Request);
    expect(turnTools).toEqual(
      expect.arrayContaining([
        'send_message',
        'skip_reply',
        'read',
        'grep',
        'start_task',
        'inject_task',
        'cancel_task',
        'list_tasks',
        'forward_task_result',
      ]),
    );
    for (const name of ['write', 'edit', 'bash', 'request_access', 'acquire_project_write']) {
      expect(turnTools).not.toContain(name);
    }
    expect(firstUserText(turn1Request)).not.toContain('<tasks>');
    // The task got the working toolset, not the task tools (depth 1).
    const taskRequest = await waitRequest(stack, isTaskRequest, 'task request');
    expect(toolNames(taskRequest)).toEqual(expect.arrayContaining(['write', 'bash']));
    expect(toolNames(taskRequest)).not.toContain('start_task');

    // The turn settled right away: a new message gets its own turn while the
    // task is still held mid-run.
    await waitFor(() => (taskWrite.consumed ? true : null), { label: 'task wrote' });
    await sendBatch(core, conv.id, ['今天星期几？']);
    await waitVisible(stack, conv.id, 'REPLY-2');
    expect(domain(stack).runs.getOrThrow(taskId).status).toBe('running');
    const turn2Request = llm.requestsFor('mock-main').find(turnWith('今天星期几'))!;
    // <tasks> lists the in-flight task; no D56 auto continuation for turns.
    expect(firstUserText(turn2Request)).toContain('<tasks>');
    expect(firstUserText(turn2Request)).toContain(`[${taskId}] <untrusted>写报告</untrusted>  running`);
    expect(firstUserText(turn2Request)).not.toContain('<continuation>');
    // The task's interim narration reached the user directly.
    const progress = await waitVisible(stack, conv.id, 'TASK-PROGRESS');
    expect(progress.content).toMatchObject({ origin: 'task', taskId });

    taskFinal.release();
    await waitRun(stack, taskId, ['completed'], 'task completed');
    const file = path.join(
      workspacePathFor(resolvePaths(core.services.paths.home), bot.id, conv.id),
      'report.md',
    );
    expect(existsSync(file) ? readFileSync(file, 'utf8') : null).toBe('REPORT-BODY');
    // The result is private (no visible final message of the task) …
    expect(entries(stack, taskId).map((e) => e.phase)).toEqual(['brief', 'result']);
    // … it woke a turn that forwarded the original and bridged.
    const forwarded = await waitVisible(stack, conv.id, 'RESULT-FULL');
    expect(forwarded.content).toMatchObject({ origin: 'task', taskId });
    await waitVisible(stack, conv.id, 'BRIDGE');
    const turns = await waitTurns(stack, conv.id, 3, 'wake turn settled');
    expect(turns[2]).toMatchObject({ triggerReason: 'task', status: 'completed' });
    const wakeRequest = llm.requestsFor('mock-main').find(isWake)!;
    // The triggering result is in full in the trigger segment.
    expect(wakeRequest.lastUserText()).toContain('RESULT-FULL 报告已写入 report.md，共三节');
    // Consumed at the waking turn's terminal state (§3.2).
    await waitFor(
      () => (domain(stack).runs.getOrThrow(taskId).resultConsumedAt !== null ? true : null),
      { label: 'result consumed' },
    );
    const visible = (await listMessages(core, conv.id)).map(textOf);
    expect(visible.filter((t) => t.includes('RESULT-FULL'))).toHaveLength(1);
  }, 60_000);

  it('two tasks settling while a turn runs merge into one waking turn', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const bot = await makeBot(core, '小艾');
    const conv = await openDirect(core, bot.id);

    const finalReply = step().inTurn().hold().replyText('ACK 两件事都派出去了');
    llm.script('mock-main', [
      step()
        .inTurn()
        .replyToolCall('start_task', {
          title: '查 A',
          instruction: 'TASK-A 查 A',
          source_message_ids: [],
          writes: false,
        }),
      step()
        .inTurn()
        .replyToolCall('start_task', {
          title: '查 B',
          instruction: 'TASK-B 查 B',
          source_message_ids: [],
          writes: false,
        }),
      finalReply,
      step()
        .inTask()
        .expect((req) => req.lastUserText().includes('TASK-A'))
        .replyText('RESULT-A 结论甲'),
      step()
        .inTask()
        .expect((req) => req.lastUserText().includes('TASK-B'))
        .replyText('RESULT-B 结论乙'),
      step().inTurn().expect(isWake).replyText('MERGED 两个结论：甲、乙'),
    ]);

    await sendBatch(core, conv.id, ['帮我查一下 A 和 B']);
    await waitFor(() => (runsOf(stack, conv.id, 'task').length === 2 ? true : null), {
      label: 'two tasks started',
    });
    const [taskA, taskB] = runsOf(stack, conv.id, 'task');
    await waitRun(stack, taskA!.id, ['completed'], 'task A completed');
    await waitRun(stack, taskB!.id, ['completed'], 'task B completed');
    // Both results were delivered while turn 1 still ran: buffered, not steered.
    expect(runsOf(stack, conv.id, 'turn')).toHaveLength(1);
    finalReply.release();
    await waitVisible(stack, conv.id, 'MERGED');
    const turns = await waitTurns(stack, conv.id, 2, 'merged wake turn settled');
    expect(turns).toHaveLength(2);
    expect(turns[1]!.triggerReason).toBe('task');
    const resultIds = [taskA!.id, taskB!.id].map(
      (id) => domain(stack).messages.terminalTaskEvent(id)!.id,
    );
    expect([...turns[1]!.triggerMessageIds].sort()).toEqual([...resultIds].sort());
    const wakeRequests = llm.requestsFor('mock-main').filter(isWake);
    expect(wakeRequests).toHaveLength(1);
    expect(wakeRequests[0]!.lastUserText()).toContain('RESULT-A 结论甲');
    expect(wakeRequests[0]!.lastUserText()).toContain('RESULT-B 结论乙');
    expect(stepsOf(stack, turns[0]!.id).some((s) => s.type === 'steer')).toBe(false);
    await waitFor(
      () =>
        [taskA!, taskB!].every((t) => domain(stack).runs.getOrThrow(t.id).resultConsumedAt !== null)
          ? true
          : null,
      { label: 'both results consumed' },
    );
  }, 60_000);

  it('a write tool in a turn is refused (not in the turn toolset; nothing written)', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const bot = await makeBot(core, '小艾');
    const conv = await openDirect(core, bot.id);
    llm.script('mock-main', [
      step().inTurn().replyToolCall('write', { path: 'sneaky.txt', content: 'x' }),
      step().inTurn().replyToolCall('bash', { command: 'touch sneaky2.txt' }),
      step().inTurn().replyText('DONE 我得派个任务来做'),
    ]);
    await sendBatch(core, conv.id, ['写个文件']);
    await waitVisible(stack, conv.id, 'DONE');
    const [turn] = await waitTurns(stack, conv.id, 1, 'turn settled');
    expect(turn!.status).toBe('completed');
    // Neither tool is offered to a turn: the engine answers both calls with a
    // tool error instead of running anything.
    const [first, second, third] = llm.requestsFor('mock-main');
    expect(toolNames(first!)).not.toContain('write');
    expect(toolNames(first!)).not.toContain('bash');
    for (const req of [second!, third!]) {
      const toolMessages = (req.body.messages ?? []).filter((m) => m.role === 'tool');
      expect(toolMessages.length).toBeGreaterThan(0);
    }
    expect(stepsOf(stack, turn!.id).filter((s) => s.type === 'tool_result')).toHaveLength(0);
    const ws = workspacePathFor(resolvePaths(core.services.paths.home), bot.id, conv.id);
    expect(existsSync(path.join(ws, 'sneaky.txt'))).toBe(false);
    expect(existsSync(path.join(ws, 'sneaky2.txt'))).toBe(false);
  }, 30_000);

  it('a message arriving while a turn runs is handled by the next turn (no steer)', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const bot = await makeBot(core, '小艾');
    const conv = await openDirect(core, bot.id);
    const held = step().inTurn().expect(turnWith('第一条')).hold().replyText('REPLY-FIRST');
    llm.script('mock-main', [
      held,
      step().inTurn().expect(turnWith('第二条')).replyText('REPLY-SECOND'),
    ]);
    await sendBatch(core, conv.id, ['第一条']);
    await waitRequest(stack, turnWith('第一条'), 'turn 1 request');
    const [second] = await sendBatch(core, conv.id, ['第二条']);
    // Still one turn: the batch waits in the mailbox.
    expect(runsOf(stack, conv.id, 'turn')).toHaveLength(1);
    held.release();
    await waitVisible(stack, conv.id, 'REPLY-SECOND');
    const turns = await waitTurns(stack, conv.id, 2, 'two turns settled');
    expect(turns[1]!.triggerMessageIds).toEqual([second!.id]);
    expect(stepsOf(stack, turns[0]!.id).some((s) => s.type === 'steer')).toBe(false);
    const secondRequest = llm.requestsFor('mock-main').find(turnWith('第二条'))!;
    expect(secondRequest.lastUserText()).toMatch(/<trigger reason="direct">[\s\S]*第二条/);
  }, 30_000);

  it('inject_task steers a running task; cancel_task cancels one without waking a turn', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const bot = await makeBot(core, '小艾');
    const conv = await openDirect(core, bot.id);

    const taskFirst = step().inTask().hold().replyText('TASK-DRAFT 初稿');
    llm.script('mock-main', [
      step()
        .inTurn()
        .expect(turnWith('翻译这段'))
        .replyToolCall('start_task', {
          title: '翻译',
          instruction: 'TASK-TRANSLATE 翻译这段',
          source_message_ids: [],
          writes: false,
        }),
      step().inTurn().replyText('ACK 开始翻译'),
      taskFirst,
      // The steered instruction reaches the task as a follow-up request.
      step()
        .inTask()
        .expect((req) => req.lastUserText().includes('<task_inject>'))
        .replyText('RESULT-FORMAL 正式语气的译文'),
      step()
        .inTurn()
        .expect(turnWith('正式一点'))
        .replyToolCall('inject_task', () => ({
          task_id: onlyTaskId(stack, conv.id),
          text: 'INJECT-FORMAL 用正式语气',
        })),
      step().inTurn().replyText('ROUTED 已把「正式一点」转给翻译任务'),
      step().inTurn().expect(isWake).replyText('RELAY 译好了'),
      // Second task: cancelled by the next turn.
      step()
        .inTurn()
        .expect(turnWith('再查个资料'))
        .replyToolCall('start_task', {
          title: '查资料',
          instruction: 'TASK-RESEARCH 查资料',
          source_message_ids: [],
          writes: false,
        }),
      step().inTurn().replyText('ACK 去查了'),
      step().inTask().expect((req) => req.lastUserText().includes('TASK-RESEARCH')).hold().replyText('never'),
      step()
        .inTurn()
        .expect(turnWith('不用查了'))
        .replyToolCall('cancel_task', () => ({
          task_id: runsOf(stack, conv.id, 'task').find((t) => t.taskTitle === '查资料')!.id,
          reason: '用户不需要了',
        })),
      step().inTurn().replyText('CANCELLED 好，查资料那条停了'),
    ]);

    await sendBatch(core, conv.id, ['翻译这段']);
    await waitVisible(stack, conv.id, 'ACK 开始翻译');
    await waitRequest(stack, isTaskRequest, 'task request held');
    await sendBatch(core, conv.id, ['正式一点']);
    await waitVisible(stack, conv.id, 'ROUTED');
    const translateId = onlyTaskId(stack, conv.id);
    expect(entries(stack, translateId).find((e) => e.phase === 'inject')).toMatchObject({
      text: 'INJECT-FORMAL 用正式语气',
      delivery: 'delivered',
    });
    taskFirst.release();
    await waitRun(stack, translateId, ['completed'], 'translation completed');
    expect(entries(stack, translateId).at(-1)).toMatchObject({
      phase: 'result',
      text: 'RESULT-FORMAL 正式语气的译文',
    });
    await waitVisible(stack, conv.id, 'RELAY');

    await sendBatch(core, conv.id, ['再查个资料']);
    await waitVisible(stack, conv.id, 'ACK 去查了');
    await waitRequest(stack, (req) => isTaskRequest(req) && req.lastUserText().includes('TASK-RESEARCH'), 'research task request');
    await sendBatch(core, conv.id, ['不用查了']);
    await waitVisible(stack, conv.id, 'CANCELLED');
    const research = runsOf(stack, conv.id, 'task').find((t) => t.taskTitle === '查资料')!;
    const cancelled = await waitRun(stack, research.id, ['cancelled'], 'research cancelled');
    expect(cancelled.resultConsumedAt).not.toBeNull();
    expect(entries(stack, research.id).map((e) => e.phase)).toEqual(['brief', 'cancel', 'failure']);
    // No turn was woken for the cancellation (§3.3).
    const turnsAfter = await waitTurns(stack, conv.id, 5, 'all turns settled');
    expect(turnsAfter).toHaveLength(5);
    expect(turnsAfter.filter((t) => t.triggerReason === 'task')).toHaveLength(1);
  }, 60_000);

  it('group chat: ordered responses advance at turn terminal without waiting for tasks', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const x = await makeBot(core, '阿甲');
    const y = await makeBot(core, '阿乙');
    const conv = await makeGroup(core, '测试群', [x.id, y.id]);
    const xTask = step().inTask().hold().replyText('RESULT-X 查好了');
    llm.script('mock-main', [
      // X's turn (first target) starts a task and replies at once.
      step()
        .inTurn()
        .expect((req) => req.lastUserText().includes('你们俩看看'))
        .replyToolCall('start_task', {
          title: '查一下',
          instruction: 'TASK-X 查一下',
          source_message_ids: [],
          writes: false,
        }),
      step().inTurn().replyText('X-ACK 我去查一下'),
      xTask,
      // Y's turn runs while X's task still works.
      step()
        .inTurn()
        .expect((req) => req.lastUserText().includes('在你之前'))
        .replyText('Y-REPLY 我补充一句'),
      step().inTurn().expect(isWake).replyText('X-RELAY 查到了'),
    ]);

    await sendDrafts(core, conv.id, [{ text: '你们俩看看', mentions: [x.id, y.id] }]);
    await waitVisible(stack, conv.id, 'X-ACK');
    const yReply = await waitVisible(stack, conv.id, 'Y-REPLY');
    expect(yReply.senderBotId).toBe(y.id);
    const xTaskRun = runsOf(stack, conv.id, 'task')[0]!;
    expect(xTaskRun.botId).toBe(x.id);
    // The round finished while the task is still running.
    expect(domain(stack).runs.getOrThrow(xTaskRun.id).status).toBe('running');
    await waitFor(
      () => (core.services.orchestrator!.groupTurnState(conv.id).phase === 'idle' ? true : null),
      { label: 'round over' },
    );
    xTask.release();
    const relay = await waitVisible(stack, conv.id, 'X-RELAY');
    expect(relay.senderBotId).toBe(x.id);
    // Only the task's owner was woken.
    const wakeTurns = runsOf(stack, conv.id, 'turn').filter((t) => t.triggerReason === 'task');
    expect(wakeTurns.map((t) => t.botId)).toEqual([x.id]);
  }, 60_000);

  it('a turn that runs out of steps (TURN_MAX_TURNS) settles failed with a hint', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const bot = await makeBot(core, '小艾');
    const conv = await openDirect(core, bot.id);
    llm.script(
      'mock-main',
      Array.from({ length: 8 }, () => step().inTurn().replyToolCall('list_tasks', {})),
    );
    await sendBatch(core, conv.id, ['一直查']);
    const [turn] = await waitTurns(stack, conv.id, 1, 'turn settled');
    expect(turn).toMatchObject({ status: 'failed' });
    expect(turn!.error).toContain('步上限');
    expect(llm.requestsFor('mock-main')).toHaveLength(8);
  }, 30_000);

  it('§8.4 downgrade: an agent-only bot without a built-in model routes messages to a task and forwards its result', async () => {
    const started: FakeAcpAgentHandle[] = [];
    const stack = await createTestStack({
      env: { KEPCUP_MOCK_LLM_URL: '' },
      agentLaunch: () => ({ command: 'in-process', args: [], env: {} }),
      agentSpawn: fakeAgentSpawner(
        { fake: { turns: [agentTurn().text('RESULT-AGENT 已经整理好了')] } },
        started,
      ) as never,
    });
    stacks.push(stack);
    const { core } = stack;
    await core.rpc.call('settings.update', {
      experimental: { externalAgents: true },
      agents: { fake: { enabled: true } },
      backgroundTasks: { agentEnabled: false },
    });
    const created = await makeBot(core, '外援');
    const bot = (
      (await core.rpc.call('bots.update', {
        id: created.id,
        profile: {
          ...created.profile,
          runtime: {
            ...created.profile.runtime,
            agent: { ...created.profile.runtime.agent, id: 'fake' },
          },
        },
      })) as { bot: Bot }
    ).bot;
    const conv = await openDirect(core, bot.id);

    const [source] = await sendBatch(core, conv.id, ['帮我整理一下资料']);
    const task = await waitFor(() => runsOf(stack, conv.id, 'task')[0] ?? null, {
      label: 'task started by the downgraded turn',
    });
    expect(task.triggerMessageIds).toEqual([source!.id]);
    const [turn1] = await waitTurns(stack, conv.id, 1, 'downgraded turn settled');
    expect(turn1).toMatchObject({ status: 'completed', engine: 'builtin' });
    expect(task.originRunId).toBe(turn1!.id);

    const done = await waitRun(stack, task.id, ['completed'], 'agent task completed');
    expect(done.engine).toBe('agent:fake');
    const forwarded = await waitVisible(stack, conv.id, 'RESULT-AGENT');
    expect(forwarded.content).toMatchObject({ origin: 'task', taskId: task.id });
    expect(forwarded.senderBotId).toBe(bot.id);
    await waitFor(
      () => (domain(stack).runs.getOrThrow(task.id).resultConsumedAt !== null ? true : null),
      { label: 'result consumed' },
    );
    expect(started[0]!.observed.prompts[0]!.text).toContain('帮我整理一下资料');
  }, 60_000);

  it('an external-agent bot with a built-in model: its turns run on the built-in engine, never on an agent:* provider slot', async () => {
    const started: FakeAcpAgentHandle[] = [];
    const stack = await createTestStack({
      agentLaunch: () => ({ command: 'in-process', args: [], env: {} }),
      agentSpawn: fakeAgentSpawner({ fake: { turns: [] } }, started) as never,
    });
    stacks.push(stack);
    const { core, llm } = stack;
    await core.rpc.call('settings.update', {
      experimental: { externalAgents: true },
      agents: { fake: { enabled: true } },
      backgroundTasks: { agentEnabled: false },
    });
    const created = await makeBot(core, '外援');
    const bot = (
      (await core.rpc.call('bots.update', {
        id: created.id,
        profile: {
          ...created.profile,
          runtime: {
            ...created.profile.runtime,
            agent: { ...created.profile.runtime.agent, id: 'fake' },
          },
        },
      })) as { bot: Bot }
    ).bot;
    const conv = await openDirect(core, bot.id);
    const scheduler = core.services.scheduler!;
    const submitted: Array<{ provider: string; key: string }> = [];
    const submit = scheduler.submit.bind(scheduler);
    scheduler.submit = ((job: Parameters<typeof submit>[0]) => {
      submitted.push({ provider: job.provider, key: job.key });
      return submit(job);
    }) as typeof scheduler.submit;

    llm.script('mock-main', [step().inTurn().replyText('BUILTIN-TURN 我在')]);
    await sendBatch(core, conv.id, ['在吗']);
    await waitVisible(stack, conv.id, 'BUILTIN-TURN');
    const [turn] = await waitTurns(stack, conv.id, 1, 'turn settled');
    expect(turn).toMatchObject({ status: 'completed', engine: 'builtin' });
    expect(turn!.provider?.startsWith('agent:')).toBe(false);
    const turnJobs = submitted.filter((job) => job.key === `${bot.id}:${conv.id}`);
    expect(turnJobs).toHaveLength(1);
    expect(turnJobs.every((job) => !job.provider.startsWith('agent:'))).toBe(true);
    // The agent process was never started for the turn.
    expect(started).toHaveLength(0);
  }, 30_000);
});

