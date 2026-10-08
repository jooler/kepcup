import { afterEach, describe, expect, it } from 'vitest';
import type { Message, Run } from '@kepcup/shared';
import {
  createTestStack,
  listAllMessages,
  listMessages,
  makeBot,
  openDirect,
  step,
  waitFor,
  type MockChatRequest,
  type MockLlmStep,
  type TestStack,
} from '@kepcup/testkit';
import type { RunIdentity } from '../../src/agent/types.js';

/**
 * 宿主 SubAgent（D66）集成，D75 §1.2 降级后的语义：delegate_task 是任务内部
 * 的嵌套子代理——减配子 run + 轻量模型压缩回传；对话流不出现子 run 内容；
 * 子 run 完整落 runs/run_steps 并归属父任务。后台模式是父任务内的并行分支：
 * 结论经 collect_delegate_results 回到父任务，从不投递到对话、不唤醒新一轮；
 * 父任务取消 / 结束 / 对话删除都中止分支。任务经 TaskHost 直接派出（对话轮
 * 工具面由 W2 注册）。
 */

const stacks: TestStack[] = [];

afterEach(async () => {
  for (const stack of stacks.splice(0)) {
    stack.llm.releaseAll();
    await stack.cleanup();
  }
});

const body = (req: MockChatRequest): string => JSON.stringify(req.body);
const isTaskRequest = (marker: string) => (req: MockChatRequest) =>
  req.lastUserText().includes('<task_brief') && req.lastUserText().includes(marker);
const isSubRequest = (marker: string) => (req: MockChatRequest) =>
  !req.lastUserText().includes('<task_brief') && req.lastUserText().includes(marker);
/** A task request that already carries `text` (a tool result) in its transcript. */
const isTaskRequestWith = (marker: string, text: string) => (req: MockChatRequest) =>
  isTaskRequest(marker)(req) && body(req).includes(text);

/** 压缩调用（轻量模型）：请求携带 <process_record>，避开反射 loop 等其他轻量调用。 */
function compressionStep(marker?: string, reply = '压缩后的结论'): MockLlmStep {
  return step()
    .expect(
      (req) =>
        req.lastUserText().includes('<process_record>') &&
        (marker === undefined || req.lastUserText().includes(marker)),
    )
    .replyText(reply);
}

/** The wake turn after the task settles (whatever it says). */
const wakeStep = (): MockLlmStep => step().replyText('任务结果已知悉');

function turnIdentity(botId: string, conversationId: string): RunIdentity {
  return { runId: 'run_turn_d66', botId, conversationId, loopType: 'response' };
}

async function setup(name: string): Promise<{ stack: TestStack; botId: string; convId: string }> {
  const stack = await createTestStack();
  stacks.push(stack);
  const bot = await makeBot(stack.core, name);
  const conv = await openDirect(stack.core, bot.id);
  return { stack, botId: bot.id, convId: conv.id };
}

function startTask(stack: TestStack, botId: string, convId: string, instruction: string): string {
  return stack.core.services.orchestrator!.tasks.start(turnIdentity(botId, convId), {
    title: '调研',
    instruction,
    sourceMessageIds: [],
    writes: false,
  }).taskId;
}

function runOf(stack: TestStack, runId: string): Run | null {
  return stack.core.services.domain!.runs.get(runId);
}

function subRunsOf(stack: TestStack, convId: string, taskId: string): Run[] {
  return stack.core.services
    .domain!.runs.listByConversation(convId, 100)
    .filter((r) => r.loopType === 'subagent' && r.parentRunId === taskId);
}

async function waitSubRuns(
  stack: TestStack,
  convId: string,
  taskId: string,
  count = 1,
): Promise<Run[]> {
  return waitFor(
    () => {
      const subs = subRunsOf(stack, convId, taskId);
      return subs.length >= count && subs.every((s) => s.status === 'running') ? subs : null;
    },
    { label: 'running sub runs of the task', timeoutMs: 20_000 },
  );
}

async function waitStatus(stack: TestStack, runId: string, status: Run['status']): Promise<Run> {
  return waitFor(
    () => {
      const run = runOf(stack, runId);
      return run !== null && run.status === status ? run : null;
    },
    { label: `run ${runId} ${status}`, timeoutMs: 20_000 },
  );
}

