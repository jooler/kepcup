import { afterEach, describe, expect, it } from 'vitest';
import {
  createTestStack,
  listMessages,
  makeBot,
  openDirect,
  step,
  waitFor,
  waitForRun,
  type TestStack,
} from '@kepcup/testkit';

/**
 * 语音对话模式（docs/design/53-voice-conversation.md 修订 v3）的 core 侧闭环：
 * `conversations.setVoiceMode` 的即时态 → 对话轮系统提示词注入
 * `<voice_conversation>` → 语音轮的 Bot 回复记 origin:'voice'（UI 据此渲染
 * 语音气泡并自动播报）；退出后下一轮恢复普通文本提示词与普通回复。
 */

const stacks: TestStack[] = [];

afterEach(async () => {
  for (const stack of stacks.splice(0)) await stack.cleanup();
});

async function start(): Promise<TestStack> {
  const stack = await createTestStack();
  stacks.push(stack);
  return stack;
}

/** 系统提示词（mock 请求的第一条 system 消息）。 */
function systemText(request: {
  body: { messages?: Array<{ role: string; content?: unknown }> };
}): string {
  const system = request.body.messages?.find((message) => message.role === 'system');
  return typeof system?.content === 'string' ? system.content : '';
}

describe('语音对话模式（core）', () => {
  it('开启后：对话轮系统提示词带 voice_conversation，Bot 回复记 origin=voice', async () => {
    const { core, llm } = await start();
    const bot = await makeBot(core, '小艾');
    const conv = await openDirect(core, bot.id);
    llm.script('mock-main', [step().inTurn().replyText('收到，马上处理')]);

    await core.rpc.call('conversations.setVoiceMode', {
      conversationId: conv.id,
      active: true,
    });
    await core.rpc.call('messages.send', {
      conversationId: conv.id,
      text: '帮我看看仓库状态',
      voiceMode: true,
    });
    await waitForRun(core, conv.id, 'completed');

    const request = llm.requestsFor('mock-main')[0];
    expect(request).toBeDefined();
    expect(systemText(request!)).toContain('<voice_conversation>');
    expect(systemText(request!)).toContain('立刻给反馈');

    const messages = await listMessages(core, conv.id);
    const reply = messages.find((message) => message.senderBotId === bot.id);
    expect(reply?.content).toMatchObject({ text: '收到，马上处理', origin: 'voice' });
  });

  it('仅凭 messages.send(voiceMode) 也注入语音提示词（RPC 丢失兜底，且不写成会话态）', async () => {
    const { core, llm } = await start();
    const bot = await makeBot(core, '小艾');
    const conv = await openDirect(core, bot.id);
    llm.script('mock-main', [
      step().inTurn().replyText('语音轮'),
      step().inTurn().replyText('文字轮'),
    ]);

    // 不调用 conversations.setVoiceMode：本轮靠触发批里的语音消息识别。
    await core.rpc.call('messages.send', {
      conversationId: conv.id,
      text: '语音说的话',
      voiceMode: true,
    });
    await waitForRun(core, conv.id, 'completed');

    // 下一条文字消息必须回到普通提示词（语音发送不得把会话状态永久置真——
    // 否则退出后任何在途语音发送都会让后续文字轮继续按语音模式回复）。
    await core.rpc.call('messages.send', { conversationId: conv.id, text: '改成打字' });
    const replies = await waitFor(
      async () => {
        const all = await listMessages(core, conv.id);
        const bots = all.filter((message) => message.senderBotId === bot.id);
        return bots.length >= 2 ? bots : null;
      },
      { label: 'two bot replies' },
    );

    expect(systemText(llm.requestsFor('mock-main')[0]!)).toContain('<voice_conversation>');
    expect(systemText(llm.requestsFor('mock-main')[1]!)).not.toContain('<voice_conversation>');
    expect(replies[0]?.content).toMatchObject({ origin: 'voice' });
    expect(replies[1]?.content).not.toMatchObject({ origin: 'voice' });
  });

  it('退出后：下一轮恢复普通提示词，Bot 回复不再带 origin=voice', async () => {
    const { core, llm } = await start();
    const bot = await makeBot(core, '小艾');
    const conv = await openDirect(core, bot.id);
    llm.script('mock-main', [
      step().inTurn().replyText('第一轮'),
      step().inTurn().replyText('第二轮'),
    ]);

    await core.rpc.call('conversations.setVoiceMode', {
      conversationId: conv.id,
      active: true,
    });
    await core.rpc.call('messages.send', {
      conversationId: conv.id,
      text: '语音说的话',
      voiceMode: true,
    });
    await waitForRun(core, conv.id, 'completed');

    await core.rpc.call('conversations.setVoiceMode', {
      conversationId: conv.id,
      active: false,
    });
    await core.rpc.call('messages.send', { conversationId: conv.id, text: '改成打字' });
    // 第二轮 run：等两条 Bot 回复都落库（waitForRun 对已完成的第一轮会立刻返回）。
    const replies = await waitFor(
      async () => {
        const all = await listMessages(core, conv.id);
        const bots = all.filter((message) => message.senderBotId === bot.id);
        return bots.length >= 2 ? bots : null;
      },
      { label: 'two bot replies' },
    );
    const requests = llm.requestsFor('mock-main');
    const second = requests[1];
    expect(second).toBeDefined();
    expect(systemText(second!)).not.toContain('<voice_conversation>');

    expect(replies[0]?.content).toMatchObject({ origin: 'voice' });
    expect(replies[1]?.content).not.toMatchObject({ origin: 'voice' });
  });
});
