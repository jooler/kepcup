import type { WikiPage } from '@kepcup/shared';

/**
 * Wiki topic index (任务 6): titles extracted from `index.md` for the
 * `<wiki_topics>` prompt section, plus the page-title helper used by the FTS
 * indexer. All pure functions.
 */

const INDEX_LINE = /^\s*(?:[-*]\s*)?\[(?<title>[^\]]+)\]\((?<path>[^)\s]+)\)/;

/**
 * Extracts the page entries from `index.md` ("每页一行：链接 + 一句话摘要").
 * Every markdown link counts as one entry; duplicate paths collapse to the
 * first occurrence. Non-link lines (headings, comments, blank) are ignored.
 */
export function extractWikiTopics(indexMarkdown: string): WikiPage[] {
  const pages = new Map<string, WikiPage>();
  for (const line of indexMarkdown.split('\n')) {
    const match = INDEX_LINE.exec(line);
    const title = match?.groups?.['title']?.trim();
    const rawPath = match?.groups?.['path']?.trim();
    if (title === undefined || title.length === 0 || rawPath === undefined || rawPath.length === 0) {
      continue;
    }
    const pagePath = rawPath.replace(/^\.\//, '');
    if (!pages.has(pagePath)) pages.set(pagePath, { path: pagePath, title });
  }
  return [...pages.values()];
}

/** Renders the topic list as `- title（path）` lines for the prompt section. */
export function formatWikiTopics(pages: WikiPage[]): string {
  return pages.map((page) => `- ${page.title}（${page.path}）`).join('\n');
}

/** First `# ` heading of a page, falling back to the file base name. */
export function pageTitleOf(content: string, pagePath: string): string {
  for (const line of content.split('\n')) {
    const match = /^#\s+(.+?)\s*$/.exec(line);
    if (match !== null) return match[1]!;
  }
  const base = pagePath.split('/').pop() ?? pagePath;
  return base.replace(/\.md$/i, '');
}
