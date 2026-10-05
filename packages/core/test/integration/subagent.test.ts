import { afterEach, describe, expect, it } from 'vitest';
import {
  createTestStack,
  listAllMessages,
  listRuns,
  makeBot,
  openDirect,
  sendBatch,
  step,
  waitFor,
  waitForRun,
} from '@kepcup/testkit';

/**
 * 宿主 SubAgent（D66）集成：delegate_task 委派 → 减配子 run → 轻量模型压缩
 * 回传；对话流不出现子 run 内容；子 run 完整落 runs/run_steps；主 run 取消
 * 级联取消子 run。
 */

const stacks: Array<{ cleanup(): Promise<void> }> = [];

afterEach(async () => {
  for (const stack of stacks.splice(0)) await stack.cleanup();
});

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
