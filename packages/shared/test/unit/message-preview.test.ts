import { describe, expect, it } from 'vitest';
import { cardPreviewText, messagePreviewText, type Message } from '../../src/index.js';

function message(overrides: Record<string, unknown>): Message {
  return {
    id: 'msg_1',
    conversationId: 'conv_1',
    seq: 1,
    senderType: 'system',
    senderBotId: null,
    kind: 'card',
    content: { cardType: 'mail', approvalId: '' },
    replyTo: null,
    mentions: [],
    batchId: null,
    runId: null,
    status: 'normal',
    editedAt: null,
    createdAt: 1,
    attachments: [],
    ownerBotId: null,
    taskId: null,
    ...overrides,
  } as unknown as Message;
}

describe('cardPreviewText（左栏卡片预览）', () => {
  it('邮件卡：icon + 标题 + 发件人 · 主题，压成单行', () => {
    expect(
      cardPreviewText({
        cardType: 'mail',
        mailEvent: 'arrived',
        mailFrom: '"CSDN" <csdn@example.com>',
        mailSubject: '2026 CSDN 1024 Builder 大会\n报名中',
        mailSummary: '摘要不应盖过信封',
      }),
    ).toBe('✉️ 新邮件 "CSDN" <csdn@example.com> · 2026 CSDN 1024 Builder 大会 报名中');
  });

  it('监看 / 任务 / 委派 / 展示 / 组件 / 应用界面各有可读标题', () => {
    expect(
      cardPreviewText({ cardType: 'watch', watchEvent: 'alert', watchSummary: '价格下降' }),
    ).toBe('👁️ 网页监看提醒 价格下降');
    expect(cardPreviewText({ cardType: 'watch', watchEvent: 'created' })).toBe(
      '👁️ 网页监看 已创建',
    );
    expect(cardPreviewText({ cardType: 'task' })).toBe('📋 任务');
    expect(cardPreviewText({ cardType: 'delegation_sent' })).toBe('🤝 已转交任务');
    expect(cardPreviewText({ cardType: 'delegation_result' })).toBe('🤝 转交结果');
    expect(
      cardPreviewText({ cardType: 'present', present: { kind: 'line', title: '增长趋势' } }),
    ).toBe('📈 增长趋势');
    expect(
      cardPreviewText({
        cardType: 'bot_widget',
        widget: { title: '销售看板', description: '按周查看' },
      }),
    ).toBe('🧩 销售看板 按周查看');
    expect(
      cardPreviewText({
        cardType: 'mcp_app',
        appUi: { appName: 'GitHub', title: 'Issue 列表' },
      }),
    ).toBe('🧩 GitHub Issue 列表');
  });

  it('审批类卡片按 cardType 给标题；未知卡片也有兜底', () => {
    expect(cardPreviewText({ cardType: 'environment' })).toBe('📦 环境安装请求');
    expect(cardPreviewText({ cardType: 'bot_handover' })).toBe('🤝 Bot 移交');
    expect(cardPreviewText({ cardType: 'something_new' })).toBe('🗂️ 卡片');
  });
});

describe('messagePreviewText（最后一条消息）', () => {
  it('文本取正文；撤回 / 空文本 / 中间进度不进入预览', () => {
    expect(
      messagePreviewText(
        message({ kind: 'text', content: { text: '  你好\n世界  ' }, senderType: 'bot' }),
      ),
    ).toBe('你好 世界');
    expect(
      messagePreviewText(message({ kind: 'text', content: { text: '撤回' }, status: 'recalled' })),
    ).toBeNull();
    expect(messagePreviewText(message({ kind: 'text', content: { text: '   ' } }))).toBeNull();
    expect(
      messagePreviewText(message({ kind: 'text', content: { text: '进度', interim: true } })),
    ).toBeNull();
  });

  it('卡片走卡片整理；内部系统事件不算，存量邮件 / 监看状态提示算', () => {
    expect(
      messagePreviewText(
        message({
          content: {
            cardType: 'mail',
            mailEvent: 'arrived',
            mailFrom: 'a@example.com',
            mailSubject: '主题',
          },
        }),
      ),
    ).toBe('✉️ 新邮件 a@example.com · 主题');
    expect(
      messagePreviewText(
        message({
          kind: 'system_event',
          content: { event: 'wiki_ingested', text: '内部事件' },
        }),
      ),
    ).toBeNull();
    expect(
      messagePreviewText(
        message({
          kind: 'system_event',
          content: { event: 'mail_status', text: '连接被拒绝' },
        }),
      ),
    ).toBe('⚠️ 连接被拒绝');
  });
});
