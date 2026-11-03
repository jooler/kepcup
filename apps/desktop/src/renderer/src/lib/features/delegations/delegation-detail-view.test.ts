import { describe, expect, it } from 'vitest';
import { detailViewState } from './delegation-detail-view';

/**
 * 委派详情视图的正文状态机（D113）：不可用 / 加载 / 空态 / 消息列表。
 */

const base = {
  hasDelegation: true,
  exchangeConversationId: 'conv_ex' as string | null,
  openSettled: true,
  openFailed: false,
  messageCount: 3,
};

describe('detailViewState（委派详情正文状态）', () => {
  it('委派行未读到 / v1 行无交换会话 / open 失败 → 不可用', () => {
    expect(detailViewState({ ...base, hasDelegation: false })).toBe('unavailable');
    expect(detailViewState({ ...base, exchangeConversationId: null })).toBe('unavailable');
    expect(detailViewState({ ...base, openFailed: true })).toBe('unavailable');
  });

  it('委派在但 open 未返回 → 加载占位（即使消息为 0）', () => {
    expect(detailViewState({ ...base, openSettled: false, messageCount: 0 })).toBe('loading');
  });

  it('open 已返回且无消息（免打扰 parked 未投递）→ 空态；有消息 → 列表', () => {
    expect(detailViewState({ ...base, messageCount: 0 })).toBe('empty');
    expect(detailViewState({ ...base, messageCount: 1 })).toBe('messages');
    expect(detailViewState({ ...base })).toBe('messages');
  });
});
