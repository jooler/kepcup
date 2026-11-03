/**
 * Classify a sandboxed `curl -o /dev/null -w '%{http_code}'` probe.
 *
 * The network-mode test needs proof the request left the sandbox, not a
 * trusted TLS chain. macOS CI runners flake with curl exit 60
 * (CURLE_PEER_FAILED_VERIFICATION / CURLE_SSL_CACERT: the peer certificate
 * could not be authenticated) after the handshake with example.com, so
 * `%{http_code}` is never written. Those exits still mean a peer certificate
 * was received. A hard block fails earlier — DNS, connect, timeout, or the
 * proxy's CONNECT 403 (curl exit 56) — and must not count.
 */

/** Libcurl statuses raised only after a peer certificate was received. */
const TLS_PEER_REACHED_EXITS = new Set([
  51, // CURLE_PEER_FAILED_VERIFICATION before curl 7.62
  60, // CURLE_PEER_FAILED_VERIFICATION / CURLE_SSL_CACERT (curl >= 7.62)
  83, // CURLE_SSL_ISSUER_ERROR
  90, // CURLE_SSL_PINNEDPUBKEYNOTMATCH
  91, // CURLE_SSL_INVALIDCERTSTATUS
]);

/**
 * HTTP status from a finished transfer, or `tls-peer` when curl died on the
 * peer certificate. Anything else is `exit:<code>` plus a short stderr hint.
 */
export const SANDBOX_CURL_REACHED = /^(?:\d{3}|tls-peer)$/;

export interface CurlProbeResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export function sandboxCurlReachToken(result: CurlProbeResult): string {
  const http = result.stdout.trim();
  if (result.exitCode === 0 && /^\d{3}$/.test(http)) return http;
  if (result.exitCode !== null && TLS_PEER_REACHED_EXITS.has(result.exitCode)) return 'tls-peer';
  const why = result.stderr.trim().replace(/\s+/g, ' ').slice(0, 160);
  const exit = result.exitCode ?? 'null';
  return why.length > 0 ? `exit:${exit} ${why}` : `exit:${exit}`;
}
