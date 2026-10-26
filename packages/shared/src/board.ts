import { TODO_TITLE_MAX_CHARS } from './constants.js';

const ELLIPSIS = '…';

/**
 * First-line title cached on a board card's todo (docs/design/50-project-board.md §5.2).
 * The first non-empty line (CRLF, CR, or LF), with internal whitespace collapsed to a
 * single space. Longer than {@link TODO_TITLE_MAX_CHARS} code points → the first
 * `max - 1` code points plus an ellipsis (surrogate pairs stay intact). Blank → `''`;
 * the caller rejects empty card text.
 */
export function deriveCardTitle(text: string): string {
  const line = text
    .split(/\r\n|\n|\r/)
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  if (line === undefined) return '';
  const collapsed = line.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return '';
  const points = Array.from(collapsed);
  if (points.length <= TODO_TITLE_MAX_CHARS) return collapsed;
  return `${points.slice(0, TODO_TITLE_MAX_CHARS - 1).join('')}${ELLIPSIS}`;
}
