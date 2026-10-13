import { describe, expect, it } from 'vitest';
import { hasBrowserPage } from './browser-pages.svelte';

describe('hasBrowserPage', () => {
  const pages = [
    { botId: 'b1', conversationId: 'c1' },
    { botId: 'b2', conversationId: 'group-1' },
  ];
  it('matches only the same bot and conversation', () => {
    expect(hasBrowserPage(pages, 'b1', 'c1')).toBe(true);
    expect(hasBrowserPage(pages, 'b1', 'c2')).toBe(false);
    expect(hasBrowserPage(pages, 'b2', 'c1')).toBe(false);
    expect(hasBrowserPage([], 'b1', 'c1')).toBe(false);
  });
  it('in a group, each member is keyed by group conversation id + bot id', () => {
    expect(hasBrowserPage(pages, 'b2', 'group-1')).toBe(true);
    // Another bot in the same group has no open page.
    expect(hasBrowserPage(pages, 'b1', 'group-1')).toBe(false);
    // Same bot in a different conversation does not match.
    expect(hasBrowserPage(pages, 'b2', 'group-2')).toBe(false);
  });
});
