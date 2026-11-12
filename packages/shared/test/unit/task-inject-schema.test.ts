import { describe, expect, it } from 'vitest';
import { tasksInjectInputSchema } from '../../src/rpc/methods.js';
import {
  steerAttachmentSchema,
  taskInjectViewSchema,
  taskViewSchema,
} from '../../src/domain/types.js';

/**
 * D115 附件直注（docs/design/56 §1）：tasks.inject 的输入契约——文本可空
 * （纯附件注入），attachmentIds 可选，两者至少一项非空。
 */

describe('tasksInjectInputSchema', () => {
  const base = { taskId: 'run_1' };

  it('文本 + attachmentIds 都合法', () => {
    const parsed = tasksInjectInputSchema.parse({ ...base, text: '看看这张图', attachmentIds: ['att_1'] });
    expect(parsed.text).toBe('看看这张图');
    expect(parsed.attachmentIds).toEqual(['att_1']);
  });

  it('纯附件：text 空串放行（default 补齐）', () => {
    const parsed = tasksInjectInputSchema.parse({ ...base, text: '', attachmentIds: ['att_1'] });
    expect(parsed.text).toBe('');
    expect(parsed.attachmentIds).toEqual(['att_1']);
    // text 缺省 → default ''
    const defaulted = tasksInjectInputSchema.parse({ ...base, attachmentIds: ['att_1'] });
    expect(defaulted.text).toBe('');
  });

  it('纯文本（无 attachmentIds）与旧契约兼容', () => {
    const parsed = tasksInjectInputSchema.parse({ ...base, text: '继续跑' });
    expect(parsed.text).toBe('继续跑');
    expect(parsed.attachmentIds).toBeUndefined();
  });

  it('空文本 + 无附件 → refine 拒绝', () => {
    expect(() => tasksInjectInputSchema.parse({ ...base, text: '  ' })).toThrow();
    expect(() => tasksInjectInputSchema.parse({ ...base, text: '', attachmentIds: [] })).toThrow();
  });

  it('text 上限沿用 TASK_INSTRUCTION_MAX_CHARS', () => {
    const over = { ...base, text: 'x'.repeat(8001), attachmentIds: ['att_1'] };
    expect(() => tasksInjectInputSchema.parse(over)).toThrow();
  });

  it('attachmentIds 上限 8（防异常客户端放大查询）', () => {
    const eight = { ...base, text: 'x', attachmentIds: Array.from({ length: 8 }, (_, i) => `att_${i}`) };
    expect(tasksInjectInputSchema.parse(eight).attachmentIds).toHaveLength(8);
    const nine = { ...base, text: 'x', attachmentIds: Array.from({ length: 9 }, (_, i) => `att_${i}`) };
    expect(() => tasksInjectInputSchema.parse(nine)).toThrow();
  });
});

describe('steerAttachmentSchema / 任务视图注入条目', () => {
  it('steer 附件元数据：id / fileName / mime / size', () => {
    expect(
      steerAttachmentSchema.parse({ id: 'att_1', fileName: 'photo.png', mime: 'image/png', size: 5 }),
    ).toEqual({ id: 'att_1', fileName: 'photo.png', mime: 'image/png', size: 5 });
    expect(() => steerAttachmentSchema.parse({ id: 'att_1' })).toThrow();
  });

  it('taskInjectViewSchema：attachments 可选（旧数据无该字段）', () => {
    const base = { messageId: 'm1', text: '看图', delivery: 'delivered' as const, at: 1 };
    expect(taskInjectViewSchema.parse(base).attachments).toBeUndefined();
    expect(
      taskInjectViewSchema.parse({
        ...base,
        attachments: [{ id: 'att_1', fileName: 'photo.png', mime: 'image/png', size: 5 }],
      }).attachments,
    ).toHaveLength(1);
  });

  it('taskViewSchema：model 可选可空（外部 Agent 任务缺省）', () => {
    const view = taskViewSchema.parse({
      taskId: 'run_1',
      botId: 'bot_1',
      conversationId: 'conv_1',
      title: '任务',
      state: 'running',
      status: 'running',
      writes: false,
      claims: [],
      cwdKind: 'workspace',
      queueReason: null,
      awaitingInput: false,
      questionMessageId: null,
      createdAt: 1,
      startedAt: null,
      endedAt: null,
      error: null,
      cancelReason: null,
      injects: [],
      lastProgress: null,
      changes: null,
      setup: null,
      continuesTaskId: null,
      continuedByTaskId: null,
    });
    expect(view.model).toBeUndefined();
    expect(taskViewSchema.parse({ ...view, model: 'custom:mock/mock-main' }).model).toBe(
      'custom:mock/mock-main',
    );
  });
});
