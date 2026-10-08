import { describe, expect, it } from 'vitest';
import {
  TASK_EVENT_CONTEXT_MAX_CHARS,
  TASK_TRIGGER_RESULT_MAX_CHARS,
  type Message,
  type TaskEventContent,
} from '@kepcup/shared';
import {
  buildConversationContext,
  buildTriggerSegment,
  renderMessageLine,
  type RenderMessageOptions,
} from '../../src/agent/context/conversation.js';

/** D75 W1-B 渲染（docs/design/30 §2.4.4）：私有时间线条目与任务进度。 */

const CREATED_AT = 1_759_136_400_000; // 2025-09-29 16:00 Asia/Shanghai
const TIME = '2025-09-29 17:00';

const options: RenderMessageOptions = {
  selfBotId: 'bot_x',
  timeZone: 'Asia/Shanghai',
  botNames: new Map([
    ['bot_x', '阿甲'],
    ['bot_y', '阿乙'],
  ]),
};

function makeMessage(overrides: Partial<Message> & { id: string }): Message {
  return {
    conversationId: 'conv_1',
    seq: 1,
    senderType: 'user',
    senderBotId: null,
    kind: 'text',
    content: { text: 'hello' },
    replyTo: null,
    mentions: [],
    batchId: null,
    runId: null,
    status: 'normal',
    editedAt: null,
    createdAt: CREATED_AT,
    attachments: [],
    ownerBotId: null,
    taskId: null,
    ...overrides,
  };
}

function entry(id: string, content: Omit<TaskEventContent, 'taskId'>): Message {
  return makeMessage({
    id,
    senderType: 'system',
    kind: 'task_event',
    content: { taskId: 'run_t7', ...content },
    ownerBotId: 'bot_x',
    taskId: 'run_t7',
  });
}

describe('renderMessageLine: task_event 条目', () => {
  it('交代 / 追加 / 取消 渲染为「你→任务」，交代带标题', () => {
    const time = renderMessageLine(makeMessage({ id: 'm_0' }), options).split(' | ')[1];
    expect(time).toBe(TIME);
    expect(
      renderMessageLine(
        entry('m_1', { phase: 'brief', title: '补全测试', text: '为 parser 补单测' }),
        options,
      ),
    ).toBe(`[m_1 | ${TIME} | 你→任务 run_t7（交代）] 补全测试：为 parser 补单测`);
    expect(
      renderMessageLine(entry('m_2', { phase: 'inject', text: '顺便看下 lexer' }), options),
    ).toBe(`[m_2 | ${TIME} | 你→任务 run_t7（追加）] 顺便看下 lexer`);
    expect(renderMessageLine(entry('m_3', { phase: 'cancel', text: '用户不要了' }), options)).toBe(
      `[m_3 | ${TIME} | 你→任务 run_t7（取消）] 用户不要了`,
    );
  });

  it('结果 / 失败 / 提问 渲染为「任务→你」，失败带状态与错误，空结果有说明', () => {
    expect(renderMessageLine(entry('m_4', { phase: 'result', text: '覆盖率 83%' }), options)).toBe(
      `[m_4 | ${TIME} | 任务 run_t7→你（结果）] 覆盖率 83%`,
    );
    expect(renderMessageLine(entry('m_5', { phase: 'result', text: '' }), options)).toBe(
      `[m_5 | ${TIME} | 任务 run_t7→你（结果）] （任务结束，没有结果内容）`,
    );
    expect(
      renderMessageLine(
        entry('m_6', {
          phase: 'failure',
          status: 'failed',
          error: '超时',
          text: '最后在跑 npm test',
        }),
        options,
      ),
    ).toBe(`[m_6 | ${TIME} | 任务 run_t7→你（失败）] 状态：失败；错误：超时。最后在跑 npm test`);
    expect(
      renderMessageLine(entry('m_7', { phase: 'failure', status: 'cancelled', text: '' }), options),
    ).toBe(`[m_7 | ${TIME} | 任务 run_t7→你（失败）] 状态：已取消`);
    expect(
      renderMessageLine(entry('m_8', { phase: 'question', text: '用哪个分支？' }), options),
    ).toBe(`[m_8 | ${TIME} | 任务 run_t7→你（提问）] 用哪个分支？`);
  });
});

