import type { Check } from './types.js';

/**
 * Report hygiene: URLs in a report keep origin + path only. Query strings (signed URLs, tokens) and
 * credentials (`https://user:pass@host/`) never reach stdout, `--json` output or CI logs.
 */

/** `https://u:p@host/a?b=c#d` -> `https://host/a`; anything that is not an http(s) URL is returned unchanged. */
export function redactUrl(raw: string): string {
  if (!/^https?:\/\//i.test(raw)) return raw;
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`;
  } catch {
    return raw.replace(/^(https?:\/\/)[^/@\s]*@/i, '$1').replace(/[?#].*$/, '');
  }
}

const URL_IN_TEXT = /https?:\/\/[^\s"'<>)\]]+/gi;

/** Redact every http(s) URL found in free text. */
export function redactText(text: string): string {
  return text.replace(URL_IN_TEXT, (match) => {
    // Keep trailing sentence punctuation outside the URL.
    const trailing = /[.,;:!]+$/.exec(match)?.[0] ?? '';
    const core = trailing === '' ? match : match.slice(0, -trailing.length);
    return `${redactUrl(core)}${trailing}`;
  });
}

function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item)]));
  }
  return value;
}

export function redactCheck(check: Check): Check {
  return {
    ...check,
    message: redactText(check.message),
    ...(check.hint !== undefined ? { hint: redactText(check.hint) } : {}),
    ...(check.subject !== undefined ? { subject: redactText(check.subject) } : {}),
    ...(check.details !== undefined ? { details: redactValue(check.details) } : {}),
  };
}
