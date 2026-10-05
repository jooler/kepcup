import { afterEach, describe, expect, it } from 'vitest';
import {
  createTestStack,
  listMessages,
  makeBot,
  openDirect,
  sendBatch,
  step,
  waitForRun,
} from '@kepcup/testkit';

/**
 * pi 1.x 升级回归防线（todo/pi-1x-upgrade-mcp-subagent.md Phase A）：pi 的
 * agent_end 语义是「不再有 loop 事件」（`waitForIdle()` 对应 listener settle
 * + `finishRun()`；复核确认 0.87.1 与 1.0.2 一致）。PiEngine.RunHandleImpl 在
 * agent_end listener 里读 `agent.state.messages` 结算 finalText——本测试把该
 * 时序契约固化为测试：多轮（工具 + 最终回复）跑完后，结算看到的是完整转录，
 * 最终消息与步骤序列不缺不重。
 */

const stacks: Array<{ cleanup(): Promise<void> }> = [];

afterEach(async () => {
  for (const stack of stacks.splice(0)) await stack.cleanup();
});

describe('pi 1.x agent_end transcript settle', () => {
  it('multi-turn run settles with the full transcript visible at agent_end', async () => {
    const { core, llm, cleanup } = await createTestStack();
    stacks.push({ cleanup });
    llm.script('mock-main', [
      step().replyTextAndToolCall('我先查一下记录', 'search_messages', { query: '线索' }),
      step().replyText('最终结论：查完了'),
    ]);
    const bot = await makeBot(core, '小研');
    const conv = await openDirect(core, bot.id);

    await sendBatch(core, conv.id, ['帮我查一下']);
    const run = await waitForRun(core, conv.id, 'completed');

    // finalText 是 agent_end 时转录里最后一条 stop 助手消息——空即说明结算
    // 读晚了（finishRun 已清场）或转录不完整。
    const all = await listMessages(core, conv.id);
    const finalMessages = all.filter(
      (m) => m.runId === run.id && m.senderBotId === bot.id && 'text' in m.content,
    );
    expect(finalMessages.at(-1)?.content).toMatchObject({ text: '最终结论：查完了' });

    // 完整转录的间接证据：两次请求（两轮），第二轮请求的转录里带得动第一轮
    // 的工具结果文本（search_messages 无命中时的固定文案）；助手步骤按序
    // 落库，最后一条是 stop。
    const steps = core.services.domain!.runs.stepsFor(run.id);
    const requests = steps.filter((s) => s.type === 'request');
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1]!.payload)).toContain('search_messages');
    expect(JSON.stringify(requests[1]!.payload)).toContain('没有找到匹配的消息');
    const assistants = steps.filter((s) => s.type === 'assistant');
    expect(assistants.length).toBe(2);
    expect(assistants.at(-1)!.payload).toMatchObject({
      stopReason: 'stop',
      text: '最终结论：查完了',
    });
  });
});
