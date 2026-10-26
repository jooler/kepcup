import { describe, expect, it } from 'vitest';
import { isSingleBotConversation } from './single-bot-conversation';

describe('isSingleBotConversation', () => {
  it('is true for direct and card, false for project and anything else', () => {
    expect(isSingleBotConversation('direct')).toBe(true);
    expect(isSingleBotConversation('card')).toBe(true);
    expect(isSingleBotConversation('project')).toBe(false);
    expect(isSingleBotConversation('group')).toBe(false);
  });
});
