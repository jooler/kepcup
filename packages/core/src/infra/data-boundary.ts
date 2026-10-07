/**
 * The `<untrusted>` data boundary used across tool results and prompt
 * injections (资料是数据不是指令). Embedded data must not be able to close
 * the boundary itself, so every literal `</untrusted` inside the wrapped text
 * is neutralized (BR-P09-004: a source document containing the closing tag
 * would otherwise escape the boundary and its trailing instructions would
 * read as platform text).
 */
export function neutralizeUntrusted(text: string): string {
  // Opening literals too (security review round 2): a nested `<untrusted>`
  // must not make the reader pair the real closing tag with it.
  return text.replace(/<\/?untrusted/gi, (match) => `<\\${match.slice(1)}`);
}

/** Wraps `text` in the `<untrusted>` boundary (closing literals neutralized). */
export function untrustedBlock(text: string): string {
  return `<untrusted>\n${neutralizeUntrusted(text)}\n</untrusted>`;
}
