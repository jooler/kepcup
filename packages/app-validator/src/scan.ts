/**
 * Tool-description injection scan (design 29 §8.3 / §11.5 step 4): heuristics for text that tries to
 * steer the model instead of describing the tool. Findings are warnings for the developer; the
 * review pipeline and the client apply their own (stricter) policy.
 */

export type ScanKind =
  | 'override-instructions'
  | 'hidden-characters'
  | 'closing-tag'
  | 'exfiltration'
  | 'sensitive-path'
  | 'url';

export interface ScanFinding {
  kind: ScanKind;
  /** Short excerpt of the offending text (control characters rendered as \uXXXX). */
  excerpt: string;
}

/**
 * Zero-width, bidi-control, invisible-formatting, blank-filler and Unicode tag characters
 * (U+200B/200E/200F, bidi U+202A-202E / U+2066-206F, U+2060-2064, U+FEFF, U+00AD, U+180E, U+061C,
 * U+3164, U+2800, U+115F/1160, tags U+E0000-E007F). ZWNJ / ZWJ (U+200C, U+200D) and VS16 (U+FE0F)
 * are *not* flagged on their own (emoji and many scripts need them); ZWNJ / ZWJ between two ASCII
 * letters is ({@link MIDWORD_JOINER}).
 */
const HIDDEN_CHARS =
  /[\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\u00AD\u180E\u061C\u3164\u2800\u115F\u1160\u{E0000}-\u{E007F}]/gu;
/** A joiner inside an ASCII word ("ig\u200Dnore"): invisible mid-word insertion that defeats keyword matching. */
const MIDWORD_JOINER = /(?<=[A-Za-z])[\u200C\u200D](?=[A-Za-z])/u;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

const OVERRIDE_PATTERNS: RegExp[] = [
  /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|all|any|system|other)\b[^.\n]{0,30}\b(?:instructions?|prompts?|rules?|messages?|context)\b/i,
  /\bdo not (?:tell|inform|mention|reveal|show|let)\b[^.\n]{0,40}\b(?:user|human|operator)\b/i,
  /\bwithout (?:telling|informing|notifying|asking)\b[^.\n]{0,20}\b(?:the )?(?:user|human)\b/i,
  /\b(?:you must|you should|always|first)\b[^.\n]{0,30}\b(?:call|invoke|use|run|execute)\b[^.\n]{0,30}\b(?:this|the following|another|other)\b[^.\n]{0,15}\btool\b/i,
  /\b(?:new|updated|real) (?:instructions?|system prompt)\b/i,
  /\bact as\b[^.\n]{0,30}\b(?:system|developer|administrator|root)\b/i,
];

const CLOSING_TAG_PATTERNS: RegExp[] = [
  /<\/?\s*untrusted[^>]*>/i,
  /<\/?\s*(?:system|assistant|important|instructions?|tool_?(?:call|result|use)|function_?calls?|function_?results?)\b[^>]*>/i,
  /\[\/?(?:INST|SYS|SYSTEM)\]/i,
  /<\|(?:im_start|im_end|system|endoftext)\|>/i,
];

const EXFIL_PATTERNS: RegExp[] = [
  /\b(?:send|post|upload|forward|transmit|exfiltrate|leak|email|include)\b[^.\n]{0,60}\b(?:to|at|in|into|via)\b[^.\n]{0,30}(?:https?:\/\/|\bwebhook\b|\bremote server\b)/i,
  /\b(?:curl|wget|nc|netcat)\b\s+\S+/i,
  /\b(?:api[_ -]?keys?|passwords?|secrets?|tokens?|credentials?|private keys?|cookies?)\b[^.\n]{0,40}\b(?:send|include|append|attach|pass|forward|exfiltrate|leak|post|upload)\b/i,
  /!\[[^\]]*\]\(https?:\/\/[^)]*\{[^)]*\}[^)]*\)/,
];

const SENSITIVE_PATH_PATTERNS: RegExp[] = [
  /~\/\.(?:ssh|aws|gnupg|config|kube)\b/i,
  /\bid_(?:rsa|ed25519|ecdsa)\b/i,
  /(?:^|[\s"'`(])\.env\b/i,
  /\/etc\/(?:passwd|shadow)\b/i,
  /\bcredentials\.json\b/i,
];

const URL_PATTERN = /\bhttps?:\/\/[^\s)"'<>]+/gi;

function render(text: string): string {
  return text
    .replace(
      HIDDEN_CHARS,
      (ch) => `\\u{${(ch.codePointAt(0) as number).toString(16).toUpperCase()}}`,
    )
    .replace(
      CONTROL_CHARS,
      (ch) => `\\u${(ch.codePointAt(0) as number).toString(16).padStart(4, '0')}`,
    );
}

function excerptOf(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 10);
  const end = Math.min(text.length, index + length + 20);
  const slice = render(text.slice(start, end)).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${slice}${end < text.length ? '…' : ''}`;
}

function matchAll(kind: ScanKind, patterns: RegExp[], text: string, out: ScanFinding[]): void {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match !== null) out.push({ kind, excerpt: excerptOf(text, match.index, match[0].length) });
  }
}

/** Scan one piece of tool-facing text (name, title, description, schema descriptions). */
export function scanText(rawText: string): ScanFinding[] {
  const findings: ScanFinding[] = [];
  HIDDEN_CHARS.lastIndex = 0;
  const hidden = HIDDEN_CHARS.exec(rawText);
  const joiner = MIDWORD_JOINER.exec(rawText);
  if (hidden !== null) {
    findings.push({
      kind: 'hidden-characters',
      excerpt: excerptOf(rawText, hidden.index, hidden[0].length),
    });
  } else if (joiner !== null) {
    findings.push({ kind: 'hidden-characters', excerpt: excerptOf(rawText, joiner.index, 1) });
  } else {
    const control = new RegExp(CONTROL_CHARS.source).exec(rawText);
    if (control !== null) {
      findings.push({ kind: 'hidden-characters', excerpt: excerptOf(rawText, control.index, 1) });
    }
  }
  // Match the patterns on a canonical form: NFKC folds fullwidth / compatibility letters
  // ("ｉｇｎｏｒｅ") to ASCII, and stripping the invisible characters undoes mid-word insertion.
  const text = rawText
    .normalize('NFKC')
    .replace(HIDDEN_CHARS, '')
    .replace(/[\u200C\u200D]/g, '');
  matchAll('override-instructions', OVERRIDE_PATTERNS, text, findings);
  matchAll('closing-tag', CLOSING_TAG_PATTERNS, text, findings);
  matchAll('exfiltration', EXFIL_PATTERNS, text, findings);
  matchAll('sensitive-path', SENSITIVE_PATH_PATTERNS, text, findings);
  const urls = text.match(URL_PATTERN);
  if (urls !== null) {
    findings.push({ kind: 'url', excerpt: urls.slice(0, 3).map(render).join(' ') });
  }
  return findings;
}

/** Collect every human-readable string of a JSON Schema (property descriptions, titles, enum labels). */
export function schemaTexts(schema: unknown, limit = 200): string[] {
  const out: string[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (out.length >= limit || depth > 12) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if ((key === 'description' || key === 'title') && typeof item === 'string') out.push(item);
      else visit(item, depth + 1);
    }
  };
  visit(schema, 0);
  return out;
}
