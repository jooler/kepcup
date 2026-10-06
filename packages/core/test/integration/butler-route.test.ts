import { afterEach, describe, expect, it } from 'vitest';
import { ROUTE_SUGGESTION_EVENT, type Bot, type Delegation, type Message } from '@kepcup/shared';
import {
  createTestStack,
  listMessages,
  makeBot,
  sendBatch,
  step,
  waitFor,
  type MockChatRequest,
  type TestStack,
} from '@kepcup/testkit';

/**
 * 管家路由（D70 §2.4，todo P4）：suggest_route 出路由卡（先卡后办）；用户
 * 点「交给它处理」= 一条用户消息，管家此时才 delegate_to_bot；结果按 D71
 * 贴回管家的对话。全程 mock LLM。
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

const last = (req: MockChatRequest) => req.lastUserText();

function routeCards(messages: Message[]): Message[] {
  return messages.filter(
    (m) => m.kind === 'system_event' && 'event' in m.content && m.content.event === ROUTE_SUGGESTION_EVENT,
  );
}

function delegations(stack: TestStack): Delegation[] {
  const service = stack.core.services.domain!.delegations;
  return (
    stack.core.services.mainDb!.prepare('select id from delegations').all() as Array<{ id: string }>
  ).map((row) => service.getOrThrow(row.id));
}

describe('butler routing (D70 P4)', () => {
  it('路由卡先出、不代办；用户点「交给它处理」后管家才委派，结果贴回管家对话', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const { bot: butler, conversationId } = (await core.rpc.call('butler.ensure', {})) as {
      bot: Bot;
      conversationId: string;
    };
    const writer = await makeBot(core, '文书');
    llm.script('mock-main', [
      step()
        .expect((req) => last(req).includes('帮我写周报'))
        .replyToolCall('suggest_route', {
          route: 'delegate',
          bot_id: writer.id,
          task: '写本周周报',
          reason: '文书擅长周报',
        }),
    ]);
    await sendBatch(core, conversationId, ['帮我写周报']);
    const card = await waitFor(async () => routeCards(await listMessages(core, conversationId))[0]);
    expect(card.content).toMatchObject({
      route: { kind: 'delegate', botId: writer.id, task: '写本周周报' },
    });
    expect((card.content as { text: string }).text).toContain('文书');
    // 先卡后办：没点之前没有任何委派。
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(delegations(stack)).toHaveLength(0);

    llm.script('mock-main', [
      step()
        .expect((req) => last(req).includes('你安排吧'))
        .replyToolCall('delegate_to_bot', { bot_id: writer.id, task: '请写本周周报' }),
      step()
        .expect((req) => last(req).includes('你安排吧') && JSON.stringify(req.body.messages).includes('delegation_id'))
        .replyText('已经交给文书了。'),
      step()
        .expect((req) => last(req).includes('<trigger reason="delegation"'))
        .replyText('本周周报：……'),
      step().expect((req) => last(req).includes('委派结果通知')).replyText('文书写好了。'),
    ]);
    const accepted = (await core.rpc.call('butler.acceptRoute', { messageId: card.id })) as {
      message: Message;
    };
    expect(accepted.message.senderType).toBe('user');
    expect((accepted.message.content as { text: string }).text).toContain('你安排吧');

    const done = await waitFor(
      () => delegations(stack).find((d) => d.status === 'completed') ?? null,
      { timeoutMs: 20_000 },
    );
    expect(done.fromBotId).toBe(butler.id);
    expect(done.toBotId).toBe(writer.id);
    expect(done.fromConversationId).toBe(conversationId);
    expect(done.resultExcerpt).toBe('本周周报：……');
  }, 40_000);

  it('bot / group 路由卡只是跳转建议；acceptRoute 对它们拒绝', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const { conversationId } = (await core.rpc.call('butler.ensure', {})) as {
      conversationId: string;
    };
    const coder = await makeBot(core, '码农');
    llm.script('mock-main', [
      step()
        .expect((req) => last(req).includes('代码报错'))
        .replyToolCall('suggest_route', { route: 'bot', bot_id: coder.id, reason: '码农管代码' }),
    ]);
    await sendBatch(core, conversationId, ['代码报错了']);
    const card = await waitFor(async () => routeCards(await listMessages(core, conversationId))[0]);
    expect(card.content).toMatchObject({ route: { kind: 'bot', botId: coder.id } });
    await expect(
      core.rpc.call('butler.acceptRoute', { messageId: card.id }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  }, 30_000);

  it('suggest_route 只给管家；目标不存在时工具报错且不出卡', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const { conversationId } = (await core.rpc.call('butler.ensure', {})) as {
      conversationId: string;
    };
    llm.script('mock-main', [
      step()
        .expect((req) => last(req).includes('随便'))
        .replyToolCall('suggest_route', { route: 'bot', bot_id: 'bot_nope', reason: '瞎猜' }),
      step().expect((req) => JSON.stringify(req.body.messages).includes('不存在或不可用')).replyText('我查一下通讯录。'),
    ]);
    await sendBatch(core, conversationId, ['随便找个人']);
    await waitFor(async () =>
      (await listMessages(core, conversationId)).find(
        (m) => m.senderType === 'bot' && (m.content as { text?: string }).text === '我查一下通讯录。',
      ),
    );
    expect(routeCards(await listMessages(core, conversationId))).toHaveLength(0);

    const plain = await makeBot(core, '普通');
    const conv = (await core.rpc.call('conversations.openDirect', { botId: plain.id })) as {
      conversation: { id: string };
    };
    llm.script('mock-main', [step().expect((req) => last(req).includes('你好')).replyText('你好')]);
    await sendBatch(core, conv.conversation.id, ['你好']);
    await waitFor(async () =>
      (await listMessages(core, conv.conversation.id)).find((m) => m.senderType === 'bot'),
    );
    // 最后一个请求就是普通 Bot 的（管家的请求上下文里也有欢迎语「你好」，不能按文本找）。
    const request = llm.requestsFor('mock-main').at(-1)!;
    expect(last(request)).toContain('] 你好');
    const tools = (request.body.tools as Array<{ function: { name: string } }>).map(
      (tool) => tool.function.name,
    );
    expect(tools).not.toContain('suggest_route');
  }, 30_000);
});
