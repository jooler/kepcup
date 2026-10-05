import { describe, expect, test } from 'vitest';
import { DNS_CACHE_MAX_ENTRIES, HostDnsResolver } from './dns-resolver.js';

/**
 * Unit tests for the bounded DNS cache behind the browser network intercept
 * (BR-P11-003): positive/negative TTL caching, in-flight dedupe and the
 * eviction that keeps `size` bounded under unbounded host churn.
 */

function harness(now: { value: number }, lookupLog: string[]) {
  const tables: Array<Record<string, string[] | null>> = [];
  const lookup = async (host: string): Promise<string[] | null> => {
    lookupLog.push(host);
    for (const table of tables) {
      if (host in table) return table[host] ?? null;
    }
    return ['203.0.113.1'];
  };
  const resolver = new HostDnsResolver({ now: () => now.value, lookup });
  return { resolver, tables };
}

describe('HostDnsResolver', () => {
  test('loopback hostnames and IP literals never touch the resolver', async () => {
    const now = { value: 0 };
    const lookupLog: string[] = [];
    const { resolver } = harness(now, lookupLog);
    await expect(resolver.resolve('localhost')).resolves.toEqual(['127.0.0.1', '::1']);
    await expect(resolver.resolve('127.0.0.1')).resolves.toEqual(['127.0.0.1']);
    await expect(resolver.resolve('192.168.1.1')).resolves.toEqual(['192.168.1.1']);
    await expect(resolver.resolve('example.test')).resolves.toEqual(['203.0.113.1']);
    expect(lookupLog).toEqual(['example.test']);
  });

  test('positive and negative results are cached within the TTL', async () => {
    const now = { value: 0 };
    const lookupLog: string[] = [];
    const { resolver, tables } = harness(now, lookupLog);
    tables.push({ 'gone.test': null });

    await expect(resolver.resolve('ok.test')).resolves.toEqual(['203.0.113.1']);
    await expect(resolver.resolve('ok.test')).resolves.toEqual(['203.0.113.1']);
    await expect(resolver.resolve('gone.test')).resolves.toEqual([]);
    await expect(resolver.resolve('gone.test')).resolves.toEqual([]);
    expect(lookupLog).toEqual(['ok.test', 'gone.test']);

    now.value = 60_001; // past the 60s positive TTL
    await expect(resolver.resolve('ok.test')).resolves.toEqual(['203.0.113.1']);
    expect(lookupLog).toEqual(['ok.test', 'gone.test', 'ok.test']);
  });

  test('concurrent lookups for one host share a single in-flight query', async () => {
    const now = { value: 0 };
    const lookupLog: string[] = [];
    const { resolver } = harness(now, lookupLog);
    const [a, b] = await Promise.all([resolver.resolve('same.test'), resolver.resolve('same.test')]);
    expect(a).toEqual(['203.0.113.1']);
    expect(b).toEqual(['203.0.113.1']);
    expect(lookupLog).toEqual(['same.test']);
  });

  test('the cache stays bounded: expired entries are swept, oldest survivors dropped (BR-P11-003)', async () => {
    const now = { value: 0 };
    const lookupLog: string[] = [];
    const maxEntries = 8;
    const lookup = async (host: string): Promise<string[] | null> => {
      lookupLog.push(host);
      return ['203.0.113.1'];
    };
    const resolver = new HostDnsResolver({ now: () => now.value, lookup, maxEntries });

    for (let i = 0; i < maxEntries * 3; i += 1) {
      await resolver.resolve(`host-${i}.test`);
      expect(resolver.size).toBeLessThanOrEqual(maxEntries);
    }
    expect(resolver.size).toBe(maxEntries);
    // The oldest entries were evicted; a re-resolve queries again.
    await resolver.resolve('host-0.test');
    expect(lookupLog.filter((h) => h === 'host-0.test')).toHaveLength(2);

    // Expiry sweep: advance past the TTL and confirm expired entries are
    // reclaimed in favor of fresh ones even when below the hard cap.
    const expired = new HostDnsResolver({ now: () => now.value, lookup, maxEntries });
    for (let i = 0; i < maxEntries; i += 1) await expired.resolve(`old-${i}.test`);
    expect(expired.size).toBe(maxEntries);
    now.value = 60_001;
    await expired.resolve('fresh.test');
    expect(expired.size).toBeLessThanOrEqual(maxEntries);
    await expired.resolve('old-0.test');
    expect(lookupLog.filter((h) => h === 'old-0.test')).toHaveLength(2);
  });

  test('default capacity constant is generous but finite', () => {
    expect(DNS_CACHE_MAX_ENTRIES).toBe(4096);
  });
});
