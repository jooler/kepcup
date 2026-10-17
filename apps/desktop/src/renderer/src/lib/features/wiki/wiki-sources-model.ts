import { WIKI_TEXT_SOURCE_MAX_CHARS } from '@kepcup/shared';

/**
 * 项目 Wiki 来源面板的纯逻辑（D92 T1b WP10 §4 步骤 5）：行排序、删除中
 * 状态机（wiki_changed 确认 / 30 秒超时还原）、表单校验（网址 http(s)、
 * 文本 trim 非空且 ≤ WIKI_TEXT_SOURCE_MAX_CHARS）与体积格式化。
 */

/** One row of the sources list (the RPC view flattened for rendering). */
export interface WikiSourceRow {
  id: string;
  fileName: string;
  bytes: number;
  createdAt: number;
  creator: { kind: 'user' } | { kind: 'bot'; id: string; name: string | null };
}

/** A deletion in flight: the row shows 「删除中…」 until confirmed or timed out. */
export interface PendingWikiSourceDelete {
  id: string;
  startedAt: number;
}

/** The deletion state machine's transition result. */
export interface WikiSourceDeleteStep {
  pending: PendingWikiSourceDelete | null;
  /** Set once per transition: confirmed (row gone), timeout (restored) or null. */
  outcome: 'confirmed' | 'timeout' | null;
}

/** Sources list order: newest submission first, id as the tiebreaker. */
export function sortSourceRows(rows: readonly WikiSourceRow[]): WikiSourceRow[] {
  return [...rows].sort(
    (a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/**
 * One step of the deletion state machine.
 * - `begin` starts a pending deletion (a second click is ignored — same id).
 * - `reloaded` folds in a fresh sources list: the source disappearing confirms
 *   the deletion (pending clears); a still-present row keeps waiting.
 * - `timeout` checks the 30-second deadline of the pending deletion.
 */
export function stepSourceDelete(
  pending: PendingWikiSourceDelete | null,
  event:
    | { type: 'begin'; id: string; now: number }
    | { type: 'reloaded'; presentIds: readonly string[]; now: number }
    | { type: 'timeout'; now: number },
): WikiSourceDeleteStep {
  if (event.type === 'begin') {
    if (pending !== null) return { pending, outcome: null };
    return { pending: { id: event.id, startedAt: event.now }, outcome: null };
  }
  if (pending === null) return { pending: null, outcome: null };
  if (event.type === 'reloaded') {
    if (!event.presentIds.includes(pending.id)) {
      return { pending: null, outcome: 'confirmed' };
    }
    return { pending, outcome: null };
  }
  if (event.now - pending.startedAt >= WIKI_SOURCE_DELETE_TIMEOUT_MS) {
    return { pending: null, outcome: 'timeout' };
  }
  return { pending, outcome: null };
}

/** How long a deleting row waits for its wiki_changed before restoring (WP10). */
export const WIKI_SOURCE_DELETE_TIMEOUT_MS = 30_000;

/** The add-source URL field: a parseable http(s) URL. */
export function isValidSourceUrl(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** The add-source text field: non-blank and within the paste cap. */
export function isValidSourceText(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= WIKI_TEXT_SOURCE_MAX_CHARS;
}

/** Human-readable size for one row (KB / MB, one decimal below 10). */
export function formatSourceBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}
