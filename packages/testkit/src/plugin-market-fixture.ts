import {
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  type KeyObject,
} from 'node:crypto';
import type { IndexPublicKey, PluginIndexEntry } from '@kepcup/shared';
import type { PluginFixture } from './plugin-fixture.js';

/**
 * Fixtures for the plugin-marketplace tests and the market e2e (D104 P1-1 / P1-3):
 * throwaway Ed25519 keys, signed plugin indexes built over the RAW bytes (the connector
 * script's `buildIndex` is a different envelope), index entries bound to a real `.kepcup`
 * fixture, and an in-memory market server for both the index and the package downloads.
 */

/** Ed25519 SPKI DER prefix (followed by the 32 raw public-key bytes). */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export interface PluginMarketKey {
  keyId: string;
  privateKey: KeyObject;
  publicEntry: IndexPublicKey;
}

/** Throwaway Ed25519 keypair with the public entry an official/custom market needs. */
export function makeMarketKey(keyId = 'market-test'): PluginMarketKey {
  const { privateKey } = generateKeyPairSync('ed25519');
  const der = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  return {
    keyId,
    privateKey,
    publicEntry: {
      keyId,
      publicKey: Buffer.from(der).subarray(ED25519_SPKI_PREFIX.length).toString('base64'),
      validFrom: 0,
      revoked: false,
    },
  };
}

export function buildPluginIndex(input: {
  key: PluginMarketKey;
  generatedAt: number;
  entries: Array<Record<string, unknown>>;
  revoked?: Array<Record<string, unknown>>;
}): { indexBytes: Buffer; sig: string } {
  const index = {
    version: 1,
    generatedAt: input.generatedAt,
    keyId: input.key.keyId,
    entries: input.entries,
    ...(input.revoked !== undefined ? { revoked: input.revoked } : {}),
  };
  const indexBytes = Buffer.from(`${JSON.stringify(index)}\n`);
  return { indexBytes, sig: cryptoSign(null, indexBytes, input.key.privateKey).toString('base64') };
}

/** An index entry bound to a real `.kepcup` fixture: sha256 / size come from the built archive. */
export function pluginIndexEntryFor(
  fixture: PluginFixture,
  extra: {
    tier?: 'verified' | 'community';
    downloadUrl?: string;
    categories?: PluginIndexEntry['categories'];
    /** D105 P4: index-carried capability summary (omitted = old-style entry). */
    capabilitySummary?: string;
    summary?: { name?: string; description?: string; author?: string | null };
  } = {},
): PluginIndexEntry {
  const manifest = fixture.manifest as {
    id: string;
    version: string;
    name?: string;
    description?: string;
    author?: { name?: string } | null;
  };
  const summary: Record<string, unknown> = {
    name: extra.summary?.name ?? String(manifest.name ?? manifest.id),
  };
  if (extra.summary?.description !== undefined || manifest.description !== undefined) {
    summary.description = extra.summary?.description ?? String(manifest.description ?? '');
  }
  if (extra.summary?.author !== undefined || manifest.author !== undefined) {
    summary.author = extra.summary?.author ?? manifest.author?.name ?? null;
  }
  return {
    id: manifest.id,
    version: manifest.version,
    tier: extra.tier ?? 'verified',
    sha256: fixture.sha256,
    size: fixture.size,
    downloadUrl: extra.downloadUrl ?? `https://pkg.test/${fixture.sha256}.kepcup`,
    categories: extra.categories ?? [],
    ...(extra.capabilitySummary !== undefined
      ? { capabilitySummary: extra.capabilitySummary }
      : {}),
    summary: summary as PluginIndexEntry['summary'],
    updatedAt: 0,
  };
}

/** The fetch shape `MarketplaceSync` accepts (kept structural: testkit does not import core). */
export type PluginMarketFetch = (
  input: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<Response>;

/**
 * In-memory market server for both index files and package downloads: returns the bytes
 * registered for a full URL, 404 otherwise. Simplified ETag / 304 support (the index files
 * carry an etag; packages do not need one).
 */
export function memoryMarketFetch(files: Map<string, Buffer>): {
  fetch: PluginMarketFetch;
  requests: string[];
  publish(url: string, bytes: Buffer): void;
} {
  const requests: string[] = [];
  let version = 0;
  const etags = new Map<string, string>();
  const fetch: PluginMarketFetch = async (input, init) => {
    requests.push(input);
    const file = files.get(input);
    if (file === undefined) return new Response('not found', { status: 404 });
    const etag = etags.get(input) ?? `"v${++version}"`;
    etags.set(input, etag);
    const ifNoneMatch = init?.headers?.['if-none-match'] ?? null;
    if (ifNoneMatch !== null && ifNoneMatch === etag) {
      return new Response(null, { status: 304, headers: { etag } });
    }
    return new Response(new Uint8Array(file), { status: 200, headers: { etag } });
  };
  return {
    fetch,
    requests,
    publish(url: string, bytes: Buffer): void {
      files.set(url, bytes);
    },
  };
}
