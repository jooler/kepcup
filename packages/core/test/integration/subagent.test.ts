import { afterEach, describe, expect, it } from 'vitest';
import {
  createTestStack,
  listAllMessages,
  listMessages,
  listRuns,
  makeBot,
  openDirect,
  sendBatch,
  step,
  waitFor,
  waitForMessage,
  waitForRun,
  type MockLlmStep,
  type TestStack,
} from '@kepcup/testkit';

/**
 * 宿主 SubAgent（D66）集成：delegate_task 委派 → 减配子 run → 轻量模型压缩
 * 回传；对话流不出现子 run 内容；子 run 完整落 runs/run_steps；主 run 取消
 * 级联取消子 run；后台委派不阻塞主 turn 并在结束后注入压缩结论（follow-up）；
 * fan-out 并行多路；显式取消 / 关对话才中止后台子 run。
 */

const stacks: Array<{ cleanup(): Promise<void> }> = [];

afterEach(async () => {
  for (const stack of stacks.splice(0)) await stack.cleanup();
});

/** 压缩调用（轻量模型）的谓词：请求携带 <process_record>，避开反射 loop 等其他轻量调用。 */
function compressionStep(): MockLlmStep {
  return step()
    .expect((req) => req.lastUserText().includes('<process_record>'))
    .replyText('压缩后的结论');
}

function subRunSteps(core: TestStack['core'], conversationId: string) {
  return waitFor(
    async () => {
      const runs = await listRuns(core, conversationId);
      const subs = runs.filter((r) => r.loopType === 'subagent');
      return subs.length > 0 ? subs : null;
    },
    { label: 'subagent runs' },
  );
}

async function visibleTexts(core: TestStack['core'], conversationId: string): Promise<string> {
  const messages = await listMessages(core, conversationId);
  return messages.map((m) => ('text' in m.content ? m.content.text : '')).join('\n');
}

