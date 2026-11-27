import { describe, expect, it } from 'vitest';
import {
  conversationSearchFields,
  matchesConversationSearch,
  safeConversationPreview,
} from './conversation-search';

describe('conversation search visibility', () => {
  it('cannot match or reveal a hidden original that exists only in the summary', () => {
    const input = {
      title: 'Project Alpha',
      summary: 'HIDDEN_ORIGINAL_ONLY_IN_SUMMARY',
      preview: '',
      hasHiddenMessages: true,
    };

    expect(matchesConversationSearch(input, 'HIDDEN_ORIGINAL')).toBe(false);
    expect(conversationSearchFields(input).preview).toBe('');
    expect(conversationSearchFields(input).texts.join(' ')).not.toContain('HIDDEN_ORIGINAL');
  });

  it('keeps summary search and display for conversations without hidden messages', () => {
    const input = {
      title: 'Project Alpha',
      summary: 'Quarterly planning notes',
      preview: '',
      hasHiddenMessages: false,
    };

    expect(matchesConversationSearch(input, 'quarterly')).toBe(true);
    expect(conversationSearchFields(input).preview).toBe('Quarterly planning notes');
  });
});

describe('safeConversationPreview', () => {
  it('prefers the accumulated last-message preview over the summary', () => {
    expect(
      safeConversationPreview({
        preview: 'latest message',
        summary: 'stale summary',
        hasHiddenMessages: false,
      }),
    ).toBe('latest message');
  });

  it('keeps the hidden placeholder preview even when the conversation has hidden messages', () => {
    expect(
      safeConversationPreview({
        preview: '该消息已被您隐藏',
        summary: 'HIDDEN_ORIGINAL',
        hasHiddenMessages: true,
      }),
    ).toBe('该消息已被您隐藏');
  });

  it('returns an empty preview instead of the raw summary when hidden messages exist', () => {
    expect(
      safeConversationPreview({
        preview: '',
        summary: 'HIDDEN_ORIGINAL',
        hasHiddenMessages: true,
      }),
    ).toBe('');
  });

  it('falls back to the summary when there are no hidden messages and no preview', () => {
    expect(
      safeConversationPreview({
        preview: '',
        summary: 'Quarterly planning notes',
        hasHiddenMessages: false,
      }),
    ).toBe('Quarterly planning notes');
  });
});
