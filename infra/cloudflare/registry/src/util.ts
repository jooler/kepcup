import {
  CONNECTOR_META_KEY,
  OFFICIAL_META_KEY,
  PUBLISHER_META_KEY,
  REVIEW_META_KEY,
} from './types';

const encoder = new TextEncoder();

export function utf8Length(value: string): number {
  return encoder.encode(value).length;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  let hex = '';
  for (const b of new Uint8Array(digest)) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/** `YYYY-MM-DDTHH:MM:SS.sssZ`, the only timestamp format stored in D1. */
export function toIso(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** ASCII-only lowercase: matches what SQLite's `lower()` does, so JS and SQL agree. */
export function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** Fields of `app.kepcup/connector` that only this registry may set (from `reviews`). */
const OWNED_CONNECTOR_FIELDS = ['tier', 'status', 'reviewedAt', 'toolContractHash'] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Removes everything in a publisher-supplied `server.json._meta` that the registry
 * itself owns, in `_meta` AND in its `publisher-provided` child:
 *  - `app.kepcup/review` (entirely);
 *  - `tier` / `status` / `reviewedAt` / `toolContractHash` inside `app.kepcup/connector`
 *    (slug, category, auth, ... stay: they are publisher data);
 *  - `io.modelcontextprotocol.registry/official` (impersonating the registry-managed block).
 * Applied before storing (sync) and again when serving (defence in depth: rows written
 * by an older revision or by hand).
 */
export function sanitizeServerMeta(server: Record<string, unknown>): void {
  const meta = server._meta;
  if (!isPlainObject(meta)) return;
  const publisher = meta[PUBLISHER_META_KEY];
  for (const holder of [meta, publisher]) {
    if (!isPlainObject(holder)) continue;
    delete holder[REVIEW_META_KEY];
    delete holder[OFFICIAL_META_KEY];
    const connector = holder[CONNECTOR_META_KEY];
    if (connector === undefined) continue;
    if (isPlainObject(connector)) {
      for (const field of OWNED_CONNECTOR_FIELDS) delete connector[field];
    } else {
      delete holder[CONNECTOR_META_KEY];
    }
  }
}
