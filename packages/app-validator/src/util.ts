/** True for http(s) URLs whose host is a loopback address (local development / tests). */
export function isLoopbackUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
  } catch {
    return false;
  }
}

/**
 * Hosts that are not on the public internet: localhost, loopback and private-range IP literals.
 * (A public name that *resolves* to a private address is not caught here; run the CLI on untrusted
 * submissions in a network-isolated sandbox, see README.)
 */
export function isNonPublicHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '::')
    return true;
  if (/^(?:fc|fd)[0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(mapped?.[1] ?? host);
  if (v4 === null) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/** https, or http on loopback (the one plaintext exception). */
export function isAcceptableUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackUrl(value));
  } catch {
    return false;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The Node/undici network error code behind a failed `fetch`, if any. */
export function networkErrorCode(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

const TLS_ERROR_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_UNTRUSTED',
  'ERR_SSL_WRONG_VERSION_NUMBER',
]);

export function isTlsErrorCode(code: string | null): boolean {
  return code !== null && (TLS_ERROR_CODES.has(code) || code.startsWith('ERR_SSL_'));
}
