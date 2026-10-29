import {
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  type KeyObject,
} from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IndexPublicKey } from '@kepcup/shared';
import type { IndexFetch } from '../../src/infra/signed-index.js';

/**
 * Fixtures for the generic signed-index tests: throwaway Ed25519 keys, signed indexes
 * (detached Ed25519 signature over the EXACT index bytes — same scheme as the marketplace
 * publishing script), and an in-memory index server with ETag support and failure injection.
 */

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function rawPublicKeyBase64(key: KeyObject): string {
  const der = createPublicKey(key).export({ format: 'der', type: 'spki' });
  return Buffer.from(der).subarray(SPKI_PREFIX.length).toString('base64');
}

export interface TestKey {
  keyId: string;
  privateKey: KeyObject;
  publicEntry: IndexPublicKey;
}

export function makeKey(keyId = 'test-1', overrides: Partial<IndexPublicKey> = {}): TestKey {
  const { privateKey } = generateKeyPairSync('ed25519');
  return {
    keyId,
    privateKey,
    publicEntry: {
      keyId,
      publicKey: rawPublicKeyBase64(privateKey),
      validFrom: 0,
      revoked: false,
      ...overrides,
    },
  };
}

export interface SignedIndex {
  indexBytes: Buffer;
  sig: string;
  files: Map<string, Buffer>;
  index: Record<string, unknown>;
}

export function signIndex(input: {
  entries: unknown[];
  key: TestKey;
  generatedAt: number;
  keyIdOverride?: string;
}): SignedIndex {
  const index = {
    version: 1,
    generatedAt: input.generatedAt,
    keyId: input.keyIdOverride ?? input.key.keyId,
    entries: input.entries,
  };
  const indexBytes = Buffer.from(JSON.stringify(index), 'utf8');
  const signature = cryptoSign(null, indexBytes, input.key.privateKey);
  const sig = Buffer.from(signature).toString('base64');
  const files = new Map<string, Buffer>([
    ['index.json', indexBytes],
    ['index.json.sig', Buffer.from(`${sig}\n`)],
  ]);
  return { index, indexBytes, files, sig };
}

/** In-memory signed index server with ETag support and failure injection. */
export class FakeDirectory {
  readonly requests: Array<{ path: string; ifNoneMatch: string | null }> = [];
  offline = false;
  status: number | null = null;
  #files = new Map<string, { bytes: Buffer; etag: string }>();
  #version = 0;

  publish(signed: { indexBytes: Buffer; sig: string }): void {
    this.#version += 1;
    this.#files.set('index.json', { bytes: signed.indexBytes, etag: `"v${this.#version}"` });
    this.#files.set('index.json.sig', {
      bytes: Buffer.from(`${signed.sig}\n`),
      etag: `"s${this.#version}"`,
    });
  }

  /** Replace a served file's bytes without touching the rest (tampering). */
  tamper(name: 'index.json' | 'index.json.sig', bytes: Buffer): void {
    this.#files.set(name, { bytes, etag: `"t${++this.#version}"` });
  }

  readonly fetch: IndexFetch = async (input, init) => {
    const url = new URL(input);
    const name = url.pathname.replace(/^.*\/v1\//, '');
    const ifNoneMatch = init?.headers?.['if-none-match'] ?? null;
    this.requests.push({ path: name, ifNoneMatch });
    if (this.offline) throw new TypeError('fetch failed');
    if (this.status !== null) return new Response('boom', { status: this.status });
    const file = this.#files.get(name);
    if (file === undefined) return new Response('not found', { status: 404 });
    if (ifNoneMatch !== null && ifNoneMatch === file.etag) {
      return new Response(null, { status: 304, headers: { etag: file.etag } });
    }
    return new Response(new Uint8Array(file.bytes), { status: 200, headers: { etag: file.etag } });
  };
}

/** Keep the path helper referenced (the repo-root fixture path may be useful in tests). */
export const fixtureDir = path.dirname(fileURLToPath(import.meta.url));
