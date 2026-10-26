import { sign as cryptoSign, type KeyObject } from 'node:crypto';
import type { ConnectorIndexPublicKey, PluginIndexEntry } from '@kepcup/shared';
import type { PluginFixture } from '@kepcup/testkit';
import type { DirectoryFetch } from '../../src/apps/directory-sync.js';
import { makeKey, type TestKey } from './directory-fixture.js';

export { makeKey, type TestKey };

/**
 * Fixtures for the plugin-marketplace tests (D104 P1-1 步骤 6): throwaway Ed25519 keys,
 * signed plugin indexes built over the RAW bytes (the connector script's `buildIndex` is
 * a different envelope), index entries bound to a real `.kepcup` fixture, and an
 * in-memory market server for both the index and the package downloads.
 */

export interface PluginMarketKey {
  keyId: string;
  privateKey: KeyObject;
  publicEntry: ConnectorIndexPublicKey;
}

/** Same shape as the directory fixture's `TestKey`; a separate alias for the market channel. */
export function makeMarketKey(keyId = 'market-test'): PluginMarketKey {
  const key = makeKey(keyId);
  return { keyId: key.keyId, privateKey: key.privateKey, publicEntry: key.publicEntry };
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
    summary?: PluginIndexEntry['summary'];
  } = {},
): PluginIndexEntry {
  const manifest = fixture.manifest as {
    id: string;
    version: string;
    name?: string;
    description?: string;
    author?: { name?: string } | null;
  };
  return {
    id: manifest.id,
    version: manifest.version,
    tier: extra.tier ?? 'verified',
    sha256: fixture.sha256,
    size: fixture.size,
    downloadUrl: extra.downloadUrl ?? `https://pkg.test/${fixture.sha256}.kepcup`,
    categories: extra.categories ?? [],
    summary: {
      name: extra.summary?.name ?? String(manifest.name ?? manifest.id),
      ...(extra.summary?.description !== undefined || manifest.description !== undefined
        ? { description: extra.summary?.description ?? String(manifest.description ?? '') }
        : {}),
      ...(extra.summary?.author !== undefined || manifest.author !== undefined
        ? { author: extra.summary?.author ?? manifest.author?.name ?? null }
        : {}),
    },
    updatedAt: 0,
  };
}

/**
 * In-memory market server for both index files and package downloads: returns the bytes
 * registered for a full URL, 404 otherwise. Simplified ETag / 304 support (the index files
 * carry an etag; packages do not need one).
 */
export function memoryMarketFetch(files: Map<string, Buffer>): {
  fetch: DirectoryFetch;
  requests: string[];
  publish(url: string, bytes: Buffer): void;
} {
  const requests: string[] = [];
  let version = 0;
  const etags = new Map<string, string>();
  const fetch: DirectoryFetch = async (input, init) => {
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
