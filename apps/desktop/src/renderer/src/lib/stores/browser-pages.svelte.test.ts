import { describe, expect, it } from 'vitest';
import { hasBrowserPage } from './browser-pages.svelte';

describe('hasBrowserPage', () => {
  const pages = [{ botId: 'b1', conversationId: 'c1' }];
  it('matches only the same bot and conversation', () => {
    expect(hasBrowserPage(pages, 'b1', 'c1')).toBe(true);
    expect(hasBrowserPage(pages, 'b1', 'c2')).toBe(false);
    expect(hasBrowserPage(pages, 'b2', 'c1')).toBe(false);
    expect(hasBrowserPage([], 'b1', 'c1')).toBe(false);
  });
});