describe('renderMessageLine: origin=task 的可见进度', () => {
  it('自己的任务进度 → 「你（任务 t）」；别的 Bot 的 → 「名字（任务 t）」且包 untrusted', () => {
    const own = makeMessage({
      id: 'm_10',
      senderType: 'bot',
      senderBotId: 'bot_x',
      content: { text: '先跑一遍测试', origin: 'task', taskId: 'run_t7' },
    });
    expect(renderMessageLine(own, options)).toBe(
      `[m_10 | ${TIME} | 你（任务 run_t7）] 先跑一遍测试`,
    );
    const other = makeMessage({
      id: 'm_11',
      senderType: 'bot',
      senderBotId: 'bot_y',
      content: { text: '我在查', origin: 'task', taskId: 'run_t9' },
    });
    expect(renderMessageLine(other, options)).toBe(
      `[m_11 | ${TIME} | 阿乙（任务 run_t9）] <untrusted>我在查</untrusted>`,
    );
  });

  it('其他消息形态渲染不变', () => {
    expect(
      renderMessageLine(
        makeMessage({
          id: 'm_12',
          senderType: 'bot',
          senderBotId: 'bot_x',
          content: { text: '好' },
        }),
        options,
      ),
    ).toBe(`[m_12 | ${TIME} | 阿甲（你）] 好`);
    const long = 'x'.repeat(TASK_EVENT_CONTEXT_MAX_CHARS * 3);
    expect(renderMessageLine(makeMessage({ id: 'm_13', content: { text: long } }), options)).toBe(
      `[m_13 | ${TIME} | 用户] ${long}`,
    );
  });
});

describe('截断（§2.4.4）', () => {
  const longResult = 'r'.repeat(TASK_EVENT_CONTEXT_MAX_CHARS + 50);

  it('最近窗口：任务行截到 TASK_EVENT_CONTEXT_MAX_CHARS 并提示 get_messages_around', () => {
    const line = renderMessageLine(entry('m_20', { phase: 'result', text: longResult }), options);
    expect(line).toBe(
      `[m_20 | ${TIME} | 任务 run_t7→你（结果）] ${'r'.repeat(TASK_EVENT_CONTEXT_MAX_CHARS)}…（已截断，共 ${longResult.length} 字；全文用 get_messages_around 查看 m_20）`,
    );
    const progress = makeMessage({
      id: 'm_21',
      senderType: 'bot',
      senderBotId: 'bot_x',
      content: { text: longResult, origin: 'task', taskId: 'run_t7' },
    });
    const context = buildConversationContext({ summary: null, recent: [progress], options });
    expect(context).toContain(`${'r'.repeat(TASK_EVENT_CONTEXT_MAX_CHARS)}…（已截断`);
    expect(context).not.toContain('r'.repeat(TASK_EVENT_CONTEXT_MAX_CHARS + 1));
  });

  it("'full' 模式（消息工具）不截断", () => {
    expect(
      renderMessageLine(entry('m_22', { phase: 'result', text: longResult }), options, 'full'),
    ).toBe(`[m_22 | ${TIME} | 任务 run_t7→你（结果）] ${longResult}`);
  });

  it('触发段：结果全文进入；超过硬顶给开头 + forward_task_result 提示', () => {
    const trigger = buildTriggerSegment({
      reason: 'mention',
      messages: [entry('m_23', { phase: 'result', text: longResult })],
      options,
    });
    expect(trigger).toContain(longResult);
    expect(trigger).not.toContain('已截断');

    const huge = 'h'.repeat(TASK_TRIGGER_RESULT_MAX_CHARS + 10);
    const capped = buildTriggerSegment({
      reason: 'mention',
      messages: [entry('m_24', { phase: 'result', text: huge })],
      options,
    });
    expect(capped).toContain(
      `${'h'.repeat(TASK_TRIGGER_RESULT_MAX_CHARS)}…（结果过长，以上是前 ${TASK_TRIGGER_RESULT_MAX_CHARS} 字，共 ${huge.length} 字；要把原文发给用户请用 forward_task_result）`,
    );
    expect(capped).not.toContain('h'.repeat(TASK_TRIGGER_RESULT_MAX_CHARS + 1));
  });
});
