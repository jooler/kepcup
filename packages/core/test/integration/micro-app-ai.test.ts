import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestStack, makeBot, openDirect, step } from '@kepcup/testkit';
import type { CoreHarness, TestStack } from '@kepcup/testkit';

/**
 * 微应用模型网关（D112，设计 55 §8）：`microApps.ai.*` 的 core 集成路径——
 * 隔离（不进主对话）、预算三档、并发 1、流式事件、记账归编写 Bot、能力路由。
 * 模型走 testkit 的 mock-llm（`custom:mock/mock-light` 为默认轻量模型）。
 */

let stack: TestStack;
let core: CoreHarness;
let botId: string;
let conversationId: string;

beforeAll(async () => {
  stack = await createTestStack();
  core = stack.core;
  const bot = await makeBot(core, 'Emma');
  botId = bot.id;
  const conversation = await openDirect(core, botId);
  conversationId = conversation.id;
});

afterAll(async () => {
  await stack.cleanup();
});

const HTML = '<!DOCTYPE html><html><body></body></html>';

/** 建一个声明了 ai.chat 的微应用并 open 出 resourceId；返回卡片消息 id。 */
async function createMicroApp(permissions: string[]): Promise<{ widgetId: string; messageId: string }> {
  const created = core.services.widgets!.create({
    botId,
    conversationId,
    title: '小小英语角',
    description: '',
    html: HTML,
    scope: 'conversation',
    runId: '',
    manifest: {
      spec: 'kepcup-micro-app/1',
      slug: 'english-corner',
      name: '小小英语角',
      description: '',
      entry: 'index.html',
      permissions,
    },
  });
  if (!created.ok) throw new Error(created.message);
  const listed = (await core.rpc.call('messages.list', { conversationId, limit: 5 })) as {
    messages: Array<{ id: string; kind: string }>;
  };
  const card = [...listed.messages].reverse().find((message) => message.kind === 'card');
  if (card === undefined) throw new Error('card message not found');
  return { widgetId: created.widgetId, messageId: card.id };
}

async function openResource(messageId: string): Promise<string> {
  const opened = (await core.rpc.call('widgets.ui.open', { messageId })) as { resourceId: string };
  return opened.resourceId;
}

