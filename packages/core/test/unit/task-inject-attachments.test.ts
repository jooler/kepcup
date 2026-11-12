import { describe, expect, it } from 'vitest';
import {
  buildTaskAnswer,
  buildTaskBriefSegment,
  buildTaskInjection,
  type TaskBrief,
} from '../../src/dispatch/tasks.js';
import type { RenderMessageOptions } from '../../src/agent/context/conversation.js';
import type { Attachment, Message } from '@kepcup/shared';

/**
 * D115 附件直注（docs/design/56 §1）：注入直带附件在模型侧的呈现——注入条目 /
 * 等问即答 / 简报 later_instructions 里的附件行（`att_… name [mime] 大小`），
 * 与 renderAttachmentEntry 的基础格式同口径。
 */

const options = {} as RenderMessageOptions;

function attachment(id: string, fileName = 'photo.png', mime = 'image/png'): Attachment {
  return {
    id,
    conversationId: 'conv_1',
    messageId: null,
    fileName,
    mime,
    size: 2048,
    sha256: '',
    relPath: 'attachments/x',
    createdAt: 0,
  };
}

describe('buildTaskInjection 附件行', () => {
  it('附件行出现在 <task_inject> 内、尾部说明之前', () => {
    const text = buildTaskInjection(
      '顺便看看这张图',
      [],
      options,
      undefined,
      [attachment('att_a'), attachment('att_b', 'spec.pdf', 'application/pdf')],
    );
    expect(text).toContain('<task_inject>');
    expect(text).toContain('顺便看看这张图');
    expect(text).toContain('att_a photo.png [image/png] 2KB');
    expect(text).toContain('att_b spec.pdf [application/pdf] 2KB');
    const inject = text.slice(text.indexOf('<task_inject>'), text.indexOf('</task_inject>'));
    expect(inject.indexOf('att_a')).toBeGreaterThan(inject.indexOf('顺便看看这张图'));
    expect(inject).not.toContain('据此调整当前的工作'); // 尾部说明在 </task_inject> 之后
    expect(text).toContain('据此调整当前的工作');
    expect(text).toContain('</task_inject>');
  });

  it('无附件：不带附件行（与旧文本直注逐字节一致）', () => {
    const text = buildTaskInjection('纯文本', [], options);
    expect(text).not.toContain('[image/png]');
  });
});

describe('buildTaskAnswer 附件行', () => {
  function userMessage(text: string): Message {
    return {
      id: `m_${text}`,
      conversationId: 'conv_1',
      seq: 1,
      senderType: 'user',
      senderBotId: null,
      kind: 'text',
      content: { text },
      replyTo: null,
      mentions: [],
      batchId: null,
      runId: null,
      status: 'normal',
      editedAt: null,
      createdAt: 0,
      attachments: [],
      ownerBotId: null,
      taskId: null,
    };
  }

  it('有附件有原话：正文 + 附件行 + 原话标注', () => {
    const text = buildTaskAnswer('就用方案 A', [userMessage('换成方案 B')], options, [
      attachment('att_c'),
    ]);
    expect(text).toContain('就用方案 A');
    expect(text).toContain('att_c photo.png [image/png] 2KB');
    expect(text).toContain('<source_messages>');
    expect(text).toContain('转交的回答与原话不一致时以原话为准');
  });

  it('有附件无原话：不产出空 <source_messages> 块（审查 P2-5），提示附件读法', () => {
    const text = buildTaskAnswer('就用方案 A', [], options, [attachment('att_c')]);
    expect(text).not.toContain('<source_messages>');
    expect(text).toContain('get_attachment');
  });

  it('无原文无附件：只返回正文（旧语义不变）', () => {
    expect(buildTaskAnswer('就用方案 A', [], options)).toBe('就用方案 A');
  });
});

describe('buildTaskBriefSegment 注入附件行', () => {
  function brief(injectAttachments: Attachment[]): TaskBrief {
    return {
      task: { id: 'run_t' } as never,
      title: '前端',
      instruction: 'TASK',
      writes: false,
      writeDomains: null,
      sourceMessages: [],
      injects: [
        { text: '再补一张截图', sourceMessages: [], attachments: injectAttachments, at: 1 },
      ],
      continuesTaskId: null,
    };
  }

  it('<later_instructions> 里注入文本后跟附件行', () => {
    const text = buildTaskBriefSegment(brief([attachment('att_d')]), options, null);
    expect(text).toContain('<later_instructions>');
    expect(text).toContain('再补一张截图');
    expect(text).toContain('att_d photo.png [image/png] 2KB');
  });

  it('注入无附件：不产生附件行', () => {
    const text = buildTaskBriefSegment(brief([]), options, null);
    expect(text).not.toContain('[image/png]');
  });
});
