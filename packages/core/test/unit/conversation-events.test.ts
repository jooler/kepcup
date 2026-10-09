import { describe, expect, it } from 'vitest';
import type { Bot, Conversation } from '@kepcup/shared';
import { createEventBus } from '../../src/infra/events.js';
import { withDirectConversationBots } from '../../src/infra/conversation-events.js';

/**
 * conversation.updated 出核前补单聊 bot：renderer 把「单聊无 bot」当作 Bot
 * 已删除而不加入左栏，原始 domain 行直接推出去时新 Bot 要刷新才可见。
 */

type Events = {
  'conversation.updated': { conversation: Conversation };
  'other.event': { value: number };
};

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv_1',
    type: 'direct',
    title: null,
    directBotId: 'bot_1',
    projectId: null,
    readOnly: false,
    summary: null,
    summaryUptoSeq: 0,
    lastSeq: 0,
    lastReadSeq: 0,
    lastMessageAt: null,
    createdAt: 1,
    ...overrides,
  } as Conversation;
}

const BOT = { id: 'bot_1', name: '写手', status: 'active' } as Bot;

function setup(lookup: ((id: string) => Bot | null) | null) {
  const bus = withDirectConversationBots(createEventBus<Events>(), () => lookup);
  const seen: Conversation[] = [];
  bus.on('conversation.updated', ({ conversation: c }) => seen.push(c));
  return { bus, seen };
}

describe('withDirectConversationBots', () => {
  it('单聊原始行：补上 bot', () => {
    const { bus, seen } = setup((id) => (id === 'bot_1' ? BOT : null));
    bus.emit('conversation.updated', { conversation: conversation() });
    expect(seen[0]?.bot).toEqual(BOT);
  });

  it('Bot 查不到：显式 null（与 conversations.list 视图一致）', () => {
    const { bus, seen } = setup(() => null);
    bus.emit('conversation.updated', { conversation: conversation() });
    expect(seen[0]?.bot).toBeNull();
  });

  it('已带 bot（含 null）、群聊、域未就绪、查询抛错：原样放行', () => {
    const other = { ...BOT, name: '别的' } as Bot;
    const { bus, seen } = setup(() => BOT);
    bus.emit('conversation.updated', { conversation: conversation({ bot: other }) });
    bus.emit('conversation.updated', { conversation: conversation({ bot: null }) });
    bus.emit('conversation.updated', {
      conversation: conversation({ type: 'group', directBotId: null }),
    });
    expect(seen.map((c) => c.bot)).toEqual([other, null, undefined]);

    const locked = setup(null);
    locked.bus.emit('conversation.updated', { conversation: conversation() });
    expect(locked.seen[0]?.bot).toBeUndefined();

    const closed = setup(() => {
      throw new Error('database closed');
    });
    closed.bus.emit('conversation.updated', { conversation: conversation() });
    expect(closed.seen[0]?.bot).toBeUndefined();
  });

  it('其它事件与 on/clear 不受影响', () => {
    const { bus } = setup(() => BOT);
    const values: number[] = [];
    const off = bus.on('other.event', ({ value }) => values.push(value));
    bus.emit('other.event', { value: 1 });
    off();
    bus.emit('other.event', { value: 2 });
    bus.on('other.event', ({ value }) => values.push(value));
    bus.clear();
    bus.emit('other.event', { value: 3 });
    expect(values).toEqual([1]);
  });
});
