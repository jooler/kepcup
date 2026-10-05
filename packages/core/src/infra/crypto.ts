import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

export const MASTER_KEY_BYTES = 32;
const AES_KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** Fixed application salt: derivations must be stable across machines and runs. */
const HKDF_SALT = 'kepcup/hkdf/v1';

export interface KeyInfo {
  /** HKDF info parameter; separate databases and purposes must use distinct infos. */
  info: string;
}

export const KEY_INFO = {
  mainDb: 'db:main',
  runsDb: 'db:runs',
  secrets: 'secrets:v1',
} as const;

/** Per-bot memory database info: `db:memory:<botId>` (docs/dev/03-data-model.md). */
export function memoryDbKeyInfo(botId: string): string {
  return `db:memory:${botId}`;
}

export function generateMasterKey(): Buffer {
  return randomBytes(MASTER_KEY_BYTES);
}

/** Derive a purpose-specific 32-byte key from the master key (HKDF-SHA256). */
export function deriveKey(masterKey: Uint8Array, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', masterKey, HKDF_SALT, info, AES_KEY_BYTES));
}

/**
 * AES-256-GCM. Output layout: iv(12) || authTag(16) || ciphertext.
 * `aad` binds the ciphertext to a context (e.g. a row id) and must be passed
 * unchanged to `open`.
 */
export function seal(
  key: Uint8Array,
  plaintext: Uint8Array | string,
  aad: Uint8Array | string,
): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(toBuffer(aad));
  const ciphertext = Buffer.concat([cipher.update(toBuffer(plaintext)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

export function open(key: Uint8Array, sealed: Uint8Array, aad: Uint8Array | string): Buffer {
  if (sealed.length < IV_BYTES + TAG_BYTES) {
    throw new Error('sealed payload is truncated');
  }
  const iv = sealed.subarray(0, IV_BYTES);
  const tag = sealed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = sealed.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(toBuffer(aad));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function toBuffer(value: Uint8Array | string): Buffer {
  return typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
}