describe('microApps.ai（模型平面）', () => {
  it('未声明 ai.chat 的微应用 → NOT_DECLARED；声明后 chat 走 mock 模型并记账', async () => {
    const bare = await createMicroApp(['storage.kv']);
    const bareResource = await openResource(bare.messageId);
    await expect(
      core.rpc.call('microApps.ai.chat', {
        resourceId: bareResource,
        instanceId: 'mai_t_bare',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      }),
    ).rejects.toMatchObject({ code: 'MICRO_APP_CAPABILITY_NOT_DECLARED' });

    stack.llm.script('mock-light', [step().replyText('Hello!')]);
    const app = await createMicroApp(['storage.kv', 'ai.chat']);
    const resourceId = await openResource(app.messageId);
    const reply = (await core.rpc.call('microApps.ai.chat', {
      resourceId,
      instanceId: 'mai_t_1',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    })) as { text: string };
    expect(reply.text).toBe('Hello!');
    // 记账：usage_ledger（loop_type=micro_app，归属编写 Bot）+ micro_app_usage。
    const usageRow = core.services
      .mainDb!.prepare(
        "select * from usage_ledger where loop_type = 'micro_app' and bot_id = ? order by created_at desc limit 1",
      )
      .get(botId) as { provider: string; model: string } | undefined;
    expect(usageRow?.provider).toBe('custom:mock');
    expect(usageRow?.model).toBe('mock-light');
    const usage = core.services
      .mainDb!.prepare('select ai_calls, ai_tokens from micro_app_usage where widget_id = ?')
      .get(app.widgetId) as { ai_calls: number; ai_tokens: number };
    expect(usage.ai_calls).toBe(1);
    expect(usage.ai_tokens).toBeGreaterThan(0);
  });

  it('上下文隔离：对话里不产生任何消息（ai.chat 不进主对话）', async () => {
    stack.llm.script('mock-light', [step().replyText('Silent reply')]);
    const app = await createMicroApp(['ai.chat']);
    const resourceId = await openResource(app.messageId);
    const countMessages = (): number =>
      Number(
        (
          core.services.mainDb!
            .prepare('select count(*) as n from messages where conversation_id = ?')
            .get(conversationId) as { n: number | bigint }
        ).n,
      );
    const before = countMessages();
    await core.rpc.call('microApps.ai.chat', {
      resourceId,
      instanceId: 'mai_t_iso',
      messages: [{ role: 'user', content: 'tell me a secret' }],
      stream: false,
    });
    expect(countMessages()).toBe(before);
  });

  it('session：create → send（多轮上下文）→ history → reset', async () => {
    stack.llm.script('mock-light', [
      step().replyText('Hi, I am Emma.'),
      step().replyText('You said apple.'),
    ]);
    const app = await createMicroApp(['ai.chat']);
    const resourceId = await openResource(app.messageId);
    const created = (await core.rpc.call('microApps.ai.sessionCreate', {
      resourceId,
      instanceId: 'mai_t_sess',
      system: 'You are Emma.',
    })) as { sessionId: string };
    const first = (await core.rpc.call('microApps.ai.sessionSend', {
      resourceId,
      instanceId: 'mai_t_sess',
      sessionId: created.sessionId,
      text: 'apple',
      stream: false,
    })) as { text: string };
    expect(first.text).toBe('Hi, I am Emma.');
    const second = (await core.rpc.call('microApps.ai.sessionSend', {
      resourceId,
      instanceId: 'mai_t_sess',
      sessionId: created.sessionId,
      text: 'what did I say?',
      stream: false,
    })) as { text: string };
    expect(second.text).toBe('You said apple.');
    const history = (await core.rpc.call('microApps.ai.sessionHistory', {
      resourceId,
      instanceId: 'mai_t_sess',
      sessionId: created.sessionId,
    })) as { messages: Array<{ role: string; content: string }> };
    expect(history.messages.map((message) => [message.role, message.content])).toEqual([
      ['user', 'apple'],
      ['assistant', 'Hi, I am Emma.'],
      ['user', 'what did I say?'],
      ['assistant', 'You said apple.'],
    ]);
    await core.rpc.call('microApps.ai.sessionReset', {
      resourceId,
      instanceId: 'mai_t_sess',
      sessionId: created.sessionId,
    });
    const cleared = (await core.rpc.call('microApps.ai.sessionHistory', {
      resourceId,
      instanceId: 'mai_t_sess',
      sessionId: created.sessionId,
    })) as { messages: unknown[] };
    expect(cleared.messages).toHaveLength(0);
  });

  it('流式：ack 立即带 streamId，delta / done 经 micro-app.stream 事件', async () => {
    stack.llm.script('mock-light', [step().replyText('One two three')]);
    const app = await createMicroApp(['ai.chat']);
    const resourceId = await openResource(app.messageId);
    const events: Array<{ kind: string; delta?: string }> = [];
    const off = core.onEvent('micro-app.stream', (payload) => {
      const event = payload as { instanceId: string; kind: string; delta?: string };
      if (event.instanceId === 'mai_t_stream') events.push(event);
    });
    const started = (await core.rpc.call('microApps.ai.chat', {
      resourceId,
      instanceId: 'mai_t_stream',
      messages: [{ role: 'user', content: 'count' }],
      stream: true,
    })) as { stream: boolean; streamId: string };
    expect(started.stream).toBe(true);
    expect(started.streamId).toMatch(/^s_/);
    await new Promise((resolve) => setTimeout(resolve, 300));
    off();
    expect(events.filter((event) => event.kind === 'delta').length).toBeGreaterThan(0);
    expect(events.some((event) => event.kind === 'done')).toBe(true);
    const joined = events
      .filter((event) => event.kind === 'delta')
      .map((event) => event.delta ?? '')
      .join('');
    expect(joined).toBe('One two three');
  });

  it('并发 1：同实例第二个在途调用得 MICRO_APP_AI_BUSY', async () => {
    stack.llm.script('mock-light', [step().replyText('slow'), step().replyText('never')]);
    const app = await createMicroApp(['ai.chat']);
    const resourceId = await openResource(app.messageId);
    const first = core.rpc.call('microApps.ai.chat', {
      resourceId,
      instanceId: 'mai_t_busy',
      messages: [{ role: 'user', content: 'a' }],
      stream: false,
    });
    await expect(
      core.rpc.call('microApps.ai.chat', {
        resourceId,
        instanceId: 'mai_t_busy',
        messages: [{ role: 'user', content: 'b' }],
        stream: false,
      }),
    ).rejects.toMatchObject({ code: 'MICRO_APP_AI_BUSY' });
    await expect(first).resolves.toMatchObject({ text: 'slow' });
  });

  it('预算：微应用每日上限触发 MICRO_APP_AI_QUOTA', async () => {
    const app = await createMicroApp(['ai.chat']);
    const resourceId = await openResource(app.messageId);
    // 直接把当日用量顶到上限（模拟已耗尽的微应用）。本地时区口径与网关一致。
    const now = new Date();
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    core.services
      .mainDb!.prepare('insert or replace into micro_app_usage (widget_id, day, ai_calls, ai_tokens) values (?, ?, 999, 999999)')
      .run(app.widgetId, day);
    await expect(
      core.rpc.call('microApps.ai.chat', {
        resourceId,
        instanceId: 'mai_t_quota',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      }),
    ).rejects.toMatchObject({ code: 'MICRO_APP_AI_QUOTA' });
    // 清掉顶格数据：不影响后续用例的 Bot 级预算。
    core.services.mainDb!.prepare('delete from micro_app_usage where widget_id = ?').run(app.widgetId);
  });

  it('dispose：实例收口后并发位释放', async () => {
    stack.llm.script('mock-light', [step().replyText('ok')]);
    const app = await createMicroApp(['ai.chat']);
    const resourceId = await openResource(app.messageId);
    await core.rpc.call('microApps.ai.dispose', { resourceId, instanceId: 'mai_t_disp' });
    const reply = (await core.rpc.call('microApps.ai.chat', {
      resourceId,
      instanceId: 'mai_t_disp',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    })) as { text: string };
    expect(reply.text).toBe('ok');
  });

  it('实例归属绑定（审查修复 F3）：instanceId 换 resourceId 即拒绝，不能跨实例打扰', async () => {
    stack.llm.script('mock-light', [step().replyText('a'), step().replyText('b')]);
    const appA = await createMicroApp(['ai.chat']);
    const appB = await createMicroApp(['ai.chat']);
    const resourceA = await openResource(appA.messageId);
    const resourceB = await openResource(appB.messageId);
    // 正常绑定：instanceId 在 resourceA 下首次使用。
    await core.rpc.call('microApps.ai.chat', {
      resourceId: resourceA,
      instanceId: 'mai_t_own',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    });
    // 同一 instanceId 配另一个资源 → 拒绝（防跨实例 cancel / 预算分身）。
    await expect(
      core.rpc.call('microApps.ai.cancel', {
        resourceId: resourceB,
        instanceId: 'mai_t_own',
        target: '*',
      }),
    ).rejects.toMatchObject({ code: 'MICRO_APP_CAPABILITY_DENIED' });
    // 会话读 / 重置同样过归属校验。
    await expect(
      core.rpc.call('microApps.ai.sessionHistory', {
        resourceId: resourceB,
        instanceId: 'mai_t_own',
        sessionId: 'whatever',
      }),
    ).rejects.toMatchObject({ code: 'MICRO_APP_CAPABILITY_DENIED' });
    // dispose 换资源也拒绝（二轮 F2）：实例不被跨实例拆除。
    await expect(
      core.rpc.call('microApps.ai.dispose', { resourceId: resourceB, instanceId: 'mai_t_own' }),
    ).rejects.toMatchObject({ code: 'MICRO_APP_CAPABILITY_DENIED' });
    // 正确归属的 dispose 成功。
    await core.rpc.call('microApps.ai.dispose', { resourceId: resourceA, instanceId: 'mai_t_own' });
  });

  it('归属按 widget 绑定：资源续期（同微应用换 resourceId）不打断在跑实例（二轮 F1）', async () => {
    stack.llm.script('mock-light', [step().replyText('one'), step().replyText('two')]);
    const app = await createMicroApp(['ai.chat']);
    const firstResource = await openResource(app.messageId);
    const first = (await core.rpc.call('microApps.ai.chat', {
      resourceId: firstResource,
      instanceId: 'mai_t_renew',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    })) as { text: string };
    expect(first.text).toBe('one');
    // 模拟租期续期：同一张卡重新 open 出新 resourceId。
    const renewedResource = await openResource(app.messageId);
    const second = (await core.rpc.call('microApps.ai.chat', {
      resourceId: renewedResource,
      instanceId: 'mai_t_renew',
      messages: [{ role: 'user', content: 'again' }],
      stream: false,
    })) as { text: string };
    expect(second.text).toBe('two');
  });

  it('流前失败（预算）也让迭代器收口：error 事件先于任何 delta（审查修复 F5）', async () => {
    const app = await createMicroApp(['ai.chat']);
    const resourceId = await openResource(app.messageId);
    const day = new Date();
    const dayKey = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
    core.services
      .mainDb!.prepare('insert or replace into micro_app_usage (widget_id, day, ai_calls, ai_tokens) values (?, ?, 0, 999999)')
      .run(app.widgetId, dayKey);
    const events: Array<{ kind: string; code?: string }> = [];
    const off = core.onEvent('micro-app.stream', (payload) => {
      const event = payload as { instanceId: string; kind: string; code?: string };
      if (event.instanceId === 'mai_t_prefail') events.push(event);
    });
    const started = (await core.rpc.call('microApps.ai.chat', {
      resourceId,
      instanceId: 'mai_t_prefail',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    })) as { streamId: string };
    await new Promise((resolve) => setTimeout(resolve, 150));
    off();
    core.services.mainDb!.prepare('delete from micro_app_usage where widget_id = ?').run(app.widgetId);
    expect(started.streamId).toMatch(/^s_/);
    expect(events).toEqual([{ instanceId: 'mai_t_prefail', streamId: started.streamId, kind: 'error', code: 'MICRO_APP_AI_QUOTA' }]);
  });
});
