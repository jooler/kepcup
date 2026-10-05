import { describe, expect, it } from 'vitest';

import {
  checkMemoryCandidate,
  checkProfileCandidate,
  type EvidenceMessage,
  type WriteCheckContext,
} from '../../src/memory/validate.js';

/** Evidence fixture: one user message + one bot message in conv A. */
const USER_MSG = 'msg_user_1';
const BOT_MSG = 'msg_bot_1';

function makeContext(
  messages: Record<string, EvidenceMessage>,
  botConversations: string[] = ['conv_a'],
): WriteCheckContext {
  return {
    getMessage: (id) => messages[id] ?? null,
    botConversationIds: () => new Set(botConversations),
  };
}

const baseCtx = makeContext({
  [USER_MSG]: { id: USER_MSG, conversationId: 'conv_a', senderType: 'user', status: 'normal' },
  [BOT_MSG]: { id: BOT_MSG, conversationId: 'conv_a', senderType: 'bot', status: 'normal' },
});

function memoryCandidate(overrides: Partial<Parameters<typeof checkMemoryCandidate>[0]> = {}) {
  return {
    kind: 'episode' as const,
    content: '用户上周和我一起修复了一个构建故障',
    source: 'inferred' as const,
    evidenceMessageIds: [USER_MSG],
    confidence: 0.9,
    sensitivity: 'normal' as const,
    privateToBot: false,
    ...overrides,
  };
}

function profileCandidate(overrides: Partial<Parameters<typeof checkProfileCandidate>[0]> = {}) {
  return {
    content: '用户是后端工程师，偏好 Go',
    source: 'explicit' as const,
    evidenceMessageIds: [USER_MSG],
    confidence: 0.95,
    sensitivity: 'normal' as const,
    privateToBot: false,
    ...overrides,
  };
}

describe('write validation (P07 写入校验，每条规则正反例)', () => {
  it('accepts a well-formed memory candidate', () => {
    expect(checkMemoryCandidate(memoryCandidate(), 'bot_1', baseCtx)).toEqual({
      verdict: 'write',
      reason: '',
    });
  });

  it('rule 1: evidence must exist, not be recalled and belong to the bot', () => {
    const missing = makeContext({});
    expect(
      checkMemoryCandidate(memoryCandidate(), 'bot_1', missing).verdict,
    ).toBe('drop');

    const recalled = makeContext({
      [USER_MSG]: { id: USER_MSG, conversationId: 'conv_a', senderType: 'user', status: 'recalled' },
    });
    expect(
      checkMemoryCandidate(memoryCandidate(), 'bot_1', recalled).verdict,
    ).toBe('drop');

    const otherConversation = makeContext(
      {
        [USER_MSG]: { id: USER_MSG, conversationId: 'conv_other', senderType: 'user', status: 'normal' },
      },
      ['conv_a'],
    );
    const result = checkMemoryCandidate(memoryCandidate(), 'bot_1', otherConversation);
    expect(result.verdict).toBe('drop');
    expect(result.reason).toContain("outside this bot's conversations");
  });

  it('rule 2: fact/preference require a user message in evidence', () => {
    expect(
      checkMemoryCandidate(memoryCandidate({ kind: 'fact' }), 'bot_1', baseCtx).verdict,
    ).toBe('write');
    expect(
      checkMemoryCandidate(
        memoryCandidate({ kind: 'fact', evidenceMessageIds: [BOT_MSG] }),
        'bot_1',
        baseCtx,
      ).verdict,
    ).toBe('drop');
    expect(
      checkMemoryCandidate(
        memoryCandidate({ kind: 'preference', evidenceMessageIds: [BOT_MSG] }),
        'bot_1',
        baseCtx,
      ).verdict,
    ).toBe('drop');
    // Other kinds may rest on bot messages alone (lessons, self notes).
    expect(
      checkMemoryCandidate(
        memoryCandidate({ kind: 'lesson', evidenceMessageIds: [BOT_MSG] }),
        'bot_1',
        baseCtx,
      ).verdict,
    ).toBe('write');
  });

  it('rule 3: sensitive / private-to-bot proposals downgrade to bot-private memory', () => {
    expect(
      checkProfileCandidate(profileCandidate({ sensitivity: 'sensitive' }), 'bot_1', baseCtx)
        .verdict,
    ).toBe('private-only');
    expect(
      checkProfileCandidate(profileCandidate({ privateToBot: true }), 'bot_1', baseCtx).verdict,
    ).toBe('private-only');
    expect(checkProfileCandidate(profileCandidate(), 'bot_1', baseCtx).verdict).toBe('write');
  });

  it('rule 3b: every profile proposal requires user evidence — from other bots it is dropped', () => {
    const result = checkProfileCandidate(
      profileCandidate({ evidenceMessageIds: [BOT_MSG] }),
      'bot_1',
      baseCtx,
    );
    expect(result.verdict).toBe('drop');
    expect(result.reason).toContain('user message');
  });

  it('rule 4: credential-shaped content is dropped for memories and proposals', () => {
    const result = checkMemoryCandidate(
      memoryCandidate({ content: '用户的密码是abc123456' }),
      'bot_1',
      baseCtx,
    );
    expect(result.verdict).toBe('drop');
    expect(
      checkProfileCandidate(profileCandidate({ content: 'key: sk-abcdefghij1234567890' }), 'bot_1', baseCtx)
        .verdict,
    ).toBe('drop');
  });

  it('rule 5: low-confidence inferred items are dropped', () => {
    expect(
      checkMemoryCandidate(memoryCandidate({ confidence: 0.4 }), 'bot_1', baseCtx).verdict,
    ).toBe('drop');
    // Explicit items are never dropped for confidence.
    expect(
      checkMemoryCandidate(
        memoryCandidate({ confidence: 0.2, source: 'explicit' }),
        'bot_1',
        baseCtx,
      ).verdict,
    ).toBe('write');
    expect(
      checkProfileCandidate(
        profileCandidate({ confidence: 0.4, source: 'inferred' }),
        'bot_1',
        baseCtx,
      ).verdict,
    ).toBe('drop');
  });
});
