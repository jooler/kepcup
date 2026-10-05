import dns from 'node:dns';
import {
  BROWSER_DNS_CACHE_TTL_MS,
  BROWSER_DNS_NEGATIVE_TTL_MS,
  isLoopbackHostname,
} from '@kepcup/shared';

/**
 * Host resolver behind the browser network intercept (docs/dev/phases/
 * P11-browser.md 任务 2): `dns.lookup` over all addresses with a small
 * positive/negative TTL cache and in-flight dedupe. Kept free of Electron
 * imports so the cache/eviction logic is unit-testable.
 */

interface DnsCacheEntry {
  addresses: string[] | null;
  expires: number;
}

/** Upper bound for the cache: enough for any realistic browsing session. */
export const DNS_CACHE_MAX_ENTRIES = 4096;

export interface HostDnsResolverOptions {
  /** Injectable clock (tests). */
  now?: () => number;
  /** Injectable lookup (tests); resolves null for unresolvable hosts. */
  lookup?: (host: string) => Promise<string[] | null>;
  /** Cache capacity (tests); default DNS_CACHE_MAX_ENTRIES. */
  maxEntries?: number;
}

export class HostDnsResolver {
  readonly #cache = new Map<string, DnsCacheEntry>();
  readonly #inflight = new Map<string, Promise<string[]>>();
  readonly #now: () => number;
  readonly #lookup: (host: string) => Promise<string[] | null>;
  readonly #maxEntries: number;

  constructor(options?: HostDnsResolverOptions) {
    this.#now = options?.now ?? Date.now;
    this.#lookup =
      options?.lookup ??
      ((host) =>
        new Promise<string[] | null>((resolve) => {
          dns.lookup(host, { all: true, verbatim: true }, (error, addresses) => {
            resolve(error || addresses.length === 0 ? null : addresses.map((a) => a.address));
          });
        }));
    this.#maxEntries = options?.maxEntries ?? DNS_CACHE_MAX_ENTRIES;
  }

  /** Current cache size (exposed for tests and diagnostics). */
  get size(): number {
    return this.#cache.size;
  }

  /** Resolves to the host's addresses; empty array = unresolvable (blocked). */
  async resolve(host: string): Promise<string[]> {
    // Loopback and IP literals never touch the resolver.
    if (isLoopbackHostname(host)) return ['127.0.0.1', '::1'];
    if (isIpv4Literal(host) || host.includes(':')) return [host];

    const cached = this.#cache.get(host);
    if (cached && cached.expires > this.#now()) {
      return cached.addresses === null ? [] : cached.addresses;
    }
    const inflight = this.#inflight.get(host);
    if (inflight) return inflight;
    const pending = this.#lookup(host)
      .then((addresses) => {
        // BR-P11-003: the cache must stay bounded — a page throwing random
        // subdomains at the resolver must not grow it without end. When full,
        // expired entries are swept first; the oldest survivors are dropped.
        if (this.#cache.size >= this.#maxEntries) this.#sweep();
        this.#cache.set(host, {
          addresses,
          expires:
            this.#now() + (addresses === null ? BROWSER_DNS_NEGATIVE_TTL_MS : BROWSER_DNS_CACHE_TTL_MS),
        });
        return addresses ?? [];
      })
      .finally(() => {
        this.#inflight.delete(host);
      });
    this.#inflight.set(host, pending);
    return pending;
  }

  /** Drops expired entries, then the oldest survivors while still full. */
  #sweep(): void {
    const now = this.#now();
    for (const [key, entry] of this.#cache) {
      if (entry.expires <= now) this.#cache.delete(key);
    }
    while (this.#cache.size >= this.#maxEntries) {
      const oldest = this.#cache.keys().next();
      if (oldest.done) break;
      this.#cache.delete(oldest.value);
    }
  }
}

function isIpv4Literal(host: string): boolean {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(host);
}
