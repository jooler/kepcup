import { allowlistPatternRefusal } from '@kepcup/shared';

/**
 * Default command_allowlist pattern when the user picks「加入白名单」on a
 * kind===command card (review P1-2). Entries match by PREFIX (allowlist-match
 * entryMatches): an entry exempts itself plus any arguments appended to it, so
 * the suggestion is never shorter than what the user is looking at — it is the
 * FULL first simple command (before | / && / ;). When that command is not
 * allowed as an entry at all (shared `allowlistPatternRefusal`: `bash -c …`,
 * `curl …`, `docker run …`, `make …`, bare interpreters, `npm run` / `npx` …)
 * the suggestion is empty and the card shows the reason instead.
 */
export function suggestAllowlistPrefix(command: string): string {
  const firstSegment = command.trim().split(/(?:&&|\|\||[;|])/)[0]?.trim() ?? '';
  if (firstSegment.length === 0) return '';
  const words =
    firstSegment.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((w) => w.replace(/^['"]|['"]$/g, '')) ??
    [];
  const suggestion = words.join(' ');
  if (suggestion.length === 0) return '';
  return allowlistPatternRefusal(suggestion) === null ? suggestion : '';
}

/** Why the first command of `command` cannot become an allowlist entry (null = it can). */
export function allowlistSuggestionRefusal(command: string): string | null {
  const firstSegment = command.trim().split(/(?:&&|\|\||[;|])/)[0]?.trim() ?? '';
  if (firstSegment.length === 0) return null;
  return suggestAllowlistPrefix(command) === '' ? allowlistPatternRefusal(firstSegment) : null;
}
