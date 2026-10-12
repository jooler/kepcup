import { afterEach, describe, expect, it } from 'vitest';
import type { Message } from '@kepcup/shared';
import {
  createTestStack,
  listAllMessages,
  makeBot,
  openDirect,
  step,
  waitFor,
  type TestStack,
} from '@kepcup/testkit';

/**
 * 组件回传端到端（D87 P4 L3）：用户在组件卡上确认后，`widgets.ui.reply` 把组件的文字作为用户
 * 消息发进卡片所在对话（`origin: 'widget'`），正常触发 Bot；Bot 在上下文里看到「经组件发出」且
 * 正文包在 `<untrusted source="widget">` 里。每卡冷却在 core 侧也生效（不依赖渲染端）。
 */

const stacks: TestStack[] = [];
afterEach(async () => {
  for (const stack of stacks.splice(0)) {
    stack.llm.releaseAll();
    await stack.cleanup();
  }
});

describe('widget reply (D87 P4 L3)', () => {
  it('a confirmed reply lands as a widget-origin user message, triggers the bot, and is rate limited per card', async () => {
    const stack = await createTestStack();
    stacks.push(stack);
    const bot = await makeBot(stack.core, '小组件');
    const conv = await openDirect(stack.core, bot.id);
    const widgets = stack.core.services.widgets;
    if (widgets === null) throw new Error('widget service unavailable');
    const created = widgets.create({
      botId: bot.id,
      conversationId: conv.id,
      title: '购物清单',
      description: '',
      html: '<!DOCTYPE html><p>清单</p>',
      scope: 'conversation',
      runId: 'run_t',
      check: {
        status: 'passed',
        summary: {
          craftId: 'wcf_t',
          gateRounds: 1,
          reviewRounds: 1,
          reviewSkipped: false,
          previewed: true,
          knownIssues: [],
        },
      },
    });
    if (!created.ok || created.cardMessageId === null) throw new Error(JSON.stringify(created));

    stack.llm.script('mock-main', [
      step()
        .inTurn()
        .expect((req) => {
          const text = req.lastUserText();
          return (
            text.includes(`经组件 ${created.widgetId} 发出`) &&
            text.includes('<untrusted source="widget">') &&
            text.includes('牛奶、鸡蛋')
          );
        })
        .replyText('收到清单。'),
    ]);

    const opened = (await stack.core.rpc.call('widgets.ui.open', {
      messageId: created.cardMessageId,
    })) as { resourceId: string };
    const sent = (await stack.core.rpc.call('widgets.ui.reply', {
      resourceId: opened.resourceId,
      text: '清单：牛奶、鸡蛋',
    })) as { ok: boolean; messageId?: string };
    expect(sent.ok).toBe(true);

    const userMessage = await waitFor(
      async () =>
        (await listAllMessages(stack.core, conv.id)).find((m) => m.id === sent.messageId) ?? null,
      { label: 'widget reply message' },
    );
    expect(userMessage.senderType).toBe('user');
    expect(userMessage.content).toMatchObject({
      text: '清单：牛奶、鸡蛋',
      origin: 'widget',
      widgetId: created.widgetId,
      widgetVersion: 1,
    });

    await waitFor(
      async () =>
        (await listAllMessages(stack.core, conv.id)).find(
          (m: Message) =>
            m.senderType === 'bot' && (m.content as { text?: string }).text === '收到清单。',
        ) ?? null,
      { label: 'bot reply' },
    );

    // 冷却：同一张卡紧接着再回传被 core 拒绝（渲染端之外的那一侧）。
    await expect(
      stack.core.rpc.call('widgets.ui.reply', { resourceId: opened.resourceId, text: '再来一次' }),
    ).rejects.toMatchObject({ code: 'WIDGET_RATE_LIMITED' });
  });
});
