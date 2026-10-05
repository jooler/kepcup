/**
 * Minimal HTML → markdown conversion for wiki URL ingest (任务 3: "URL 在沙箱
 * 中抓取后保存为文件（HTML 转为 markdown）"). Deliberately dependency-free and
 * conservative: it keeps headings, paragraphs, links, images, lists, emphasis,
 * code and line/section breaks, and strips everything else (script/style
 * content vanishes with their tags). The converted text is untrusted input for
 * the maintenance loop regardless of conversion quality.
 */

/** Replaces the matched region with newlines so block structure survives. */
function blockReplace(html: string, pattern: RegExp, replacement: string): string {
  return html.replaceAll(pattern, replacement);
}

function decodeEntities(text: string): string {
  return text
    .replaceAll(/&nbsp;/gi, ' ')
    .replaceAll(/&amp;/gi, '&')
    .replaceAll(/&lt;/gi, '<')
    .replaceAll(/&gt;/gi, '>')
    .replaceAll(/&quot;/gi, '"')
    .replaceAll(/&#39;/gi, "'")
    .replaceAll(/&#x?[0-9a-f]+;/gi, '');
}

function inlineToMarkdown(html: string): string {
  return decodeEntities(
    html
      .replaceAll(/<!--[\s\S]*?-->/g, '')
      .replaceAll(/<script[\s\S]*?<\/script\s*>/gi, '')
      .replaceAll(/<style[\s\S]*?<\/style\s*>/gi, '')
      // Anchors: keep text + href (relative and absolute alike).
      .replaceAll(/<a\s[^>]*href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a\s*>/gi, (_m, href: string, text: string) => {
        const label = text.replaceAll(/<[^>]+>/g, '').trim();
        return label.length > 0 ? `[${label}](${href})` : '';
      })
      .replaceAll(/<img\s[^>]*alt\s*=\s*["']([^"']*)["'][^>]*>/gi, (_m, alt: string) => `![${alt}]()`)
      .replaceAll(/<img\s[^>]*src\s*=\s*["']([^"']*)["'][^>]*>/gi, (_m, src: string) => `![image](${src})`)
      .replaceAll(/<(strong|b)\s*>([\s\S]*?)<\/\1\s*>/gi, (_m, _tag: string, text: string) => `**${text.trim()}**`)
      .replaceAll(/<(em|i)\s*>([\s\S]*?)<\/\1\s*>/gi, (_m, _tag: string, text: string) => `*${text.trim()}*`)
      .replaceAll(/<code\s*>([\s\S]*?)<\/code\s*>/gi, (_m, text: string) => `\`${text.trim()}\``)
      .replaceAll(/<br\s*\/?\s*>/gi, '\n'),
  );
}

/** Block-level HTML → markdown. Handles the shapes worth keeping for a wiki. */
export function htmlToMarkdown(input: string): string {
  let html = input
    .replaceAll(/<!--[\s\S]*?-->/g, '')
    .replaceAll(/<script[\s\S]*?<\/script\s*>/gi, '')
    .replaceAll(/<style[\s\S]*?<\/style\s*>/gi, '')
    .replaceAll(/<(head|nav|footer|iframe|form|button|select|svg)[^>]*>[\s\S]*?<\/\1\s*>/gi, '');

  // Headings (h1–h6) → `#`-prefixed lines.
  html = html.replaceAll(
    /<h([1-6])[^>]*>([\s\S]*?)<\/h\1\s*>/gi,
    (_m, level: string, text: string) =>
      `\n${'#'.repeat(Number(level))} ${inlineToMarkdown(text).trim()}\n\n`,
  );

  // Lists: <ul>/<ol> with <li> children → `- item` / `1. item` lines.
  html = html.replaceAll(
    /<(ul|ol)[^>]*>([\s\S]*?)<\/\1\s*>/gi,
    (_m, tag: string, body: string) => {
      const items = [...body.matchAll(/<li[^>]*>([\s\S]*?)<\/li\s*>/gi)].map(
        (m) => inlineToMarkdown(m[1] ?? '').trim().replaceAll(/\s*\n\s*/g, ' '),
      );
      const marker = tag.toLowerCase() === 'ol' ? '1.' : '-';
      return `\n${items.filter((item) => item.length > 0).map((item) => `${marker} ${item}`).join('\n')}\n\n`;
    },
  );

  // Preformatted blocks → fenced code.
  html = html.replaceAll(
    /<pre[^>]*>([\s\S]*?)<\/pre\s*>/gi,
    (_m, text: string) => `\n\`\`\`\n${decodeEntities(text.replaceAll(/<[^>]+>/g, '')).replace(/^\n+|\n+$/g, '')}\n\`\`\`\n\n`,
  );

  // Paragraphs and divs become separated blocks.
  html = blockReplace(html, /<(p|div|section|article|blockquote|table|tr)\b[^>]*>/gi, '\n\n');
  html = blockReplace(html, /<\/(p|div|section|article|blockquote|table|tr)\s*>/gi, '\n\n');
  html = blockReplace(html, /<br\s*\/?\s*>/gi, '\n');
  html = blockReplace(html, /<(td|th)\b[^>]*>/gi, ' | ');

  const text = inlineToMarkdown(html)
    .replaceAll(/[ \t]+\n/g, '\n')
    .replaceAll(/\n{3,}/g, '\n\n')
    .replace(/^\s+/, '')
    .replaceAll(/[ \t]{2,}/g, ' ');
  return text.trim() + (text.length > 0 ? '\n' : '');
}

/** Conservative detection: markup structure, doctype or a charset meta tag. */
export function looksLikeHtml(content: string): boolean {
  const head = content.slice(0, 2000).toLowerCase();
  return (
    head.includes('<!doctype html') ||
    head.includes('<html') ||
    /<body[\s>]/.test(head) ||
    /<(p|div|h1|h2|table|ul)\b[\s>]/.test(head)
  );
}
