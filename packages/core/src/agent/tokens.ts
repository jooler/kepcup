/**
 * Approximate token estimation for budget control (docs/dev/04-agent-runtime.md
 * "token 估算"): CJK characters count as one token, other text as one token
 * per four characters. Billing always uses the model-returned usage instead.
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    if (isCjk(char)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

function isCjk(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return (
    (code >= 0x4e00 && code <= 0x9fff) || // CJK unified ideographs
    (code >= 0x3400 && code <= 0x4dbf) || // extension A
    (code >= 0x3040 && code <= 0x30ff) || // hiragana / katakana
    (code >= 0xac00 && code <= 0xd7af) || // hangul syllables
    (code >= 0xf900 && code <= 0xfaff) // compatibility ideographs
  );
}

/** Cuts text to roughly `budget` tokens, marking the truncation. */
export function truncateToBudget(text: string, budget: number): { text: string; truncated: boolean } {
  const total = estimateTokens(text);
  if (total <= budget) return { text, truncated: false };
  // Estimate the character cut from the token ratio, then trim to a boundary.
  const ratio = budget / total;
  let cut = Math.max(0, Math.floor(text.length * ratio));
  // Walk back to a whitespace boundary to avoid splitting surrogate pairs mid-way.
  while (cut > 0 && /[\p{L}\p{N}]/u.test(text[cut - 1] ?? '') && !/\s/.test(text[cut] ?? '')) {
    cut -= 1;
    if (text.length - cut < text.length * 0.5) break;
  }
  return { text: `${text.slice(0, cut)}\n[已截断]`, truncated: true };
}
