import { describe, expect, it } from 'vitest';
import { conversationSchema } from '../../src/domain/types.js';
import { projectsCreateInputSchema } from '../../src/rpc/methods.js';

const baseConversation = {
  id: 'conv_1',
  type: 'project',
  title: '项目组',
  directBotId: null,
  workdirId: null,
  readOnly: false,
  summary: null,
  summaryUptoSeq: 0,
  lastSeq: 0,
  lastReadSeq: 0,
  lastMessageAt: null,
  createdAt: 0,
};

describe('conversationSchema (D92 T1a)', () => {
  it('parses a project conversation with goal and leadBotId', () => {
    const conversation = conversationSchema.parse({
      ...baseConversation,
      goal: '完成迁移',
      leadBotId: 'bot_a',
    });
    expect(conversation.goal).toBe('完成迁移');
    expect(conversation.leadBotId).toBe('bot_a');
  });

  it('parses a direct conversation without goal / leadBotId', () => {
    const conversation = conversationSchema.parse({
      ...baseConversation,
      type: 'direct',
      directBotId: 'bot_a',
    });
    expect(conversation.goal).toBeUndefined();
    expect(conversation.leadBotId).toBeUndefined();
  });

  it('rejects the legacy group type and the removed setupState field', () => {
    expect(() => conversationSchema.parse({ ...baseConversation, type: 'group' })).toThrow();
    // Unknown keys are stripped, but the field is gone from the contract: the
    // parsed result never carries it.
    const parsed = conversationSchema.parse({ ...baseConversation, setupState: 'creating' });
    expect('setupState' in parsed).toBe(false);
  });
});

describe('projectsCreateInputSchema', () => {
  const valid = {
    title: '项目组',
    leadBotId: 'bot_a',
    memberBotIds: ['bot_a', 'bot_b'],
  };

  it('accepts a valid creation payload', () => {
    expect(projectsCreateInputSchema.parse(valid)).toEqual(valid);
  });

  it('rejects memberBotIds without the lead', () => {
    expect(() =>
      projectsCreateInputSchema.parse({ ...valid, memberBotIds: ['bot_b', 'bot_c'] }),
    ).toThrow(/负责人必须是项目成员/);
  });

  it('rejects fewer than two members', () => {
    expect(() => projectsCreateInputSchema.parse({ ...valid, memberBotIds: ['bot_a'] })).toThrow();
  });

  it('rejects an empty title and an over-long goal', () => {
    expect(() => projectsCreateInputSchema.parse({ ...valid, title: '' })).toThrow();
    expect(() =>
      projectsCreateInputSchema.parse({ ...valid, goal: 'x'.repeat(4001) }),
    ).toThrow();
  });
});
