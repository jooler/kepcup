/**
 * HTTP plumbing shared by the public and admin handlers: every response (success or
 * error) carries the §8 output trio — `Content-Type: application/json`,
 * `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` — and deliberately NO
 * CORS headers (the native core fetch client needs none; browser pages must not be
 * able to read report responses, §8).
 */

export const BASE_HEADERS: Record<string, string> = {
  'content-type': 'application/json',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

/** Control-flow error carrying an HTTP status + JSON body (+ extra headers). */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
    readonly headers: Record<string, string> = {},
  ) {
    super(`http ${status}`);
    this.name = 'HttpError';
  }
}

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...BASE_HEADERS, ...headers },
  });
}
