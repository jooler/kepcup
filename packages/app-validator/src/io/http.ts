import type { McpFetch } from '@earendil-works/pi-mcp';
import { isAcceptableUrl, isNonPublicHostname } from '../util.js';

/**
 * Minimal guarded HTTP layer for the validator: https only (plaintext http only on loopback, for
 * local development and tests), bounded time and body size, manual redirects. The validator is a
 * developer tool; a registry pipeline that runs it on untrusted submissions must still run it in a
 * network-isolated sandbox (README, "Running in CI").
 */

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;

export class BlockedUrlError extends Error {
  constructor(url: string) {
    super(
      `Refusing to fetch ${redact(url)}: only public https (or http on loopback when the target itself is local) is allowed.`,
    );
    this.name = 'BlockedUrlError';
  }
}

export class ResponseTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`Response larger than ${maxBytes} bytes.`);
    this.name = 'ResponseTooLargeError';
  }
}

function redact(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`;
  } catch {
    return '(invalid url)';
  }
}

export interface GuardedFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  /** Allow redirects to another origin (privacy policy pages redirect to www.). Default false. */
  crossOriginRedirects?: boolean;
  /**
   * May requests (including redirect hops) reach localhost / loopback / private IP literals?
   * Default: only when the *first* URL of the call is itself such a host, so a public URL can never
   * be redirected into the local network. Pass `true` / `false` to force it (the remote MCP server
   * and everything its metadata points at use `isLoopbackUrl(remote)`).
   */
  allowLoopback?: boolean;
  /** Test seam: replaces the global fetch. */
  fetchImpl?: typeof fetch;
}

async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) {
    void response.body?.cancel().catch(() => undefined);
    throw new ResponseTooLargeError(maxBytes);
  }
  if (response.body === null) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ResponseTooLargeError(maxBytes);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

const NULL_BODY = new Set([101, 204, 205, 304]);

/** A `fetch` with the guards above; also usable as pi-mcp's `McpFetch`. */
export function createGuardedFetch(options: GuardedFetchOptions = {}): McpFetch {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const impl = options.fetchImpl ?? fetch;
  return async (input, init) => {
    let url = new URL(typeof input === 'string' ? input : input.href);
    let method = (init?.method ?? 'GET').toUpperCase();
    let body = init?.body ?? undefined;
    const signal = AbortSignal.any([
      AbortSignal.timeout(timeoutMs),
      ...(init?.signal ? [init.signal] : []),
    ]);
    const origin = url.origin;
    const permitLocal = options.allowLoopback ?? isNonPublicHostname(url.hostname);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      if (!isAcceptableUrl(url.href)) throw new BlockedUrlError(url.href);
      if (!permitLocal && isNonPublicHostname(url.hostname)) throw new BlockedUrlError(url.href);
      const response = await impl(url, {
        ...init,
        method,
        body: body as never,
        redirect: 'manual',
        signal,
      });
      if (response.status >= 300 && response.status < 400 && response.headers.has('location')) {
        void response.body?.cancel().catch(() => undefined);
        const next = new URL(response.headers.get('location') as string, url);
        if (next.origin !== origin && options.crossOriginRedirects !== true) {
          throw new BlockedUrlError(next.href);
        }
        if (
          response.status === 303 ||
          ((response.status === 301 || response.status === 302) && method === 'POST')
        ) {
          method = 'GET';
          body = undefined;
        }
        url = next;
        continue;
      }
      const bytes = await readCapped(response, maxBytes);
      const headers = new Headers(response.headers);
      headers.delete('content-encoding');
      headers.delete('content-length');
      return new Response(NULL_BODY.has(response.status) ? null : (bytes as never), {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }
    throw new Error('Too many redirects.');
  };
}

export interface TextResponse {
  status: number;
  text: string;
  contentType: string | null;
  url: string;
}

export async function fetchText(
  url: string,
  options: GuardedFetchOptions & { headers?: Record<string, string> } = {},
): Promise<TextResponse> {
  const guarded = createGuardedFetch(options);
  const response = await guarded(url, { headers: options.headers ?? { accept: '*/*' } });
  return {
    status: response.status,
    text: await response.text(),
    contentType: response.headers.get('content-type'),
    url,
  };
}
