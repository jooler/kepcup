import { describe, expect, it } from 'vitest';
import {
  loopTypeSchema,
  messageContentSchema,
  messageKindSchema,
  messageSchema,
  runSchema,
  taskEventContentSchema,
  triggerReasonSchema,
} from '../../src/index.js';

/**
 * messageContentSchema 是无判别字段的 union，按顺序取第一个匹配分支（z.object
 * 默认剥离未知键）。D75 新增 task_event 后，三类内容必须各归其类、不串型。
 */
describe('messageContentSchema（D75 task_event 不串型）', () => {
  it('task_event 内容保留 taskId / phase 等字段，不被 text 分支吞掉', () => {
    const content = {
      taskId: 'run_t1',
      phase: 'failure',
      text: '最后几步摘要',
      status: 'interrupted',
      error: 'boom',
      sourceMessageIds: ['msg_1'],
    };
    expect(messageContentSchema.parse(content)).toEqual(content);
    expect(taskEventContentSchema.safeParse(content).success).toBe(true);
  });

  it("text（含 origin:'task' 进度）仍走 text 分支，且不匹配 task_event", () => {
    const progress = { text: '先跑一遍测试', origin: 'task', taskId: 'run_t1' };
    expect(messageContentSchema.parse(progress)).toEqual(progress);
    expect(taskEventContentSchema.safeParse(progress).success).toBe(false);
    const delegated = {
      text: 'hi',
      origin: 'delegation',
      delegationId: 'dlg_1',
      delegatedBy: 'bot_a',
    };
    expect(messageContentSchema.parse(delegated)).toEqual(delegated);
    expect(messageContentSchema.parse({ text: 'plain' })).toEqual({ text: 'plain' });
  });

  it('system_event 与 card 不受影响', () => {
    const event = { event: 'run_interrupted', text: '执行被中断', internal: true };
    expect(messageContentSchema.parse(event)).toEqual(event);
    const card = { cardType: 'environment', approvalId: 'apr_1' };
    expect(messageContentSchema.parse(card)).toEqual(card);
  });

  it('非法 phase 不会被当成 task_event', () => {
    const parsed = messageContentSchema.parse({ taskId: 'run_t1', phase: 'nope', text: 'x' });
    // Falls through to the text branch (phase stripped) — never a task_event.
    expect(parsed).toEqual({ text: 'x', taskId: 'run_t1' });
    expect(parsed).not.toHaveProperty('phase');
  });
});

describe('D75 shared 枚举与默认值', () => {
  it('新枚举值', () => {
    expect(messageKindSchema.options).toContain('task_event');
    expect(loopTypeSchema.options).toEqual(expect.arrayContaining(['response', 'turn', 'task']));
    expect(triggerReasonSchema.options).toContain('task');
  });

  it('messageSchema / runSchema 新字段对旧载荷取默认值', () => {
    const message = messageSchema.parse({
      id: 'msg_1',
      conversationId: 'conv_a',
      seq: 1,
      senderType: 'user',
      senderBotId: null,
      kind: 'text',
      content: { text: 'hi' },
      replyTo: null,
      batchId: null,
      runId: null,
      status: 'normal',
      editedAt: null,
      createdAt: 1,
    });
    expect(message.ownerBotId).toBeNull();
    expect(message.taskId).toBeNull();
    const run = runSchema.parse({
      id: 'run_1',
      botId: null,
      conversationId: null,
      loopType: 'response',
      status: 'queued',
      triggerReason: null,
      triggerMessageIds: [],
      provider: null,
      model: null,
      outputMessageIds: [],
      summary: null,
      continuedFromRunIds: [],
      error: null,
      chainId: null,
      chainDepth: null,
      parentRunId: null,
      createdAt: 1,
      startedAt: null,
      endedAt: null,
    });
    expect(run).toMatchObject({
      taskTitle: null,
      taskWrites: null,
      taskWorkdir: null,
      originRunId: null,
      resultConsumedAt: null,
      awaitingInput: false,
    });
  });
});
