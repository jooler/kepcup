import { describe, expect, it } from 'vitest';
import type { Approval, Message } from '@kepcup/shared';
import { isVisibleInTranscript } from './transcript-visibility';

/**
 * 共享的会话记录可见性（WP6 步骤 2）：与原 MessageList 的过滤条件逐条一致。
 * MessageList 现在直接用这个函数，两边口径由这一份测试钉死。
 */

type MsgInit = Partial<Omit<Message, 'content'>> &
  Pick<Message, 'id' | 'kind' | 'senderType'> & { content?: unknown };

function msg(partial: MsgInit): Message {
  return {
    conversationId: 'c1',
    seq: 1,
    content: { text: 'hi' },
    status: 'normal',
    createdAt: 1,
    runId: null,
    senderBotId: null,
    batchId: null,
    replyToMessageId: null,
    ...partial,
  } as Message;
}

function approval(status: Approval['status']): Approval {
  return { id: 'apr_1', status } as Approval;
}

describe('isVisibleInTranscript（与原 MessageList 过滤逐条一致）', () => {
  it('普通文本 / 系统事件可见', () => {
    expect(isVisibleInTranscript(msg({ id: 'm1', kind: 'text', senderType: 'bot' }))).toBe(true);
    expect(
      isVisibleInTranscript(
        msg({ id: 'm2', kind: 'system_event', senderType: 'system', content: { event: 'x' } }),
      ),
    ).toBe(true);
  });

  it('初始化问询的用户回答（setupAnswer）不可见——由问题卡片的已答行展示', () => {
    expect(
      isVisibleInTranscript(
        msg({
          id: 'm1',
          kind: 'text',
          senderType: 'user',
          content: { text: '答', setupAnswer: true },
        }),
      ),
    ).toBe(false);
    expect(
      isVisibleInTranscript(
        msg({ id: 'm2', kind: 'text', senderType: 'user', content: { text: '普通' } }),
      ),
    ).toBe(true);
  });

  it('任务进度 interim 文本不可见（单一状态遮罩）', () => {
    expect(
      isVisibleInTranscript(
        msg({
          id: 'm1',
          kind: 'text',
          senderType: 'bot',
          content: { text: '…', interim: true },
        }),
      ),
    ).toBe(false);
  });

  it('run_changes 卡不可见（本地变更摘要 / diff / 回滚已退役）', () => {
    expect(
      isVisibleInTranscript(
        msg({
          id: 'm1',
          kind: 'card',
          senderType: 'bot',
          content: { cardType: 'run_changes' },
        }),
      ),
    ).toBe(false);
    // 其它卡不受这条影响（下面的审批卡另判）。
    expect(
      isVisibleInTranscript(
        msg({ id: 'm2', kind: 'card', senderType: 'bot', content: { cardType: 'other' } }),
      ),
    ).toBe(true);
  });

  it('审批弹窗卡（ephemeral）不可见——输入坞是唯一用户面', () => {
    // isHiddenApprovalCard：卡片 kind 是权限弹窗（access/command/…）且非回执。
    expect(
      isVisibleInTranscript(
        msg({
          id: 'm1',
          kind: 'card',
          senderType: 'bot',
          content: { cardType: 'access', approvalId: 'apr_1' },
        }),
      ),
    ).toBe(false);
  });

  it('回执卡：审批已知 pending 时不可见；已解决 / 未知（老历史）可见', () => {
    const record = msg({
      id: 'm1',
      kind: 'card',
      senderType: 'bot',
      content: { cardType: 'access', record: true, approvalId: 'apr_1' },
    });
    expect(isVisibleInTranscript(record, { apr_1: approval('pending') })).toBe(false);
    expect(isVisibleInTranscript(record, { apr_1: approval('approved') })).toBe(true);
    expect(isVisibleInTranscript(record, {})).toBe(true);
    // 缺省 approvals（徽标场景）等同未知审批：可见。
    expect(isVisibleInTranscript(record)).toBe(true);
  });

  it('已撤回消息仍可见（撤回的小字行仍在会话流里，不算遮罩）', () => {
    expect(
      isVisibleInTranscript(msg({ id: 'm1', kind: 'text', senderType: 'bot', status: 'recalled' })),
    ).toBe(true);
  });
});
