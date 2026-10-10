import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ConnectorIndexPublicKey } from '@kepcup/shared';
import type { DirectoryFetch } from '../../src/apps/directory-sync.js';

/**
 * Fixtures for the signed directory tests (D73 P3 §7.1): throwaway Ed25519 keys, signed
 * indexes built with the REAL signing script's functions, and an in-memory directory server.
 */

interface SignScript {
  buildIndex(input: {
    entries: unknown[];
    keyId: string;
    generatedAt: number;
    previous?: unknown;
  }): { index: Record<string, unknown>; indexBytes: Buffer; files: Map<string, Buffer> };
  signBytes(bytes: Uint8Array, key: KeyObject): string;
  rawPublicKeyBase64(key: KeyObject): string;
  entriesHash(entries: unknown[]): string;
  canonicalEntriesJson(entries: unknown[]): string;
  stableStringify(value: unknown): string;
  verifyIndexBytes(
    bytes: Uint8Array,
    sig: string,
    keys: unknown[],
    options?: { readFile?: (rel: string) => Buffer },
  ): { ok: boolean; reason?: string };
}

const here = path.dirname(fileURLToPath(import.meta.url));
export const SIGN_SCRIPT_PATH = path.resolve(here, '../../../../scripts/sign-connector-index.mjs');
export const signScript = (await import(
  /* @vite-ignore */ pathToFileURL(SIGN_SCRIPT_PATH).href
)) as SignScript;

export interface TestKey {
  keyId: string;
  privateKey: KeyObject;
  publicEntry: ConnectorIndexPublicKey;
}

export function makeKey(
  keyId = 'test-1',
  overrides: Partial<ConnectorIndexPublicKey> = {},
): TestKey {
  const { privateKey } = generateKeyPairSync('ed25519');
  return {
    keyId,
    privateKey,
    publicEntry: {
      keyId,
      publicKey: signScript.rawPublicKeyBase64(privateKey),
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
  previous?: unknown;
}): SignedIndex {
  const { index, indexBytes, files } = signScript.buildIndex({
    entries: input.entries,
    keyId: input.keyIdOverride ?? input.key.keyId,
    generatedAt: input.generatedAt,
    ...(input.previous !== undefined ? { previous: input.previous } : {}),
  });
  return { index, indexBytes, files, sig: signScript.signBytes(indexBytes, input.key.privateKey) };
}

/** In-memory `dl.kepcup.com/connectors/v1/` with ETag support and failure injection. */
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

  readonly fetch: DirectoryFetch = async (input, init) => {
    const url = new URL(input);
    const name = url.pathname.replace(/^.*\/connectors\/v1\//, '');
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