describe('subagent delegate_task', () => {
  it('delegates a research task, compresses the result and keeps the conversation clean', async () => {
    const { core, llm, cleanup } = await createTestStack();
    stacks.push({ cleanup });
    // mock-main 的步骤按请求顺序消耗：主 run 首轮（委派）→ 子 run（子任务
    // 回复）→ 主 run 次轮（转述最终结论）。
    llm.script('mock-main', [
      step().replyTextAndToolCall('材料太多，我让子代理去读', 'delegate_task', {
        task: '通读材料并给出要点结论',
      }),
      step().replyText('子任务自己的最终结论'),
      step().replyText('主 Bot 转述的最终结论'),
    ]);
    llm.script('mock-light', [step().replyText('压缩后的结论')]);
    const bot = await makeBot(core, '小委');
    const conv = await openDirect(core, bot.id);

    await sendBatch(core, conv.id, ['帮我读一下材料']);
    const run = await waitForRun(core, conv.id, 'completed');

    // 对话流：只有用户消息 + 主 Bot 的中间说明与最终回复，无子 run 内容。
    const all = await listAllMessages(core, conv.id);
    const texts = all.map((m) => ('text' in m.content ? m.content.text : '')).join('\n');
    expect(texts).toContain('主 Bot 转述的最终结论');
    expect(texts).not.toContain('子任务自己的最终结论');
    expect(texts).not.toContain('压缩后的结论');

    // 子 run 落库：loopType=subagent、completed、无输出消息。
    const runs = await listRuns(core, conv.id);
    const subRun = runs.find((r) => r.loopType === 'subagent');
    expect(subRun).toBeDefined();
    expect(subRun!.status).toBe('completed');
    expect(subRun!.outputMessageIds).toHaveLength(0);
    expect(subRun!.botId).toBe(bot.id);

    // 子 run transcript 完整落 run_steps：有请求与助手输出。
    const subSteps = (await core.rpc.call('runs.steps', { runId: subRun!.id })) as {
      steps: Array<{ type: string; payload: Record<string, unknown> }>;
    };
    expect(subSteps.steps.map((s) => s.type)).toContain('request');
    expect(subSteps.steps.map((s) => s.type)).toContain('assistant');

    // 减配工具集：子 run 的请求里没有 write / edit / send_message / delegate_task。
    const requestPayload = JSON.stringify(
      subSteps.steps.find((s) => s.type === 'request')!.payload,
    );
    for (const forbidden of [
      '"write"',
      '"edit"',
      '"send_message"',
      '"delegate_task"',
      '"skip_reply"',
    ]) {
      expect(requestPayload).not.toContain(forbidden);
    }
    // 主 loop 收到的工具结果是压缩结论（≤ 4000 字符 + untrusted 包裹）。
    const mainSteps = (await core.rpc.call('runs.steps', { runId: run.id })) as {
      steps: Array<{ type: string; payload: Record<string, unknown> }>;
    };
    const delegateResult = mainSteps.steps.find(
      (s) => s.type === 'tool_result' && s.payload['toolName'] === 'delegate_task',
    );
    expect(delegateResult).toBeDefined();
    expect(String(delegateResult!.payload['content'])).toContain('压缩后的结论');
    void llm;
  }, 60_000);

  it('cascades main-run cancellation into a running subagent run', async () => {
    const { core, llm, cleanup } = await createTestStack();
    stacks.push({ cleanup });
    // 主 run 首轮委派；子 run 的请求挂起（模拟长时间研究），等它真正开始后
    // 取消主 run。script() 是替换语义：两个步骤一次给全。
    llm.script('mock-main', [
      step().replyTextAndToolCall('委派给子代理', 'delegate_task', { task: '长任务' }),
      step().hold().replyText('子任务（被取消前不会返回）'),
    ]);
    const bot = await makeBot(core, '小取');
    const conv = await openDirect(core, bot.id);

    await sendBatch(core, conv.id, ['开始长任务']);
    const mainRun = await waitForRun(core, conv.id, 'running');
    const subRunId = await waitFor(
      async () => {
        const runs = await listRuns(core, conv.id);
        const sub = runs.find((r) => r.loopType === 'subagent');
        return sub && sub.status === 'running' ? sub.id : null;
      },
      { label: 'subagent run running', timeoutMs: 20_000 },
    );

    await core.rpc.call('runs.cancel', { runId: mainRun.id });
    await waitForRun(core, conv.id, 'cancelled', { timeoutMs: 20_000 });
    // 设计契约（D66）：主 run 取消 → 子 run 同步 cancelled，无悬挂。
    await waitFor(
      async () => {
        const runs = await listRuns(core, conv.id);
        const sub = runs.find((r) => r.id === subRunId);
        return sub?.status === 'cancelled' ? 'cancelled' : null;
      },
      { label: 'subagent run cancelled', timeoutMs: 20_000 },
    );
    llm.releaseAll();
    void llm;
  }, 60_000);
});

