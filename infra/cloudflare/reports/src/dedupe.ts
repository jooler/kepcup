/**
 * canonical JSON + content/payload hash (todo/ai-content-reporting.md §5.4).
 *
 * The Worker recomputes both hashes over the received payload and rejects the
 * request when they disagree with `hashes` — a client cannot just send hashes and
 * be believed. This is the Workers-side implementation (WebCrypto only, no
 * node:crypto); core has its own node:crypto twin in packages/core. The two MUST
 * stay byte-identical; they are pinned together by the fixed vectors in
 * packages/shared/test/fixtures/report-v1.json (asserted in test/dedupe.test.ts
 * and test/contract.test.ts — never change one side alone).
 */

import type { ReportMessage, ReportPayload } from './types';

/** Guard against pathological nesting: real payloads are ≤ ~6 levels deep. */
const MAX_DEPTH = 64;

/**
 * Deterministic JSON: object keys sorted lexicographically (default string
 * comparison, i.e. UTF-16 code units), array order preserved, everything else
 * exactly `JSON.stringify` semantics — including its edge cases (undefined-valued
 * object keys are omitted, undefined array elements become `null`, numbers use
 * the ECMAScript Number::toString formatting). Both runtimes are V8, so number
 * formatting is bit-identical across Node (core) and Workers (here).
 */
export function canonicalJson(value: unknown): string {
  return canonicalValue(value, 0);
}

function canonicalValue(value: unknown, depth: number): string {
  if (depth > MAX_DEPTH) throw new RangeError('canonicalJson: payload nesting too deep');
  switch (typeof value) {
    case 'undefined':
      // Array-element semantics; undefined-valued object keys are dropped by the caller.
      return 'null';
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (value === null) return 'null';
      if (Array.isArray(value)) {
        const items = value.map((item) => canonicalValue(item, depth + 1));
        return `[${items.join(',')}]`;
      }
      const entries = (Object.entries(value) as [string, unknown][]).filter(
        ([, v]) => v !== undefined,
      );
      entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      const parts = entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalValue(v, depth + 1)}`);
      return `{${parts.join(',')}}`;
    }
    default:
      // symbol / function: not JSON-serializable; JSON.stringify renders them as
      // undefined, which collapses to the array semantics here.
      return 'null';
  }
}

/** sha256 of the UTF-8 encoding, lowercase hex (Workers: WebCrypto, never node:crypto). */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  let hex = '';
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/**
 * The bytes the content hash is taken over (§5.4): the message text itself for
 * text messages, the canonical card JSON otherwise (an empty card text falls back
 * to `{text}` so a content-less card still hashes to something stable).
 */
export function contentSource(message: ReportMessage): string {
  if (message.kind === 'text') return message.text;
  const content = (message.content ?? { text: message.text }) as unknown;
  return canonicalJson(content);
}

export async function computeContentHash(message: ReportMessage): Promise<string> {
  return sha256Hex(contentSource(message));
}

/**
 * Payload minus the transport-only fields (§5.4) — what the payload hash covers.
 * `proof` (PoW, task 5A) is transport-only too: it never enters the hash, and the
 * shared reportPayloadSchema deliberately does not know about it.
 */
export type DedupePayload = Omit<ReportPayload, 'reportId' | 'createdAt' | 'hashes' | 'proof'>;

export function dedupePayload(payload: ReportPayload): DedupePayload {
  const {
    reportId: _reportId,
    createdAt: _createdAt,
    hashes: _hashes,
    proof: _proof,
    ...rest
  } = payload;
  return rest;
}

export async function computePayloadHash(payload: ReportPayload): Promise<string> {
  return sha256Hex(canonicalJson(dedupePayload(payload)));
}

/**
 * Dedupe window as a time bucket (§5.5): `floor(now / window)`. A window of 0
 * means permanent dedupe (bucket is always 0). Computed from the SERVER clock
 * only — the bucket never enters a hash, so client/server clock skew cannot
 * break hash verification.
 */
export function bucketOf(nowMs: number, windowMs: number): number {
  if (windowMs <= 0) return 0;
  return Math.floor(nowMs / windowMs);
}

/** UTC calendar day of a ms epoch as 'YYYY-MM-DD' (report_daily primary key; lexical = chronological). */
export function utcDayOf(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}
