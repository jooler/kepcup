import { describe, expect, it } from 'vitest';
import type { Bot, Conversation } from '@kepcup/shared';
import { resolveConversationBot } from './conversation-bot';

const bot: Bot = {
  id: 'bot_writer',
  name: '写手',
  bio: '',
  avatar: null,
  status: 'active',
  systemRole: 'standard',
  setupState: null,
  createdAt: 1,
  profile: {
    identity: { name: '写手', bio: '' },
    persona: { personality: '', tone: '', style: '', values: '', sample_dialogues: [] },
    role: { expertise: '', responsibilities: '' },
    memory: { reflection: '' },
    behavior: { quiet_hours: null },
    runtime: { model: null, sandbox: 'off', agent: { id: '' } },
  },
} as unknown as Bot;

/** 裸 domain Conversation（conversation.updated 事件负载的形状：无 bot 视图字段）。 */
function directConversation(): Conversation {
  return {
    id: 'conv_1',
    type: 'direct',
    title: null,
    directBotId: 'bot_writer',
    projectId: null,
    readOnly: false,
    summary: null,
    summaryUptoSeq: 0,
    lastSeq: 0,
    lastReadSeq: 0,
    lastMessageAt: null,
    createdAt: 1,
  };
}

describe('resolveConversationBot (D70: 管家提议创建的 Bot 只经事件进左栏)', () => {
  it('attaches the contact card to an event-borne direct conversation', () => {
    const resolved = resolveConversationBot(directConversation(), [bot]);
    expect(resolved.refetch).toBe(false);
    expect(resolved.conversation.bot).toEqual(bot);
  });

  it('asks for a refetch when the contacts list does not know the bot yet', () => {
    const resolved = resolveConversationBot(directConversation(), []);
    expect(resolved.refetch).toBe(true);
    expect(resolved.conversation.bot).toBeUndefined();
  });

  it('keeps an attached card as-is (RPC list/get payloads)', () => {
    const view = { ...directConversation(), bot };
    const resolved = resolveConversationBot(view, []);
    expect(resolved).toEqual({ conversation: view, refetch: false });
  });

  it('ignores group conversations and direct rows without a bot id', () => {
    const group = { ...directConversation(), type: 'group' as const, directBotId: null };
    expect(resolveConversationBot(group, []).refetch).toBe(false);
    const noBot = { ...directConversation(), directBotId: null };
    expect(resolveConversationBot(noBot, []).refetch).toBe(false);
  });
});