function toolResult(stack: TestStack, runId: string, toolName: string): string | null {
  const found = stack.core.services
    .domain!.runs.stepsFor(runId)
    .find((s) => s.type === 'tool_result' && s.payload['toolName'] === toolName);
  return found === undefined ? null : String(found.payload['content']);
}

function textOf(message: Message): string {
  return 'text' in message.content ? message.content.text : '';
}

/** D66's former follow-up injection must never come back (D75 §1.2). */
async function expectNoFollowUpInjection(stack: TestStack, convId: string): Promise<void> {
  const all = await listAllMessages(stack.core, convId);
  expect(
    all.filter(
      (m) =>
        (m.senderType === 'system' && 'event' in m.content && m.content.event === 'delegate_result') ||
        textOf(m).includes('委派任务结束通知'),
    ),
  ).toEqual([]);
  expect(stack.llm.requestBodiesContain('委派任务结束通知')).toBe(false);
}

describe('delegate_task inside a task (D66, D75 §1.2)', () => {
  it('delegates a research task, compresses the result into the task and keeps the conversation clean', async () => {
    const { stack, botId, convId } = await setup('小委');
    const { llm, core } = stack;
    llm.script('mock-main', [
      step()
        .expect(isTaskRequest('TASK-FG'))
        .replyTextAndToolCall('材料太多，我让子代理去读', 'delegate_task', {
          task: 'SUB-FG 通读材料并给出要点结论',
        }),
      step().expect(isSubRequest('SUB-FG')).replyText('子任务自己的最终结论'),
      step().expect(isTaskRequestWith('TASK-FG', '压缩后的结论')).replyText('RESULT-FG'),
      wakeStep(),
    ]);
    llm.script('mock-light', [compressionStep()]);

    const taskId = startTask(stack, botId, convId, 'TASK-FG 帮我读一下材料');
    await waitStatus(stack, taskId, 'completed');

    // 子 run 落库：loopType=subagent、归属父任务、completed、无输出消息。
    const [subRun] = subRunsOf(stack, convId, taskId);
    expect(subRun).toBeDefined();
    expect(subRun!.status).toBe('completed');
    expect(subRun!.outputMessageIds).toHaveLength(0);
    expect(subRun!.botId).toBe(botId);
    expect(subRun!.triggerReason).toBeNull();

    // 子 run transcript 完整落 run_steps；减配工具集：无写 / 对话 / 再委派 / 派任务。
    const subSteps = core.services.domain!.runs.stepsFor(subRun!.id);
    expect(subSteps.map((s) => s.type)).toContain('request');
    expect(subSteps.map((s) => s.type)).toContain('assistant');
    const requestPayload = JSON.stringify(subSteps.find((s) => s.type === 'request')!.payload);
    for (const forbidden of [
      '"write"',
      '"edit"',
      '"send_message"',
      '"delegate_task"',
      '"collect_delegate_results"',
      '"start_task"',
      '"skip_reply"',
    ]) {
      expect(requestPayload).not.toContain(forbidden);
    }
    // 任务收到的工具结果是压缩结论。
    expect(toolResult(stack, taskId, 'delegate_task')).toContain('压缩后的结论');

    // 对话流：无子 run 内容，也无压缩结论原文。
    const visible = (await listMessages(core, convId)).map(textOf).join('\n');
    expect(visible).not.toContain('子任务自己的最终结论');
    expect(visible).not.toContain('压缩后的结论');
  }, 60_000);

  it('cascades task cancellation into a running sub run', async () => {
    const { stack, botId, convId } = await setup('小取');
    const { llm, core } = stack;
    llm.script('mock-main', [
      step()
        .expect(isTaskRequest('TASK-CANCEL'))
        .replyTextAndToolCall('委派给子代理', 'delegate_task', { task: 'SUB-CANCEL 长任务' }),
      step().expect(isSubRequest('SUB-CANCEL')).hold().replyText('子任务（被取消前不会返回）'),
    ]);

    const taskId = startTask(stack, botId, convId, 'TASK-CANCEL 开始长任务');
    const [subRun] = await waitSubRuns(stack, convId, taskId);

    await core.rpc.call('runs.cancel', { runId: taskId });
    await waitStatus(stack, taskId, 'cancelled');
    // 设计契约（D66）：父取消 → 子 run cancelled，无悬挂。
    await waitStatus(stack, subRun!.id, 'cancelled');
  }, 60_000);
});

