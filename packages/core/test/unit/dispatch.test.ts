import { describe, expect, it } from 'vitest';
import type { Message } from '@kepcup/shared';
import { explicitTargets, sortResponders, type TriageDecision } from '../../src/dispatch/dispatcher.js';

let seq = 0;
let now = 1_700_000_000_000;

/** Minimal text message fixture (only the fields the dispatcher reads). */
function msg(overrides: Partial<Message> = {}): Message {
  seq += 1;
  now += 1_000;
  return {
    id: `msg_${String(seq).padStart(4, '0')}`,
    conversationId: 'conv_1',
    seq,
    senderType: 'user',
    senderBotId: null,
    kind: 'text',
    content: { text: overrides.content ? (overrides.content as { text: string }).text : 'hello' },
    replyTo: null,
    mentions: [],
    batchId: 'batch_1',
    runId: null,
    status: 'normal',
    editedAt: null,
    createdAt: now,
    attachments: [],
    ...overrides,
  };
}

const MEMBERS = new Set(['bot_A', 'bot_B', 'bot_C']);

describe('explicitTargets (P05 显式目标)', () => {
  it('unions mentions across the batch in first-appearance order', () => {
    const batch = [
      msg({ mentions: ['bot_B'] }),
      msg({ mentions: ['bot_A', 'bot_B'] }),
    ];
    expect(explicitTargets(batch, MEMBERS, () => null)).toEqual([
      { botId: 'bot_B', reason: 'mention' },
      { botId: 'bot_A', reason: 'mention' },
    ]);
  });

  it('adds the bot sender of a replied-to message as a reply target', () => {
    const botMessage = msg({
      senderType: 'bot',
      senderBotId: 'bot_A',
      content: { text: '我来看看' },
    });
    const batch = [msg({ replyTo: botMessage.id })];
    expect(explicitTargets(batch, MEMBERS, (id) => (id === botMessage.id ? botMessage : null))).toEqual([
      { botId: 'bot_A', reason: 'reply' },
    ]);
  });

  it('ignores replies to user messages (引用用户消息不算目标)', () => {
    const userMessage = msg();
    const batch = [msg({ replyTo: userMessage.id })];
    expect(explicitTargets(batch, MEMBERS, (id) => (id === userMessage.id ? userMessage : null))).toEqual([]);
  });

  it('drops mentions of bots that are not current members', () => {
    const batch = [msg({ mentions: ['bot_A', 'bot_gone'] })];
    expect(explicitTargets(batch, MEMBERS, () => null)).toEqual([{ botId: 'bot_A', reason: 'mention' }]);
  });

  it('a mention wins over a reply when both point at the same bot', () => {
    const botMessage = msg({ senderType: 'bot', senderBotId: 'bot_B', content: { text: 'x' } });
    const batch = [msg({ mentions: ['bot_B'], replyTo: botMessage.id })];
    expect(explicitTargets(batch, MEMBERS, (id) => (id === botMessage.id ? botMessage : null))).toEqual([
      { botId: 'bot_B', reason: 'mention' },
    ]);
  });

  it('orders mixed mention/reply targets by first appearance', () => {
    const botMessage = msg({ senderType: 'bot', senderBotId: 'bot_C', content: { text: 'x' } });
    const batch = [
      msg({ replyTo: botMessage.id }),
      msg({ mentions: ['bot_A'] }),
    ];
    expect(explicitTargets(batch, MEMBERS, (id) => (id === botMessage.id ? botMessage : null))).toEqual([
      { botId: 'bot_C', reason: 'reply' },
      { botId: 'bot_A', reason: 'mention' },
    ]);
  });

  it('skips recalled messages', () => {
    const batch = [msg({ status: 'recalled', mentions: ['bot_A'] })];
    expect(explicitTargets(batch, MEMBERS, () => null)).toEqual([]);
  });
});

describe('sortResponders (P05 判断排序)', () => {
  function decision(botId: string, confidence: number, decision: TriageDecision['decision'] = 'respond'): TriageDecision {
    return { botId, decision, confidence };
  }

  it('sorts by confidence descending', () => {
    const sorted = sortResponders([decision('bot_A', 0.6), decision('bot_B', 0.9), decision('bot_C', 0.75)]);
    expect(sorted.map((d) => d.botId)).toEqual(['bot_B', 'bot_C', 'bot_A']);
  });

  it('keeps input order for equal confidences', () => {
    const sorted = sortResponders([decision('bot_A', 0.5), decision('bot_B', 0.9), decision('bot_C', 0.5)]);
    expect(sorted.map((d) => d.botId)).toEqual(['bot_B', 'bot_A', 'bot_C']);
  });
});
