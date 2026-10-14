import { allowlistPatternRefusal, allowlistProgramKey } from '@kepcup/shared';

/**
 * Programs with a subcommand structure where `<program> <subcommand>` is the
 * natural, specific prefix (`git status`, `pnpm test`, `cargo check`).
 */
const SUBCOMMAND_PROGRAMS = new Set([
  'git', 'npm', 'pnpm', 'yarn', 'bun', 'cargo', 'go', 'make', 'docker', 'kubectl', 'gh',
]);

/**
 * Default command_allowlist pattern when the user picks「加入白名单」on a
 * kind===command card (review P1). Entries match by PREFIX (allowlist-match
 * entryMatches), so a short suggestion silently widens what runs without a
 * card: the default is the FULL first simple command (before | / && / ;),
 * shortened only to `<program> <subcommand>` for subcommand-style tools. When
 * the result is not allowed as an entry at all (`bash -c …`, `curl …`, bare
 * interpreters, `npm run` / `npx` …; shared `allowlistPatternRefusal`) the
 * suggestion is empty and the card shows the reason instead.
 */
export function suggestAllowlistPrefix(command: string): string {
  const trimmed = command.trim();
  if (trimmed.length === 0) return '';

  // Only the first simple command (before | / && / || / ;).
  const firstSegment = trimmed.split(/(?:&&|\|\||[;|])/)[0]?.trim() ?? '';
  if (firstSegment.length === 0) return '';

  const words =
    firstSegment.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((w) => w.replace(/^['"]|['"]$/g, '')) ??
    [];
  const first = words[0];
  if (first === undefined || first.length === 0) return '';
  const second = words[1];

  let suggestion = words.join(' ');
  if (
    SUBCOMMAND_PROGRAMS.has(allowlistProgramKey(first)) &&
    second !== undefined &&
    /^[A-Za-z][\w:-]*$/.test(second) &&
    allowlistPatternRefusal(`${first} ${second}`) === null
  ) {
    suggestion = `${first} ${second}`;
  }
  return allowlistPatternRefusal(suggestion) === null ? suggestion : '';
}

/** Why the first command of `command` cannot become an allowlist entry (null = it can). */
export function allowlistSuggestionRefusal(command: string): string | null {
  const firstSegment = command.trim().split(/(?:&&|\|\||[;|])/)[0]?.trim() ?? '';
  if (firstSegment.length === 0) return null;
  return suggestAllowlistPrefix(command) === '' ? allowlistPatternRefusal(firstSegment) : null;
}
