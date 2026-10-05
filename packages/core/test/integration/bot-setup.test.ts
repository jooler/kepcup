import { afterEach, describe, expect, it } from 'vitest';
import type { Bot, Message } from '@kepcup/shared';
import {
  createTestStack,
  waitForEvent,
  waitForMessage,
  waitForRun,
  type TestStack,
} from '@kepcup/testkit';
import { step } from '@kepcup/testkit';
import { SETUP_FIRST_OPTIONS, SETUP_FIRST_QUESTION } from '../../src/tools/setup-tools.js';

/** 1×1 PNG：访谈中头像上传用例的最小合法载荷。 */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * 对话式新建 Bot（UI 改版，参考 Grok Bot）：bots.create(interview) →
 * bots.interview.start 确定性下发「问候 + 固定首问卡片（含预置候选）」→
 * 用户经 bots.interview.answer 作答（setupAnswer 标记消息，触发响应 run）→
 * Bot 用 ask_question 发后续问题卡片（terminate 结束本轮）→ save_profile
 * 累计 profile（展示名保持占位，finish_setup 时一次性生效并结束访谈）。
 * 全程 mock LLM。
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

async function createInterviewBot(
  core: TestStack['core'],
): Promise<{ bot: Bot; conversationId: string }> {
  const created = (await core.rpc.call('bots.create', {
    profile: {},
    interview: true,
  })) as { bot: Bot };
  const started = (await core.rpc.call('bots.interview.start', { id: created.bot.id })) as {
    conversationId: string;
  };
  return { bot: created.bot, conversationId: started.conversationId };
}

/** 初始化问询的用户回答（与 UI 同一条路径：setupAnswer 标记消息）。 */
async function answerInterview(
  core: TestStack['core'],
  conversationId: string,
  text: string,
): Promise<Message> {
  const result = (await core.rpc.call('bots.interview.answer', {
    conversationId,
    text,
  })) as { message: Message };
  expect(result.message.content).toMatchObject({ text, setupAnswer: true });
  return result.message;
}

/**
 * 目录卡作答（19/D59）：首答会先被目录闸门扣下，测试里的首个回答之后都要
 * 过一次 answerPath（选「暂不设置」）才开始首个响应 run。
 */
async function skipSetupPath(core: TestStack['core'], conversationId: string): Promise<void> {
  await core.rpc.call('bots.interview.answerPath', { conversationId, path: null });
}

function questionCards(core: TestStack['core'], conversationId: string): Message[] {
  return (core.services.domain!.messages.list(conversationId, { limit: 200 }) as Message[]).filter(
    (m) =>
      m.kind === 'system_event' && 'event' in m.content && m.content.event === 'bot_setup_question',
  );
}

