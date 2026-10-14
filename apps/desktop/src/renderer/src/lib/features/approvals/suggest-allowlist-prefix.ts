/**
 * Default command_allowlist pattern when the user picks「加入白名单」on a
 * kind===command card. Prefix match (allowlist-match entryMatches): first
 * 1–2 words of the first simple segment, editable before add.
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
  if (words.length === 0) return '';

  const first = words[0];
  const second = words[1];
  if (first === undefined || first.length === 0) return '';
  if (second === undefined || second.length === 0) return first;

  // Flag → program only (ls -la → ls).
  if (second.startsWith('-')) return first;
  // Path-like → program only (cat ./a.ts → cat).
  if (/[\\/]/.test(second) || second.includes('.') || second.startsWith('~')) return first;

  // Subcommand-style (git status, pnpm test, npm run).
  return `${first} ${second}`;
}
