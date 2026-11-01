import { afterEach, describe, expect, it } from 'vitest';
import {
  createTestStack,
  listMessages,
  listRuns,
  makeBot,
  openDirect,
  sendBatch,
  waitFor,
  waitForEvent,
  waitForMessage,
  waitForRun,
  type TestStack,
} from '@kepcup/testkit';
import { step } from '@kepcup/testkit';
import type { Message } from '@kepcup/shared';

const stacks: TestStack[] = [];

afterEach(async () => {
  for (const stack of stacks.splice(0)) await stack.cleanup();
});

async function start(): Promise<TestStack> {
  const stack = await createTestStack();
  stacks.push(stack);
  return stack;
}

describe('messages.recall', () => {
  it('marks the message recalled and publishes message.updated', async () => {
    const { core, llm } = await start();
    llm.script('mock-main', [step().replyText('收到')]);
    const bot = await makeBot(core, '小艾');
    const conv = await openDirect(core, bot.id);

    const [message] = await sendBatch(core, conv.id, ['要撤回的内容']);
    await waitForRun(core, conv.id, 'completed');

    // 先订阅再撤回：message.updated 在 recall RPC 内同步发布
    const updated = waitForEvent<{ message: Message }>(
      core,
      'message.updated',
      (payload) => payload.message.id === message!.id && payload.message.status === 'recalled',
    );
    await core.rpc.call('messages.recall', { id: message!.id });
    expect((await updated).message.conversationId).toBe(conv.id);

    // 行保留（渲染层显示「已撤回」占位），状态翻转
    const all = await listMessages(core, conv.id);
    expect(all.find((m) => m.id === message!.id)?.status).toBe('recalled');
  });

  it('only user messages can be recalled, and only once', async () => {
    const { core, llm } = await start();
    llm.script('mock-main', [step().replyText('好的')]);
    const bot = await makeBot(core, '小艾');
    const conv = await openDirect(core, bot.id);

    const [message] = await sendBatch(core, conv.id, ['第一条']);
    await waitForRun(core, conv.id, 'completed');
    const reply = await waitForMessage(
      core,
      conv.id,
      (m) => m.senderType === 'bot' && m.kind === 'text' && m.status !== 'recalled',
    );

    await expect(core.rpc.call('messages.recall', { id: reply.id })).rejects.toMatchObject({
      code: 'MESSAGE_NOT_RECALLABLE',
    });

    await core.rpc.call('messages.recall', { id: message!.id });
    await expect(core.rpc.call('messages.recall', { id: message!.id })).rejects.toMatchObject({
      code: 'MESSAGE_NOT_RECALLABLE',
    });
  });

  it('drops a buffered trigger recalled before the running turn releases the mailbox', async () => {
    const { core, llm } = await start();
    llm.script('mock-main', [step().hold().replyText('第一轮完成')]);
    const bot = await makeBot(core, '小艾');
    const conv = await openDirect(core, bot.id);

    await sendBatch(core, conv.id, ['第一条']);
    await waitForRun(core, conv.id, 'running');
    // 第一条请求已落到 mock（对话轮过了吸收缓冲的窗口），此时发送必进 mailbox 缓冲
    await waitFor(() => (llm.requests().length >= 1 ? true : null), { label: 'first request' });
    const [buffered] = await sendBatch(core, conv.id, ['撤回这条缓冲消息']);
    await core.rpc.call('messages.recall', { id: buffered!.id });

    llm.releaseAll();
    await waitForRun(core, conv.id, 'completed');
    // 留出缓冲批补跑的窗口：触发批重读时丢弃已撤回消息。被清空的批仍会留
    // 下一行 cancelled 占位（#executeRun 先建行、吸收后发现无触发可执行），
    // 真正执行过的 turn 只有第一轮。
    await new Promise((r) => setTimeout(r, 800));
    const turns = (await listRuns(core, conv.id)).filter((r) => r.loopType === 'turn');
    expect(turns.filter((r) => r.status !== 'cancelled')).toHaveLength(1);
    // 撤回的消息从未进入任何模型上下文
    expect(llm.requestBodiesContain('撤回这条缓冲消息')).toBe(false);
  });
});
