import { describe, expect, it, vi } from 'vitest';
import { TestClock } from '@kepcup/testkit';
import {
  COLLAB_PRESENCE_TTL_MS,
  type CollabPresenceChangedPayload,
} from '@kepcup/shared';
import { PresenceService } from '../../src/collab/presence.js';

/** D119 在线状态：合并 / 合流 / 多标签页清理 / TTL / 会话切换。 */

const NOW = Date.parse('2026-11-09T10:00:00.000Z');

function setup() {
  const clock = new TestClock(NOW);
  const published: CollabPresenceChangedPayload[] = [];
  const presence = new PresenceService({
    clock,
    publish: (name, payload) => {
      expect(name).toBe('collab.presenceChanged');
      published.push(payload);
    },
  });
  return { clock, published, presence };
}

function update(
  overrides: Partial<Parameters<PresenceService['update']>[0]> = {},
): Parameters<PresenceService['update']>[0] {
  return {
    clientId: 'client-a',
    clientName: '小明的 MacBook',
    connectionId: 'conn-1',
    conversationId: 'conv-1',
    state: 'viewing',
    ...overrides,
  };
}

describe('PresenceService', () => {
  it('merges by clientId and publishes a full list per conversation', () => {
    const { presence, published } = setup();
    presence.update(update());
    presence.update(update({ clientId: 'client-b', clientName: '我的 iPhone', connectionId: 'conn-2', state: 'typing' }));
    presence.flushNow();

    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ conversationId: 'conv-1' });
    expect(published[0]!.entries.map((entry) => entry.clientId)).toEqual(['client-a', 'client-b']);
    expect(published[0]!.entries[1]).toMatchObject({ state: 'typing' });
    expect(published[0]!.entries[0]!.color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('heartbeat only refreshes updatedAt and does not broadcast', () => {
    const { presence, published, clock } = setup();
    presence.update(update());
    presence.flushNow();
    published.length = 0;

    clock.advance(20_000);
    presence.update(update());
    presence.flushNow();

    expect(published).toHaveLength(0);
    expect(presence.list('conv-1')[0]!.updatedAt).toBe(clock.now());
  });

  it('moving to another conversation publishes both old and new lists', () => {
    const { presence, published } = setup();
    presence.update(update());
    presence.flushNow();
    published.length = 0;

    presence.update(update({ conversationId: 'conv-2' }));
    presence.flushNow();

    const byConversation = new Map(published.map((item) => [item.conversationId, item.entries]));
    expect(byConversation.get('conv-1')).toEqual([]);
    expect(byConversation.get('conv-2')?.map((entry) => entry.clientId)).toEqual(['client-a']);
  });

  it('keeps the entry until every connection of the client leaves', () => {
    const { presence, published } = setup();
    presence.update(update({ connectionId: 'tab-1' }));
    presence.update(update({ connectionId: 'tab-2' }));
    presence.flushNow();
    published.length = 0;

    presence.leave({ clientId: 'client-a', connectionId: 'tab-1' });
    presence.flushNow();
    expect(published).toHaveLength(0);
    expect(presence.list('conv-1')).toHaveLength(1);

    presence.leave({ clientId: 'client-a', connectionId: 'tab-2' });
    presence.flushNow();
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ conversationId: 'conv-1', entries: [] });
    expect(presence.list('conv-1')).toHaveLength(0);
  });

  it('drops entries after the TTL and broadcasts the cleanup', () => {
    const { presence, published, clock } = setup();
    presence.update(update());
    presence.flushNow();
    published.length = 0;

    clock.advance(COLLAB_PRESENCE_TTL_MS - 1);
    presence.sweepExpired();
    expect(presence.list('conv-1')).toHaveLength(1);

    clock.advance(2);
    presence.sweepExpired();
    presence.flushNow();
    expect(presence.list('conv-1')).toHaveLength(0);
    expect(published.at(-1)).toMatchObject({ conversationId: 'conv-1', entries: [] });
  });

  it('sanitizes client names and falls back when only control characters remain', () => {
    const { presence } = setup();
    presence.update(update({ clientName: '  \u0000 小明 \u0007 ' }));
    expect(presence.list('conv-1')[0]!.clientName).toBe('小明');

    presence.update(update({ clientId: 'client-b', connectionId: 'conn-2', clientName: '\u0000\u0001' }));
    expect(presence.list('conv-1').find((entry) => entry.clientId === 'client-b')?.clientName).toBe(
      '未知客户端',
    );
  });

  it('close clears everything and ignores later updates', () => {
    const { presence, published } = setup();
    presence.update(update());
    presence.close();
    presence.update(update({ clientId: 'client-b' }));
    presence.flushNow();
    expect(published).toHaveLength(0);
    expect(presence.list()).toHaveLength(0);
  });

  it('does not keep a flush timer alive after close', () => {
    vi.useFakeTimers();
    try {
      const { presence, published } = setup();
      presence.update(update());
      presence.close();
      vi.runAllTimers();
      expect(published).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
