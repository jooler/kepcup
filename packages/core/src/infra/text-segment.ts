/**
 * Chinese-aware segmentation for FTS5 (docs/dev/03-data-model.md
 * "全文检索与中文"). SQLite's unicode61 tokenizer does not split CJK text, so
 * every FTS write and query must go through this module.
 */
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });

/** Splits text into space-separated words suitable for the unicode61 tokenizer. */
export function segmentForFts(text: string): string {
  if (text.length === 0) return '';
  const parts: string[] = [];
  for (const { segment, isWordLike } of segmenter.segment(text)) {
    if (isWordLike !== true) continue;
    parts.push(segment);
  }
  return parts.join(' ');
}

/**
 * Builds an FTS5 MATCH query from user input. Words are ANDed and quoted so
 * that input cannot inject FTS query syntax.
 */
export function buildFtsQuery(text: string): string | null {
  const words = segmentForFts(text)
    .split(' ')
    .map((w) => w.trim())
    .filter((w) => w.length > 0)
    .map((w) => `"${w.replaceAll('"', '""')}"`);
  if (words.length === 0) return null;
  return words.join(' AND ');
}

/**
 * OR-composed MATCH query ranked by bm25, used by memory/profile retrieval
 * (P07). Chinese queries segment differently from the stored text (e.g. query
 * 「在优化什么」 vs stored 「正在」+「优」+「化」), which makes AND composition
 * miss almost everything — the 50-sample recall check measured AND 9/50 vs OR
 * 38/50 top-1 (docs/dev/PROGRESS.md P07). bm25's rank favors documents that
 * match more query words, which restores precision.
 */
export function buildFtsOrQuery(text: string): string | null {
  const words = [...new Set(segmentForFts(text).split(' '))]
    .map((w) => w.trim())
    .filter((w) => w.length > 0)
    .map((w) => `"${w.replaceAll('"', '""')}"`);
  if (words.length === 0) return null;
  return words.join(' OR ');
}