describe('conversational bot setup (interview)', () => {
  it('interview create makes a placeholder bot in setup state; plain create still requires a name', async () => {
    const { core } = await start();
    const created = (await core.rpc.call('bots.create', { profile: {}, interview: true })) as {
      bot: Bot;
    };
    expect(created.bot.name).toBe('新 Bot');
    expect(created.bot.setupState).toBe('interviewing');

    // 普通创建路径仍然要求非空名字（refine 不受 interview 分支影响）。
    await expect(core.rpc.call('bots.create', { profile: {} })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('interview.start posts the greeting bubble and the fixed first-question card without any LLM run', async () => {
    const { core, llm } = await start();
    const { bot, conversationId } = await createInterviewBot(core);

    // 问候气泡（bot 文本）在前，固定首问卡片（含 4 个预置候选）紧随其后。
    const greeting = await waitForMessage(
      core,
      conversationId,
      (m) => m.senderBotId === bot.id && m.kind === 'text',
    );
    expect(greeting.content).toMatchObject({ text: expect.stringContaining('你好') });
    const card = await waitForMessage(core, conversationId, (m) => m.kind === 'system_event');
    expect(card.content).toMatchObject({
      event: 'bot_setup_question',
      text: SETUP_FIRST_QUESTION,
      options: [...SETUP_FIRST_OPTIONS],
    });
    expect(card.seq).toBeGreaterThan(greeting.seq);

    // 首问是确定性的：不触发任何 LLM 请求，用户作答后才起第一个响应 run。
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(llm.requestsFor('mock-main')).toHaveLength(0);
  }, 20_000);

  it('bots.interview.answer appends a setupAnswer user message and triggers the response run', async () => {
    const { core, llm } = await start();
    const { conversationId } = await createInterviewBot(core);

    llm.script('mock-main', [step().replyText('收到。')]);
    const message = await answerInterview(core, conversationId, '做我的营销参谋');
    expect(message.senderType).toBe('user');
    await skipSetupPath(core, conversationId);

    // 回答照常进入响应 run 的上下文。
    await waitForRun(core, conversationId, 'completed');
    const request = llm.requestsFor('mock-main')[0]!;
    expect(JSON.stringify(request.body.messages)).toContain('做我的营销参谋');
  }, 20_000);

  it('ask_question posts the acknowledgement bubble plus the next question card and ends the run without a final reply', async () => {
    const { core, llm } = await start();
    const { bot, conversationId } = await createInterviewBot(core);

    llm.script('mock-main', [
      step().replyToolCall('ask_question', {
        acknowledgement: '明白了，营销参谋这就上岗。',
        question: '你希望我用什么语气跟你交流？',
        options: ['专业严谨', '轻松幽默', '简洁高效'],
      }),
    ]);
    await answerInterview(core, conversationId, '做我的营销参谋');
    await skipSetupPath(core, conversationId);
    await waitForRun(core, conversationId, 'completed');

    // 访谈指引与 ask_question 工具对模型可见。
    const request = llm.requestsFor('mock-main')[0]!;
    expect(JSON.stringify(request.body.messages)).toContain('<setup_interview>');
    expect(JSON.stringify(request.body.tools)).toContain('ask_question');

    // 确认语气泡 + 问题卡片按顺序落库，候选答案透传。
    const ack = await waitForMessage(
      core,
      conversationId,
      (m) =>
        m.senderBotId === bot.id &&
        m.kind === 'text' &&
        'text' in m.content &&
        m.content.text.includes('营销参谋'),
    );
    expect(ack.content).toMatchObject({ text: '明白了，营销参谋这就上岗。' });
    const card = await waitForMessage(
      core,
      conversationId,
      (m) => m.kind === 'system_event' && 'text' in m.content && m.content.text.includes('语气'),
    );
    expect(card.content).toMatchObject({
      event: 'bot_setup_question',
      options: ['专业严谨', '轻松幽默', '简洁高效'],
    });
    expect(card.seq).toBeGreaterThan(ack.seq);

    // terminate 生效：问题卡片之后没有 finalText 气泡（ack 是最后一条 bot 消息）。
    const all = core.services.domain!.messages.list(conversationId, { limit: 200 }) as Message[];
    const afterCard = all.filter((m) => m.seq > card.seq && m.senderBotId === bot.id);
    expect(afterCard).toHaveLength(0);
    expect(questionCards(core, conversationId)).toHaveLength(2); // 固定首问 + 这一问
  }, 20_000);

  it('ask_question refuses to ask beyond the question cap and the bot wraps up instead', async () => {
    const { core, llm } = await start();
    const { conversationId } = await createInterviewBot(core);
    // interview.start 已发 1 张固定首问卡；再注入 4 张凑满上限（共 5）。
    const messages = core.services.domain!.messages;
    for (let i = 0; i < 4; i++) {
      messages.append({
        conversationId,
        senderType: 'system',
        kind: 'system_event',
        event: 'bot_setup_question',
        text: `问题 ${i + 2}`,
        options: ['a', 'b'],
      });
    }
    expect(questionCards(core, conversationId)).toHaveLength(5);

    llm.script('mock-main', [
      step().replyToolCall('ask_question', { question: '还想再问一个', options: ['x', 'y'] }),
      step().replyText('好的，那就不问了，我们直接开始吧。'),
    ]);
    await answerInterview(core, conversationId, '继续');
    await skipSetupPath(core, conversationId);
    await waitForRun(core, conversationId, 'completed');

    // 被拒后没有新问题卡片（仍是 5 张，最后一张是注入的「问题 5」）。
    const cards = questionCards(core, conversationId);
    expect(cards).toHaveLength(5);
    expect(cards.at(-1)).toMatchObject({ content: { text: '问题 5' } });
  }, 20_000);

  it('save_profile accumulates while the placeholder name stays; finish_setup applies the name and ends the interview', async () => {
    const { core, llm } = await start();
    const { bot, conversationId } = await createInterviewBot(core);

    // 访谈中途：profile 累计字段，展示名保持占位（模型可能提交空名，不能
    // 让侧栏/药丸中途改名甚至露 UUID）。
    llm.script('mock-main', [
      step().replyToolCall('save_profile', {
        changes: [
          { field: 'identity.name', value: '小助' },
          { field: 'role.responsibilities', value: '整理每日资讯' },
        ],
      }),
      step().replyToolCall('ask_question', {
        acknowledgement: '收到。',
        question: '你希望我用什么语气跟你交流？',
        options: ['轻松', '正式'],
      }),
    ]);
    await answerInterview(core, conversationId, '你就叫小助，负责帮我整理每日资讯');
    await skipSetupPath(core, conversationId);
    await waitForRun(core, conversationId, 'completed');

    const mid = (await core.rpc.call('bots.get', { id: bot.id })) as { bot: Bot };
    expect(mid.bot.name).toBe('新 Bot');
    expect(mid.bot.profile.identity.name).toBe('小助');
    expect(mid.bot.profile.role.responsibilities).toBe('整理每日资讯');

    // finish_setup：名字一次性生效 + 结束访谈。
    const renamed = waitForEvent<{ bot: Bot }>(
      core,
      'bot.updated',
      (payload) => payload.bot.id === bot.id && payload.bot.name === '小助',
    );
    llm.script('mock-main', [
      step().replyToolCall('save_profile', {
        changes: [{ field: 'persona.tone', value: '轻松友好' }],
      }),
      step().replyToolCall('finish_setup', {}),
      step().replyText('搞定！我叫小助，负责帮你整理每日资讯。'),
    ]);
    await answerInterview(core, conversationId, '语气轻松一点');
    await renamed;
    await waitForMessage(
      core,
      conversationId,
      (m) =>
        m.senderBotId === bot.id &&
        m.kind === 'text' &&
        'text' in m.content &&
        m.content.text.includes('搞定'),
    );

    const finished = (await core.rpc.call('bots.get', { id: bot.id })) as { bot: Bot };
    expect(finished.bot.name).toBe('小助');
    expect(finished.bot.setupState ?? null).toBeNull();
    expect(finished.bot.profile.role.responsibilities).toBe('整理每日资讯');
    expect(finished.bot.profile.persona.tone).toBe('轻松友好');

    // 访谈结束后的新 run 不再注入 <setup_interview>，也不再提供 setup 工具。
    llm.script('mock-main', [step().replyText('好的，随时吩咐。')]);
    await core.rpc.call('drafts.add', { conversationId, text: '在吗' });
    await core.rpc.call('drafts.flush', { conversationId });
    await waitForMessage(
      core,
      conversationId,
      (m) =>
        m.senderBotId === bot.id &&
        m.kind === 'text' &&
        'text' in m.content &&
        m.content.text.includes('随时吩咐'),
    );
    const request = llm.requestsFor('mock-main').at(-1)!;
    expect(JSON.stringify(request.body.messages)).not.toContain('<setup_interview>');
    expect(JSON.stringify(request.body.tools)).not.toContain('save_profile');
  }, 20_000);

  it('finish_setup keeps the placeholder name when the model never saved one', async () => {
    const { core, llm } = await start();
    const { bot, conversationId } = await createInterviewBot(core);

    llm.script('mock-main', [
      step().replyToolCall('finish_setup', {}),
      step().replyText('初始化完成！'),
    ]);
    await answerInterview(core, conversationId, '就这样吧');
    await skipSetupPath(core, conversationId);
    await waitForMessage(
      core,
      conversationId,
      (m) =>
        m.senderBotId === bot.id &&
        m.kind === 'text' &&
        'text' in m.content &&
        m.content.text.includes('初始化完成'),
    );

    const finished = (await core.rpc.call('bots.get', { id: bot.id })) as { bot: Bot };
    expect(finished.bot.name).toBe('新 Bot');
    expect(finished.bot.setupState ?? null).toBeNull();
  }, 20_000);

  it('save_profile rejects fields outside the setup whitelist and leaves the profile unchanged', async () => {
    const { core, llm } = await start();
    const { bot, conversationId } = await createInterviewBot(core);

    llm.script('mock-main', [
      step().replyToolCall('save_profile', {
        changes: [{ field: 'runtime.model', value: 'evil/model' }],
      }),
      step().replyText('这个字段我不能改。'),
    ]);
    await answerInterview(core, conversationId, '把模型换成 evil/model');
    await skipSetupPath(core, conversationId);
    await waitForMessage(
      core,
      conversationId,
      (m) =>
        m.senderBotId === bot.id &&
        m.kind === 'text' &&
        'text' in m.content &&
        m.content.text.includes('不能改'),
    );

    const after = (await core.rpc.call('bots.get', { id: bot.id })) as { bot: Bot };
    expect(after.bot.profile.runtime.model).toBe('');
    expect(after.bot.name).toBe('新 Bot');
    expect(after.bot.setupState).toBe('interviewing');
  }, 20_000);

  it('interview.start is idempotent: a repeat call does not duplicate greeting or the first question', async () => {
    const { core } = await start();
    const { bot, conversationId } = await createInterviewBot(core);

    const again = (await core.rpc.call('bots.interview.start', { id: bot.id })) as {
      conversationId: string;
    };
    expect(again.conversationId).toBe(conversationId);

    const all = core.services.domain!.messages.list(conversationId, { limit: 200 }) as Message[];
    expect(all.filter((m) => m.senderBotId === bot.id && m.kind === 'text')).toHaveLength(1);
    expect(questionCards(core, conversationId)).toHaveLength(1);
  }, 20_000);

  it('answering after the interview has finished is rejected instead of dropping a hidden message', async () => {
    const { core, llm } = await start();
    const { conversationId } = await createInterviewBot(core);

    llm.script('mock-main', [
      step().replyToolCall('finish_setup', {}),
      step().replyText('初始化完成！'),
    ]);
    await answerInterview(core, conversationId, '就这样吧');
    await skipSetupPath(core, conversationId);
    await waitForMessage(
      core,
      conversationId,
      (m) =>
        m.senderBotId !== null &&
        m.kind === 'text' &&
        'text' in m.content &&
        m.content.text.includes('初始化完成'),
    );

    await expect(
      core.rpc.call('bots.interview.answer', { conversationId, text: '迟到的回答' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    // 拒绝即完全不落库：没有隐藏消息，也没有幽灵 run（首答 + 目录决定共 2 条）。
    const all = core.services.domain!.messages.list(conversationId, { limit: 200 }) as Message[];
    expect(all.filter((m) => m.senderType === 'user')).toHaveLength(2);
  }, 20_000);

  it('uploading an avatar mid-interview keeps the placeholder name until finish_setup', async () => {
    const { core, llm } = await start();
    const { bot, conversationId } = await createInterviewBot(core);

    // 访谈中 profile 已攒下真名（展示名仍应为占位）。
    llm.script('mock-main', [
      step().replyToolCall('save_profile', {
        changes: [{ field: 'identity.name', value: '小助' }],
      }),
      step().replyText('好的，记下了。'),
    ]);
    await answerInterview(core, conversationId, '你就叫小助');
    await skipSetupPath(core, conversationId);
    await waitForRun(core, conversationId, 'completed');

    const uploaded = (await core.rpc.call('bots.avatar.upload', {
      id: bot.id,
      mime: 'image/png',
      bytesBase64: PNG_1PX.toString('base64'),
    })) as { bot: Bot };
    expect(uploaded.bot.avatar).toMatch(/^upload:avatar-\d+\.png$/);
    expect(uploaded.bot.name).toBe('新 Bot');
    expect(uploaded.bot.profile.identity.name).toBe('小助');

    // finish_setup 后名字一次性生效，头像不受影响。
    const renamed = waitForEvent<{ bot: Bot }>(
      core,
      'bot.updated',
      (payload) => payload.bot.id === bot.id && payload.bot.name === '小助',
    );
    llm.script('mock-main', [
      step().replyToolCall('finish_setup', {}),
      step().replyText('初始化完成！'),
    ]);
    await answerInterview(core, conversationId, '就这些');
    await renamed;
    const finished = (await core.rpc.call('bots.get', { id: bot.id })) as { bot: Bot };
    expect(finished.bot.name).toBe('小助');
    expect(finished.bot.avatar).toMatch(/^upload:avatar-\d+\.png$/);
  }, 20_000);
});
