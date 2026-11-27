/**
 * Proof-of-work challenge (anti-abuse task 5A, protocol v1).
 *
 * Challenge token: `v1.<base64url(JSON payload)>.<base64url(HMAC-SHA256)>` with
 * payload `{ n, exp, d, ipf }` — a 16-byte-hex nonce, the expiry (ms epoch), the
 * difficulty bound into this token and the requester's ip_hash (empty string when
 * IP_HASH_SALT is unset, mirroring the "unset salt -> skip" semantics of the IP
 * rate limit). The HMAC key is the REPORT_POW_SECRET (32-byte hex); tokens are
 * unforgeable and self-contained, so verification is one hash + a leading-zero-bit
 * count plus a signature check.
 *
 * The puzzle: find an ASCII `solution` with sha256(utf8(n + ':' + solution))
 * starting with >= d zero bits (d=20 ≈ 2^20 hashes ≈ 0.3s single-core Node).
 * Clients solve it once per report; the server recomputes ONE hash to check.
 * Single-use enforcement (challenge_id = sha256 of the full token) lives in the
 * caller (worker.ts step 6.5) on top of the report_pow_used table.
 *
 * Workers runtime: WebCrypto + atob/btoa only — never node:crypto. Tests and
 * core mirror this with node:crypto.
 */

import { sha256Hex } from './dedupe';

export const POW_ALGORITHM = 'sha256' as const;
/** Bytes of randomness in the nonce (rendered as 32 hex chars). */
const NONCE_BYTES = 16;

/** Signed challenge payload (base64url-encoded inside the token). */
export interface ChallengePayload {
  /** 16-byte hex nonce; the puzzle input `sha256(n + ':' + solution)`. */
  n: string;
  /** Expiry, ms epoch (issued at now + REPORT_POW_TTL_MS). */
  exp: number;
  /** Difficulty bound into THIS token; verification uses it, not the live var. */
  d: number;
  /** HMAC(ip) of the requester at issue time; '' when IP_HASH_SALT is unset. */
  ipf: string;
}

/** GET /v1/challenge 200 body (enabled mode, protocol v1 shape). */
export interface IssuedChallenge {
  challenge: string;
  difficulty: number;
  expiresAt: number;
  algorithm: typeof POW_ALGORITHM;
}

/** proof sibling field on the POST body (transport-only, stripped pre-hash). */
export interface ReportProof {
  challenge: string;
  solution: string;
}

export type PowRejection =
  | 'challenge_invalid'
  | 'challenge_expired'
  | 'challenge_ip_mismatch'
  | 'proof_invalid';

export type PowVerification =
  | { ok: true; challengeId: string; payload: ChallengePayload }
  | { ok: false; reason: PowRejection };

// ------------------------------------------------------------------ base64url

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array | null {
  try {
    const normalized = text.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(normalized + '='.repeat((4 - (normalized.length % 4)) % 4));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ crypto

async function hmacRaw(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return new Uint8Array(mac);
}

/** Length-independent comparison; every byte is folded before the result is read. */
function constantTimeEquals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** Leading zero BITS of a digest (the difficulty metric, protocol v1). */
export function leadingZeroBits(digest: Uint8Array): number {
  let bits = 0;
  for (const byte of digest) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    let mask = 0x80;
    while (mask !== 0 && (byte & mask) === 0) {
      bits += 1;
      mask >>= 1;
    }
    break;
  }
  return bits;
}

async function sha256Digest(input: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return new Uint8Array(digest);
}

// ------------------------------------------------------------------ issue

export interface IssueChallengeOptions {
  secret: string;
  difficulty: number;
  ttlMs: number;
  now: number;
  ipf: string;
}

/** Builds and signs a fresh challenge token (`v1.<payload>.<hmac>`). */
export async function issueChallenge(options: IssueChallengeOptions): Promise<IssuedChallenge> {
  const nonceBytes = new Uint8Array(NONCE_BYTES);
  crypto.getRandomValues(nonceBytes);
  let n = '';
  for (const byte of nonceBytes) n += byte.toString(16).padStart(2, '0');
  const payload: ChallengePayload = {
    n,
    exp: options.now + options.ttlMs,
    d: options.difficulty,
    ipf: options.ipf,
  };
  const payloadPart = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const mac = await hmacRaw(options.secret, `v1.${payloadPart}`);
  return {
    challenge: `v1.${payloadPart}.${toBase64Url(mac)}`,
    difficulty: options.difficulty,
    expiresAt: payload.exp,
    algorithm: POW_ALGORITHM,
  };
}

// ------------------------------------------------------------------ verify

export interface VerifyProofOptions {
  secret: string;
  /** Server clock at verification time (ms epoch). */
  now: number;
  /** HMAC(ip) of THIS request ('' when no header / no salt); must equal ipf. */
  ipf: string;
}

/**
 * Signature / format / expiry / ip-binding / difficulty checks — everything that
 * needs no D1 access. Rejections, in protocol order: bad format or HMAC ->
 * `challenge_invalid`; exp in the past -> `challenge_expired`; ipf mismatch ->
 * `challenge_ip_mismatch`; solution below the token's difficulty -> `proof_invalid`.
 */
export async function verifyProof(
  proof: ReportProof,
  options: VerifyProofOptions,
): Promise<PowVerification> {
  const [version, payloadPart, macPart] = proof.challenge.split('.');
  if (version !== 'v1' || payloadPart === undefined || macPart === undefined) return invalid();
  const payload = parsePayload(payloadPart);
  if (payload === null) return invalid();
  const mac = fromBase64Url(macPart);
  if (mac === null) return invalid();
  const expected = await hmacRaw(options.secret, `v1.${payloadPart}`);
  if (!constantTimeEquals(mac, expected)) return invalid();

  if (payload.exp < options.now) return { ok: false, reason: 'challenge_expired' };
  if (payload.ipf !== options.ipf) return { ok: false, reason: 'challenge_ip_mismatch' };

  const digest = await sha256Digest(`${payload.n}:${proof.solution}`);
  if (leadingZeroBits(digest) < payload.d) return { ok: false, reason: 'proof_invalid' };

  // challengeId = sha256 of the full token: the single-use primary key (worker.ts).
  return { ok: true, challengeId: await sha256Hex(proof.challenge), payload };
}

function invalid(): PowVerification {
  return { ok: false, reason: 'challenge_invalid' };
}

function parsePayload(segment: string): ChallengePayload | null {
  const bytes = fromBase64Url(segment);
  if (bytes === null) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as {
      n?: unknown;
      exp?: unknown;
      d?: unknown;
      ipf?: unknown;
    };
    if (
      typeof parsed.n !== 'string' ||
      parsed.n.length === 0 ||
      typeof parsed.exp !== 'number' ||
      !Number.isFinite(parsed.exp) ||
      typeof parsed.d !== 'number' ||
      !Number.isFinite(parsed.d) ||
      parsed.d < 0 ||
      typeof parsed.ipf !== 'string'
    ) {
      return null;
    }
    return { n: parsed.n, exp: parsed.exp, d: parsed.d, ipf: parsed.ipf };
  } catch {
    return null;
  }
}

/** True when the POST body carries a usable proof sibling field. */
export function isUsableProof(value: unknown): value is ReportProof {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { challenge?: unknown }).challenge === 'string' &&
    (value as { challenge: string }).challenge.length > 0 &&
    typeof (value as { solution?: unknown }).solution === 'string'
  );
}
