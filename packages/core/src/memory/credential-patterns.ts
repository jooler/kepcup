/**
 * Credential detection (docs/dev/phases/P07-memory.md 写入校验): content
 * matching any pattern is never written to memory, and reflection warns the
 * user once per message. Fail-closed: patterns are generous, so borderline
 * text (e.g. the word "password" not followed by a value) must NOT match.
 */

interface PatternRule {
  /** Source description for logs/tests. */
  name: string;
  regex: RegExp;
}

const API_KEY_PREFIXES = [
  'sk-[A-Za-z0-9_-]{16,}',
  'sk-proj-[A-Za-z0-9_-]{16,}',
  'ghp_[A-Za-z0-9]{20,}',
  'gho_[A-Za-z0-9]{20,}',
  'github_pat_[A-Za-z0-9_]{20,}',
  'glpat-[A-Za-z0-9_-]{16,}',
  'xox[baprs]-[A-Za-z0-9-]{10,}',
  'AKIA[0-9A-Z]{16}',
  'AIza[0-9A-Za-z_-]{30,}',
  'ya29\\.[0-9A-Za-z_-]{20,}',
  'eyJ[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}', // JWT
  'SG\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}',
  'hf_[A-Za-z0-9]{30,}',
];

const PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]{0,4000}?-----END [A-Z ]*PRIVATE KEY-----/;

/**
 * `password`/`密码`/`token`/`密钥` followed by a connector and a value run.
 * English keywords accept whitespace as the connector; Chinese keywords accept
 * 是/为/：/:/=. The value must contain a latin letter or digit — pure-CJK runs
 * after 密码是 are prose ("密码是必要的"), not credentials.
 */
const KEYWORD_VALUE =
  /(?:password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key)\s*[:：=]\s*['"]?([^\s'"，。；,;]{4,})['"]?|(?:密码|口令|密钥|令牌|访问令牌)(?:是|为|[:：=])\s*['"]?([^\s'"，。；,;]*[A-Za-z0-9][^\s'"，。；,;]*)['"]?/i;

export const CREDENTIAL_PATTERNS: readonly PatternRule[] = [
  ...API_KEY_PREFIXES.map((body) => ({ name: 'api_key_prefix', regex: new RegExp(body) })),
  { name: 'private_key_block', regex: PRIVATE_KEY_BLOCK },
  { name: 'keyword_value_pair', regex: KEYWORD_VALUE },
];

/** True when the text looks like it contains a credential (never stored). */
export function containsCredential(text: string): boolean {
  if (text.length === 0) return false;
  return CREDENTIAL_PATTERNS.some((rule) => rule.regex.test(text));
}