describe('delegate_task background branches inside the task (D66 mode B, D75 §1.2)', () => {
  it('keeps the task working while the branch runs and returns the conclusion via collect_delegate_results', async () => {
    const { stack, botId, convId } = await setup('小后');
    const { llm, core } = stack;
    const subStep = step().expect(isSubRequest('SUB-BG')).hold().replyText('子任务的最终结论');
    llm.script('mock-main', [
      step()
        .expect(isTaskRequest('TASK-BG'))
        .replyTextAndToolCall('我让子代理在后台查', 'delegate_task', {
          task: 'SUB-BG 调研材料A给出要点',
          mode: 'background',
        }),
      // 父任务不被分支阻塞：拿到 ack 后继续推进，再去取回结论。
      step()
        .expect(isTaskRequestWith('TASK-BG', '后台分支已在本次执行内启动'))
        .replyTextAndToolCall('先做别的，再取回结论', 'collect_delegate_results', {}),
      subStep,
      step().expect(isTaskRequestWith('TASK-BG', '压缩后的结论')).replyText('RESULT-BG'),
      wakeStep(),
    ]);
    llm.script('mock-light', [compressionStep()]);

    const taskId = startTask(stack, botId, convId, 'TASK-BG 帮我盯一下材料A');
    const [subRun] = await waitSubRuns(stack, convId, taskId);
    expect(subRun!.triggerReason).toBe('background');
    // 父任务第二轮（collect）已发出：ack 之后父任务照常推进。
    await waitFor(
      () =>
        llm.requestsFor('mock-main').some(isTaskRequestWith('TASK-BG', '后台分支已在本次执行内启动'))
          ? true
          : null,
      { label: 'task continued after the background ack', timeoutMs: 20_000 },
    );
    // collect 在等分支：任务仍在运行。
    expect(runOf(stack, taskId)?.status).toBe('running');

    subStep.release();
    await waitStatus(stack, taskId, 'completed');
    expect(runOf(stack, subRun!.id)?.status).toBe('completed');

    // 结论回到父任务（collect 的工具结果带 child_run_id 与压缩结论）。
    const collected = toolResult(stack, taskId, 'collect_delegate_results');
    expect(collected).toContain(subRun!.id);
    expect(collected).toContain('压缩后的结论');

    // 从不投递到对话、不唤醒新一轮。
    await expectNoFollowUpInjection(stack, convId);
    const visible = (await listMessages(core, convId)).map(textOf).join('\n');
    expect(visible).not.toContain('压缩后的结论');
    expect(visible).not.toContain('子任务的最终结论');
  }, 60_000);

  it('aborts branches still running when the task ends without collecting them', async () => {
    const { stack, botId, convId } = await setup('小早');
    const { llm } = stack;
    const subStep = step().expect(isSubRequest('SUB-EARLY')).hold().replyText('挂着');
    const compress = compressionStep('SUB-EARLY');
    // The task's final answer is held until the branch is really running
    // (otherwise, under load, the task may end before the branch's request).
    const finalStep = step()
      .expect(isTaskRequestWith('TASK-EARLY', '后台分支已在本次执行内启动'))
      .hold()
      .replyText('RESULT-EARLY');
    llm.script('mock-main', [
      step()
        .expect(isTaskRequest('TASK-EARLY'))
        .replyTextAndToolCall('后台查', 'delegate_task', {
          task: 'SUB-EARLY 长任务',
          mode: 'background',
        }),
      subStep,
      finalStep,
      wakeStep(),
    ]);
    llm.script('mock-light', [compress]);

    const taskId = startTask(stack, botId, convId, 'TASK-EARLY 开始');
    const [subRun] = await waitSubRuns(stack, convId, taskId);
    await waitFor(
      () => (llm.requestsFor('mock-main').some(isSubRequest('SUB-EARLY')) ? true : null),
      { label: 'sub request held' },
    );
    finalStep.release();
    // 父任务结束（未取回）→ 分支被中止，且在任务终态前已 settle。
    const task = await waitStatus(stack, taskId, 'completed');
    const sub = runOf(stack, subRun!.id)!;
    expect(sub.status).toBe('cancelled');
    expect(sub.endedAt).not.toBeNull();
    expect(sub.endedAt! <= task.endedAt!).toBe(true);

    // 放行挂起的请求：分支不再推进、不压缩、不注入。
    const subRequests = () => llm.requestsFor('mock-main').filter(isSubRequest('SUB-EARLY')).length;
    const before = subRequests();
    subStep.release();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(subRequests()).toBe(before);
    expect(compress.consumed).toBe(false);
    await expectNoFollowUpInjection(stack, convId);
  }, 60_000);

  it('runs.cancel on one branch stops only that branch; collect reports it and the task goes on', async () => {
    const { stack, botId, convId } = await setup('小撤');
    const { llm, core } = stack;
    const subStep = step().expect(isSubRequest('SUB-ONE')).hold().replyText('挂着');
    llm.script('mock-main', [
      step()
        .expect(isTaskRequest('TASK-ONE'))
        .replyTextAndToolCall('后台查', 'delegate_task', {
          task: 'SUB-ONE 长任务',
          mode: 'background',
        }),
      subStep,
      step()
        .expect(isTaskRequestWith('TASK-ONE', '后台分支已在本次执行内启动'))
        .replyToolCall('collect_delegate_results', {}),
      step().expect(isTaskRequestWith('TASK-ONE', '执行已取消，子任务中止')).replyText('RESULT-ONE'),
      wakeStep(),
    ]);

    const taskId = startTask(stack, botId, convId, 'TASK-ONE 开始');
    const [subRun] = await waitSubRuns(stack, convId, taskId);
    await core.rpc.call('runs.cancel', { runId: subRun!.id });
    await waitStatus(stack, subRun!.id, 'cancelled');
    await waitStatus(stack, taskId, 'completed');
    expect(toolResult(stack, taskId, 'collect_delegate_results')).toContain('执行已取消，子任务中止');
    await expectNoFollowUpInjection(stack, convId);
  }, 60_000);

  it('aborts the task and its branch when the conversation is deleted', async () => {
    const { stack, botId, convId } = await setup('小关');
    const { llm, core } = stack;
    const subStep = step().expect(isSubRequest('SUB-DEL')).hold().replyText('挂着');
    llm.script('mock-main', [
      step()
        .expect(isTaskRequest('TASK-DEL'))
        .replyTextAndToolCall('后台查', 'delegate_task', {
          task: 'SUB-DEL 长任务',
          mode: 'background',
        }),
      subStep,
      step()
        .expect(isTaskRequestWith('TASK-DEL', '后台分支已在本次执行内启动'))
        .replyToolCall('collect_delegate_results', {}),
    ]);
    llm.script('mock-light', [compressionStep()]);

    const taskId = startTask(stack, botId, convId, 'TASK-DEL 开始');
    await waitSubRuns(stack, convId, taskId);
    await waitFor(
      () => (llm.requestsFor('mock-main').some(isSubRequest('SUB-DEL')) ? true : null),
      { label: 'sub request held' },
    );

    // 关对话：任务与分支一并中止；随后释放挂起的请求，分支不得再推进。
    await core.rpc.call('conversations.delete', { id: convId });
    const requestsBefore = llm.requests().length;
    subStep.release();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(llm.requests().length).toBe(requestsBefore);
    expect(core.services.domain!.runs.listByConversation(convId, 10)).toHaveLength(0); // 行随对话删除
  }, 60_000);

  it('leaves an unfinished branch interrupted after a crash, without any injection', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { createMemoryKeystore } = await import('@kepcup/core');
    const home = await mkdtemp(`${tmpdir()}/kepcup-subagent-recover-`);
    const keystore = createMemoryKeystore();
    const first = await createTestStack({ home, keystore });
    try {
      const subStep = step().expect(isSubRequest('SUB-CRASH')).hold().replyText('挂着');
      first.llm.script('mock-main', [
        step()
          .expect(isTaskRequest('TASK-CRASH'))
          .replyTextAndToolCall('后台查', 'delegate_task', {
            task: 'SUB-CRASH 长任务',
            mode: 'background',
          }),
        subStep,
        step()
          .expect(isTaskRequestWith('TASK-CRASH', '后台分支已在本次执行内启动'))
          .replyToolCall('collect_delegate_results', {}),
      ]);
      const bot = await makeBot(first.core, '小崩');
      const conv = await openDirect(first.core, bot.id);
      const taskId = startTask(first, bot.id, conv.id, 'TASK-CRASH 开始');
      const [subRun] = await waitSubRuns(first, conv.id, taskId);

      // 模拟崩溃：不 settle 直接丢弃 core（D67 未落地：ephemeral 走 D49 标中断）。
      await first.core.close();
      await first.llm.stop();

      const second = await createTestStack({ home, keystore });
      try {
        expect(runOf(second, subRun!.id)?.status).toBe('interrupted');
        await expectNoFollowUpInjection(second, conv.id);
      } finally {
        await second.cleanup();
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('delegate_task fan-out inside the task (D66 mode C)', () => {
  it('runs foreground lanes in parallel and returns the ordered conclusion array', async () => {
    const { stack, botId, convId } = await setup('小并');
    const { llm, core } = stack;
    llm.script('mock-main', [
      step()
        .expect(isTaskRequest('TASK-FAN'))
        .replyTextAndToolCall('多路并查', 'delegate_task', {
          tasks: [{ task: 'SUB-A 调研A' }, { task: 'SUB-B 调研B' }],
        }),
      step().expect(isSubRequest('SUB-A')).replyText('A 的子结论'),
      step().expect(isSubRequest('SUB-B')).replyText('B 的子结论'),
      step().expect(isTaskRequestWith('TASK-FAN', '压缩A')).replyText('RESULT-FAN'),
      wakeStep(),
    ]);
    llm.script('mock-light', [compressionStep('SUB-A', '压缩A'), compressionStep('SUB-B', '压缩B')]);

    const taskId = startTask(stack, botId, convId, 'TASK-FAN 同时查A和B');
    await waitStatus(stack, taskId, 'completed');

    const content = toolResult(stack, taskId, 'delegate_task')!;
    expect(content).toContain('"index": 0');
    expect(content).toContain('"index": 1');
    expect(content.indexOf('压缩A')).toBeLessThan(content.indexOf('压缩B'));

    const subs = subRunsOf(stack, convId, taskId);
    expect(subs).toHaveLength(2);
    for (const sub of subs) {
      expect(sub.status).toBe('completed');
      expect(sub.triggerReason).toBeNull();
    }
    await expectNoFollowUpInjection(stack, convId);
    const visible = (await listMessages(core, convId)).map(textOf).join('\n');
    expect(visible).not.toContain('压缩A');
  }, 60_000);

  it('starts background lanes at once and collects every conclusion in order', async () => {
    const { stack, botId, convId } = await setup('小批');
    const { llm } = stack;
    const weatherStep = step().expect(isSubRequest('SUB-WEATHER')).hold().replyText('天气子结论');
    const trafficStep = step().expect(isSubRequest('SUB-TRAFFIC')).hold().replyText('交通子结论');
    llm.script('mock-main', [
      step()
        .expect(isTaskRequest('TASK-BGFAN'))
        .replyTextAndToolCall('分头去查', 'delegate_task', {
          tasks: [
            { task: 'SUB-WEATHER 查天气三天趋势', mode: 'background' },
            { task: 'SUB-TRAFFIC 查交通管制', mode: 'background' },
          ],
        }),
      weatherStep,
      trafficStep,
      step()
        .expect(isTaskRequestWith('TASK-BGFAN', 'child_run_ids'))
        .replyToolCall('collect_delegate_results', {}),
      step().expect(isTaskRequestWith('TASK-BGFAN', '交通压缩结论')).replyText('RESULT-BGFAN'),
      wakeStep(),
    ]);
    llm.script('mock-light', [
      compressionStep('SUB-WEATHER', '天气压缩结论'),
      compressionStep('SUB-TRAFFIC', '交通压缩结论'),
    ]);

    const taskId = startTask(stack, botId, convId, 'TASK-BGFAN 天气和交通都查一下');
    // 两路立即并行启动。
    const subs = await waitSubRuns(stack, convId, taskId, 2);
    for (const sub of subs) expect(sub.triggerReason).toBe('background');

    trafficStep.release();
    weatherStep.release();
    await waitStatus(stack, taskId, 'completed');

    // collect 按委派顺序返回（与完成先后无关）。
    const collected = toolResult(stack, taskId, 'collect_delegate_results')!;
    expect(collected.indexOf('天气压缩结论')).toBeGreaterThan(-1);
    expect(collected.indexOf('天气压缩结论')).toBeLessThan(collected.indexOf('交通压缩结论'));
    await expectNoFollowUpInjection(stack, convId);
  }, 60_000);
});