describe('subagent background delegation (D66 mode B)', () => {
  it('ends the main turn while the sub run is still running and injects the conclusion afterwards', async () => {
    const { core, llm, cleanup } = await createTestStack();
    stacks.push({ cleanup });
    // 谓词区分并发请求：主 turn 第 2 轮（工具结果）与后台子 run 的请求同时赛跑。
    const subStep = step()
      .expect((req) => req.lastUserText().includes('调研材料A'))
      .hold()
      .replyText('子任务的最终结论');
    llm.script('mock-main', [
      step().replyTextAndToolCall('我让子代理在后台查', 'delegate_task', {
        task: '调研材料A给出要点',
        mode: 'background',
      }),
      step()
        .expect((req) => JSON.stringify(req.body).includes('后台子任务已启动'))
        .replyText('已转后台调研，结果出来我叫你'),
      subStep,
      step()
        .expect((req) => JSON.stringify(req.body).includes('委派任务结束通知'))
        .replyText('后台调研完成了：这是压缩结论的转述'),
    ]);
    llm.script('mock-light', [compressionStep()]);
    const bot = await makeBot(core, '小后');
    const conv = await openDirect(core, bot.id);

    await sendBatch(core, conv.id, ['帮我盯一下材料A']);
    // 主 turn 不被子 run 阻塞：先完成并对用户发言。
    const mainRun = await waitForRun(core, conv.id, 'completed', { timeoutMs: 30_000 });
    expect(await visibleTexts(core, conv.id)).toContain('已转后台调研，结果出来我叫你');

    // 后台子 run 仍在跑：独立于主 turn；落库归属正确。
    const [subRun] = await subRunSteps(core, conv.id);
    expect(subRun!.status).toBe('running');
    expect(subRun!.triggerReason).toBe('background');
    expect(subRun!.parentRunId).toBe(mainRun.id);

    // 子 run 结束 → 压缩 → follow-up 注入 → 新一轮响应 run 转述。
    subStep.release();
    await waitFor(
      async () => {
        const runs = await listRuns(core, conv.id);
        const done = runs.filter((r) => r.loopType === 'response' && r.status === 'completed');
        return done.length >= 2 ? true : null;
      },
      { label: 'follow-up response run', timeoutMs: 30_000 },
    );
    await waitForMessage(
      core,
      conv.id,
      (m) => 'text' in m.content && m.content.text.includes('后台调研完成了'),
      { timeoutMs: 20_000 },
    );

    // 注入本身是内部系统事件：进 Bot 上下文（带 child_run_id 与压缩结论），不进聊天。
    const all = await listAllMessages(core, conv.id);
    const followUp = all.find(
      (m) =>
        m.senderType === 'system' && 'event' in m.content && m.content.event === 'delegate_result',
    );
    expect(followUp).toBeDefined();
    const followUpText = 'text' in followUp!.content ? followUp!.content.text : '';
    expect(followUpText).toContain('委派任务结束通知');
    expect(followUpText).toContain(subRun!.id);
    expect(followUpText).toContain('压缩后的结论');

    // 可见性（D48/D54）：聊天里只有主 Bot 对用户的发言，无注入原文、无子 transcript。
    const visible = await visibleTexts(core, conv.id);
    expect(visible).toContain('后台调研完成了：这是压缩结论的转述');
    expect(visible).not.toContain('压缩后的结论');
    expect(visible).not.toContain('子任务的最终结论');
    expect(visible).not.toContain('委派任务结束通知');

    // 子 run settle：completed、无输出消息、transcript 只落 run_steps。
    const runs = await listRuns(core, conv.id);
    const settled = runs.find((r) => r.id === subRun!.id);
    expect(settled?.status).toBe('completed');
    expect(settled?.outputMessageIds).toHaveLength(0);
    const subSteps = (await core.rpc.call('runs.steps', { runId: subRun!.id })) as {
      steps: Array<{ type: string }>;
    };
    expect(subSteps.steps.map((s) => s.type)).toContain('request');
    expect(subSteps.steps.map((s) => s.type)).toContain('assistant');
  }, 60_000);

  it('drops the follow-up injection when the user explicitly cancels the delegation', async () => {
    const { core, llm, cleanup } = await createTestStack();
    stacks.push({ cleanup });
    const subStep = step()
      .expect((req) => req.lastUserText().includes('长任务B'))
      .hold()
      .replyText('挂着');
    const followUpStep = step()
      .expect((req) => JSON.stringify(req.body).includes('委派任务结束通知'))
      .replyText('取消后不应触发');
    llm.script('mock-main', [
      step().replyTextAndToolCall('后台查', 'delegate_task', {
        task: '长任务B跑一遍',
        mode: 'background',
      }),
      step()
        .expect((req) => JSON.stringify(req.body).includes('后台子任务已启动'))
        .replyText('已开始后台执行'),
      subStep,
      followUpStep,
    ]);
    llm.script('mock-light', [compressionStep()]);
    const bot = await makeBot(core, '小取');
    const conv = await openDirect(core, bot.id);

    await sendBatch(core, conv.id, ['开始长任务B']);
    await waitForRun(core, conv.id, 'completed', { timeoutMs: 30_000 });
    const [subRun] = await subRunSteps(core, conv.id);
    expect(subRun!.status).toBe('running');

    // 显式取消委派（runs.cancel 命中对话级后台锚点）：子 run 中止，且不再注入。
    const before = llm.requests().length;
    await core.rpc.call('runs.cancel', { runId: subRun!.id });
    await waitFor(
      async () => {
        const runs = await listRuns(core, conv.id);
        return runs.find((r) => r.id === subRun!.id)?.status === 'cancelled' ? true : null;
      },
      { label: 'background sub run cancelled', timeoutMs: 20_000 },
    );
    subStep.release();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(followUpStep.consumed).toBe(false);
    // 取消后不允许出现「委派任务结束通知」请求。不能断言请求总数不变：测试
    // 栈里的后台任务（反射 / 摘要）会各自发起 LLM 调用，满载下与取消窗口重叠
    // 即误报；这里只认注入通知本身的请求。
    const followUpRequests = llm
      .requests()
      .slice(before)
      .filter((request) => JSON.stringify(request.body).includes('委派任务结束通知'));
    expect(followUpRequests).toEqual([]);
    const all = await listAllMessages(core, conv.id);
    expect(
      all.filter(
        (m) =>
          m.senderType === 'system' &&
          'event' in m.content &&
          m.content.event === 'delegate_result',
      ),
    ).toHaveLength(0);
    llm.releaseAll();
  }, 60_000);

  it('aborts the background sub run when the conversation is deleted', async () => {
    const { core, llm, cleanup } = await createTestStack();
    stacks.push({ cleanup });
    const subStep = step()
      .expect((req) => req.lastUserText().includes('长任务C'))
      .hold()
      .replyText('挂着');
    llm.script('mock-main', [
      step().replyTextAndToolCall('后台查', 'delegate_task', {
        task: '长任务C跑一遍',
        mode: 'background',
      }),
      step()
        .expect((req) => JSON.stringify(req.body).includes('后台子任务已启动'))
        .replyText('已开始后台执行'),
      subStep,
    ]);
    llm.script('mock-light', [compressionStep()]);
    const bot = await makeBot(core, '小关');
    const conv = await openDirect(core, bot.id);

    await sendBatch(core, conv.id, ['开始长任务C']);
    await waitForRun(core, conv.id, 'completed', { timeoutMs: 30_000 });
    const [subRun] = await subRunSteps(core, conv.id);
    expect(subRun!.status).toBe('running');

    // 关对话：后台子 run 一并 abort（D66 mode B 归属）；随后释放挂起的请求，
    // 子 run 不得再推进（无第二轮请求），也不会有注入。
    const requestsBefore = llm.requests().length;
    await core.rpc.call('conversations.delete', { id: conv.id });
    subStep.release();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(llm.requests().length).toBe(requestsBefore);
    expect(await listRuns(core, conv.id)).toHaveLength(0); // 行随对话删除
  }, 60_000);

  it('keeps an unfinished background sub run interrupted after a crash without injecting', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { createMemoryKeystore } = await import('@kepcup/core');
    const home = await mkdtemp(`${tmpdir()}/kepcup-subagent-recover-`);
    const keystore = createMemoryKeystore();
    const first = await createTestStack({ home, keystore });
    try {
      const subStep = step()
        .expect((req) => req.lastUserText().includes('长任务D'))
        .hold()
        .replyText('挂着');
      first.llm.script('mock-main', [
        step().replyTextAndToolCall('后台查', 'delegate_task', {
          task: '长任务D跑一遍',
          mode: 'background',
        }),
        step()
          .expect((req) => JSON.stringify(req.body).includes('后台子任务已启动'))
          .replyText('已开始后台执行'),
        subStep,
      ]);
      first.llm.script('mock-light', [compressionStep()]);
      const bot = await makeBot(first.core, '小崩');
      const conv = await openDirect(first.core, bot.id);
      await sendBatch(first.core, conv.id, ['开始长任务D']);
      await waitForRun(first.core, conv.id, 'completed', { timeoutMs: 30_000 });
      const [subRun] = await subRunSteps(first.core, conv.id);
      expect(subRun!.status).toBe('running');

      // 模拟崩溃：不 settle 直接丢弃 core（D67 未落地：ephemeral 走 D49 标中断）。
      await first.core.close();
      await first.llm.stop();
      stacks.pop();

      const second = await createTestStack({ home, keystore });
      try {
        const runs = await listRuns(second.core, conv.id);
        expect(runs.find((r) => r.id === subRun!.id)?.status).toBe('interrupted');
        const all = await listAllMessages(second.core, conv.id);
        expect(
          all.filter(
            (m) =>
              m.senderType === 'system' &&
              'event' in m.content &&
              m.content.event === 'delegate_result',
          ),
        ).toHaveLength(0);
      } finally {
        await second.cleanup();
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('subagent fan-out (D66 mode C)', () => {
  it('runs foreground lanes in parallel and returns the ordered conclusion array', async () => {
    const { core, llm, cleanup } = await createTestStack();
    stacks.push({ cleanup });
    llm.script('mock-main', [
      step().replyTextAndToolCall('多路并查', 'delegate_task', {
        tasks: [{ task: '调研A' }, { task: '调研B' }],
      }),
      step()
        .expect((req) => req.lastUserText().includes('调研A'))
        .replyText('A 的子结论'),
      step()
        .expect((req) => req.lastUserText().includes('调研B'))
        .replyText('B 的子结论'),
      step()
        .expect((req) => JSON.stringify(req.body).includes('压缩A'))
        .replyText('两路都完成了，汇总如下'),
    ]);
    llm.script('mock-light', [
      step()
        .expect((req) => req.lastUserText().includes('调研A'))
        .replyText('压缩A'),
      step()
        .expect((req) => req.lastUserText().includes('调研B'))
        .replyText('压缩B'),
    ]);
    const bot = await makeBot(core, '小并');
    const conv = await openDirect(core, bot.id);

    await sendBatch(core, conv.id, ['同时查A和B']);
    const mainRun = await waitForRun(core, conv.id, 'completed', { timeoutMs: 30_000 });

    // 主 loop 拿到按 task 顺序排列的结论数组。
    const mainSteps = (await core.rpc.call('runs.steps', { runId: mainRun.id })) as {
      steps: Array<{ type: string; payload: Record<string, unknown> }>;
    };
    const delegateResult = mainSteps.steps.find(
      (s) => s.type === 'tool_result' && s.payload['toolName'] === 'delegate_task',
    );
    expect(delegateResult).toBeDefined();
    const content = String(delegateResult!.payload['content']);
    expect(content).toContain('"index": 0');
    expect(content).toContain('"index": 1');
    expect(content.indexOf('压缩A')).toBeLessThan(content.indexOf('压缩B'));

    // 两路都是独立子 run：并行启动、归属父 run、互不共享 transcript。
    const runs = await listRuns(core, conv.id);
    const subs = runs.filter((r) => r.loopType === 'subagent');
    expect(subs).toHaveLength(2);
    for (const sub of subs) {
      expect(sub.status).toBe('completed');
      expect(sub.parentRunId).toBe(mainRun.id);
      expect(sub.triggerReason).toBeNull();
    }
    // 前台 fan-out 不注入。
    const all = await listAllMessages(core, conv.id);
    expect(
      all.filter(
        (m) =>
          m.senderType === 'system' &&
          'event' in m.content &&
          m.content.event === 'delegate_result',
      ),
    ).toHaveLength(0);
    const visible = await visibleTexts(core, conv.id);
    expect(visible).not.toContain('压缩A');
  }, 60_000);

  it('starts background lanes at once and injects each conclusion as it lands', async () => {
    const { core, llm, cleanup } = await createTestStack();
    stacks.push({ cleanup });
    const weatherStep = step()
      .expect((req) => req.lastUserText().includes('查天气'))
      .hold()
      .replyText('天气子结论');
    const trafficStep = step()
      .expect((req) => req.lastUserText().includes('查交通'))
      .hold()
      .replyText('交通子结论');
    llm.script('mock-main', [
      step().replyTextAndToolCall('分头去查', 'delegate_task', {
        tasks: [
          { task: '查天气三天趋势', mode: 'background' },
          { task: '查交通管制', mode: 'background' },
        ],
      }),
      step()
        .expect((req) => JSON.stringify(req.body).includes('child_run_ids'))
        .replyText('两路都转后台了，结果分批来'),
      weatherStep,
      trafficStep,
      step()
        .expect((req) => JSON.stringify(req.body).includes('天气压缩结论'))
        .replyText('天气查完了：转述给用户'),
      step()
        .expect((req) => JSON.stringify(req.body).includes('交通压缩结论'))
        .replyText('交通也查完了：一并汇报'),
    ]);
    llm.script('mock-light', [
      step()
        .expect((req) => req.lastUserText().includes('查天气'))
        .replyText('天气压缩结论'),
      step()
        .expect((req) => req.lastUserText().includes('查交通'))
        .replyText('交通压缩结论'),
    ]);
    const bot = await makeBot(core, '小批');
    const conv = await openDirect(core, bot.id);

    await sendBatch(core, conv.id, ['天气和交通都查一下']);
    await waitForRun(core, conv.id, 'completed', { timeoutMs: 30_000 });

    // 立即返回两路 child_run_id，两路并行在跑。
    const subs = await subRunSteps(core, conv.id);
    expect(subs).toHaveLength(2);
    for (const sub of subs) {
      expect(sub.status).toBe('running');
      expect(sub.triggerReason).toBe('background');
    }

    // 逐路完成、逐路注入：先放行天气路。
    weatherStep.release();
    await waitForMessage(
      core,
      conv.id,
      (m) => 'text' in m.content && m.content.text.includes('天气查完了'),
      { timeoutMs: 30_000 },
    );
    const injectionsAfterFirst = (await listAllMessages(core, conv.id)).filter(
      (m) =>
        m.senderType === 'system' && 'event' in m.content && m.content.event === 'delegate_result',
    );
    expect(injectionsAfterFirst).toHaveLength(1);
    expect(
      'text' in injectionsAfterFirst[0]!.content ? injectionsAfterFirst[0]!.content.text : '',
    ).toContain('天气压缩结论');

    // 再放行交通路：第二批注入。
    trafficStep.release();
    await waitForMessage(
      core,
      conv.id,
      (m) => 'text' in m.content && m.content.text.includes('交通也查完了'),
      { timeoutMs: 30_000 },
    );
    const injections = (await listAllMessages(core, conv.id)).filter(
      (m) =>
        m.senderType === 'system' && 'event' in m.content && m.content.event === 'delegate_result',
    );
    expect(injections).toHaveLength(2);

    // 可见性：注入不进聊天；两轮转述都是主 Bot 对用户的发言。
    const visible = await visibleTexts(core, conv.id);
    expect(visible).toContain('天气查完了：转述给用户');
    expect(visible).toContain('交通也查完了：一并汇报');
    expect(visible).not.toContain('天气压缩结论');
    expect(visible).not.toContain('交通压缩结论');
  }, 60_000);
});
