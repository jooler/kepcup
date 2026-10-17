import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Bot, Conversation, Message } from '@kepcup/shared';
import {
  createTestStack,
  listRuns,
  step,
  waitForMessage,
  waitForRun,
  type TestStack,
} from '@kepcup/testkit';
import { SETUP_PATH_QUESTION } from '../../src/tools/setup-tools.js';

/**
 * 对话工作路径（docs/design/19，D59）：目录闸门——访谈首问作答后不触发
 * LLM，插入确定性的工作目录卡、扣下投递；作答（选择/跳过）后缓冲消息
 * 一次性进入首个响应 run。（D60 对话内群创建已在 D92 T1a 删除。）
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

function tmpDir(): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), 'kepcup-p16-')));
}

async function createInterviewConversation(core: TestStack['core']): Promise<string> {
  const created = (await core.rpc.call('bots.create', { profile: {}, interview: true })) as {
    bot: Bot;
  };
  const started = (await core.rpc.call('bots.interview.start', { id: created.bot.id })) as {
    conversationId: string;
  };
  return started.conversationId;
}

async function answerInterview(
  core: TestStack['core'],
  conversationId: string,
  text: string,
): Promise<void> {
  await core.rpc.call('bots.interview.answer', { conversationId, text });
}

function messagesOf(core: TestStack['core'], conversationId: string): Message[] {
  return core.services.domain!.messages.list(conversationId, { limit: 200 }) as Message[];
}

describe('setup path gate (D59)', () => {
  it('holds the first answer behind a deterministic directory card and starts no run', async () => {
    const { core, llm } = await start();
    const conversationId = await createInterviewConversation(core);

    await answerInterview(core, conversationId, '做我的营销参谋');

    // 目录卡紧随首答落库，确定性文案、无候选。
    const card = await waitForMessage(
      core,
      conversationId,
      (m) =>
        m.kind === 'system_event' &&
        'event' in m.content &&
        m.content.event === 'bot_setup_path_question',
    );
    expect(card.content).toMatchObject({ text: SETUP_PATH_QUESTION });
    expect(card.seq).toBeGreaterThan(0);

    // 闸门扣下投递：没有响应 run，也没有任何模型请求。
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await listRuns(core, conversationId)).toHaveLength(0);
    expect(llm.requestsFor('mock-main')).toHaveLength(0);
  }, 20_000);

  it('skip answer releases the buffered messages into the first run', async () => {
    const { core, llm } = await start();
    const conversationId = await createInterviewConversation(core);

    llm.script('mock-main', [step().replyText('收到，我们开始吧。')]);
    await answerInterview(core, conversationId, '做我的营销参谋');
    await core.rpc.call('bots.interview.answerPath', { conversationId, path: null });

    await waitForRun(core, conversationId, 'completed');
    const request = llm.requestsFor('mock-main')[0]!;
    const body = JSON.stringify(request.body.messages);
    expect(body).toContain('做我的营销参谋');
    expect(body).toContain('暂不设置工作目录');

    // 一次投递一次 run，触发批含首答与目录决定两条。
    const run = (await listRuns(core, conversationId)).find((r) => r.loopType === 'turn')!;
    expect(run.triggerMessageIds).toHaveLength(2);
  }, 20_000);

  it('choosing a directory binds the workdir before the run starts', async () => {
    const { core, llm } = await start();
    const conversationId = await createInterviewConversation(core);
    const dir = tmpDir();

    llm.script('mock-main', [step().replyText('好的，目录我记下了。')]);
    await answerInterview(core, conversationId, '帮我维护这个仓库');
    await core.rpc.call('bots.interview.answerPath', { conversationId, path: dir });
    await waitForRun(core, conversationId, 'completed');

    // 绑定发生在 run 之前：<workdir> 段进入系统提示，对话绑定可查。
    const request = llm.requestsFor('mock-main')[0]!;
    expect(JSON.stringify(request.body.messages)).toContain('<workdir>');
    const conversation = (await core.rpc.call('conversations.get', { id: conversationId })) as {
      conversation: Conversation;
    };
    expect(conversation.conversation.workdirId).not.toBeNull();

    // 绑定系统消息 + setupAnswer 消息都在卡片之后。
    const all = messagesOf(core, conversationId);
    expect(
      all.some(
        (m) =>
          m.kind === 'system_event' &&
          'text' in m.content &&
          m.content.text.includes('工作目录已绑定为'),
      ),
    ).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  }, 20_000);

  it('typed messages during the gate are buffered and delivered together', async () => {
    const { core, llm } = await start();
    const conversationId = await createInterviewConversation(core);

    llm.script('mock-main', [step().replyText('两条都看到了。')]);
    await answerInterview(core, conversationId, '做我的写作助手');
    await core.rpc.call('messages.send', { conversationId, text: '顺便每天九点提醒我' });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(await listRuns(core, conversationId)).toHaveLength(0);

    await core.rpc.call('bots.interview.answerPath', { conversationId, path: null });
    await waitForRun(core, conversationId, 'completed');
    const body = JSON.stringify(llm.requestsFor('mock-main')[0]!.body.messages);
    expect(body).toContain('做我的写作助手');
    expect(body).toContain('顺便每天九点提醒我');
    const run = (await listRuns(core, conversationId)).find((r) => r.loopType === 'turn')!;
    expect(run.triggerMessageIds).toHaveLength(3);
  }, 20_000);

  it('rejects a second path answer and answers after the gate is open', async () => {
    const { core, llm } = await start();
    const conversationId = await createInterviewConversation(core);

    llm.script('mock-main', [step().replyText('好。')]);
    await answerInterview(core, conversationId, '继续');
    await core.rpc.call('bots.interview.answerPath', { conversationId, path: null });
    await waitForRun(core, conversationId, 'completed');

    await expect(
      core.rpc.call('bots.interview.answerPath', { conversationId, path: null }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    // 拒绝即不落库：用户消息仍只有首答 + 目录决定两条。
    expect(messagesOf(core, conversationId).filter((m) => m.senderType === 'user')).toHaveLength(2);
  }, 20_000);
});

