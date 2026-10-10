import { randomBytes } from 'node:crypto';
import {
  OAuthError,
  exchangeAuthorizationCode,
  registerClient,
  resourceUrlFromServerUrl,
  selectResource,
  startAuthorization,
  type OAuthClientInformation,
  type OAuthClientMetadata,
  type OAuthTokens,
} from '@earendil-works/pi-mcp/oauth';
import type { McpFetch } from '@earendil-works/pi-mcp';
import { OAUTH_CALLBACK_PATH, OAUTH_CALLBACK_PORTS } from '@kepcup/shared';
import type {
  AuthorizationServerMetadataLike,
  ChallengeFacts,
  ProtectedResourceMetadata,
} from '../checks/remote.js';
import { makeCheck, type Check } from '../types.js';
import { errorMessage, isLoopbackUrl } from '../util.js';
import { startCallbackServer } from './callback-server.js';

/**
 * `--auth`: one real interactive authorization with KepCup's client identity (CIMD client id),
 * following KepCup's own engine (design 29 section 5.1): discovery result -> client identity
 * (CIMD, else DCR) -> PKCE + state -> loopback callback -> iss check (RFC 9207) -> token
 * exchange with the RFC 8707 resource. The token is only held in memory for `tools/list` and is
 * revoked afterwards when the server offers a revocation endpoint. Nothing secret is ever
 * written into a check or the log.
 */

export interface AuthRunInput {
  serverUrl: string;
  challenge: ChallengeFacts;
  prm: ProtectedResourceMetadata | null;
  authorizationServerUrl: string;
  metadata: AuthorizationServerMetadataLike;
  /** The CIMD document URL used as client_id (KepCup's, unless a test overrides it). */
  clientIdUrl: string;
  fetch: McpFetch;
  /** Opens the authorization URL in a browser (tests inject a fake). */
  openBrowser: (url: string) => void | Promise<void>;
  /** How long to wait for the user to finish in the browser. */
  callbackTimeoutMs: number;
  ports?: readonly number[] | undefined;
  log: (line: string) => void;
}

/**
 * Why `value` must not be used as an OAuth endpoint, or null when it is fine: https only; plaintext
 * http only for loopback and only when the MCP server itself is on loopback (local development),
 * mirroring KepCup's own engine. Anything else (`file:`, `smb:`, `javascript:`, custom protocol
 * handlers, plaintext hosts) is refused: the authorization URL is handed to the system browser and
 * a hostile submission controls it through its authorization-server metadata.
 */
export function endpointProblem(value: string, serverIsLoopback: boolean): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'it is not a valid URL';
  }
  if (url.protocol === 'https:') return null;
  if (url.protocol === 'http:' && serverIsLoopback && isLoopbackUrl(value)) return null;
  return url.protocol === 'http:'
    ? 'plaintext http is only allowed on loopback for a loopback server'
    : `the ${url.protocol} scheme is not allowed (https only)`;
}

export interface AuthRunResult {
  checks: Check[];
  accessToken: string | null;
  /** Revoke the token(s) obtained; idempotent. */
  cleanup(): Promise<Check[]>;
}

interface CimdDocument {
  client_id?: unknown;
  redirect_uris?: unknown;
}

/** Fetch and sanity-check the CIMD document that identifies the client. */
export async function checkCimdDocument(clientIdUrl: string, fetchFn: McpFetch): Promise<Check> {
  try {
    const response = await fetchFn(clientIdUrl, { headers: { accept: 'application/json' } });
    if (!response.ok) {
      return makeCheck(
        'auth.cimd-document',
        'error',
        `KepCup's client identity document ${clientIdUrl} answered HTTP ${response.status}.`,
        { hint: 'This is KepCup infrastructure, not your server: report it to the KepCup team.' },
      );
    }
    const doc = (await response.json()) as CimdDocument;
    const uris = Array.isArray(doc.redirect_uris)
      ? doc.redirect_uris.filter((u) => typeof u === 'string')
      : [];
    if (doc.client_id !== clientIdUrl) {
      return makeCheck(
        'auth.cimd-document',
        'error',
        'The client identity document client_id does not equal its URL.',
      );
    }
    if (uris.length === 0) {
      return makeCheck(
        'auth.cimd-document',
        'error',
        'The client identity document lists no redirect_uris.',
      );
    }
    return makeCheck(
      'auth.cimd-document',
      'info',
      `Client identity document ${clientIdUrl} is valid (${uris.length} redirect URI(s)).`,
    );
  } catch (error) {
    return makeCheck(
      'auth.cimd-document',
      'error',
      `Cannot fetch KepCup's client identity document ${clientIdUrl}: ${errorMessage(error)}`,
      { hint: 'Run the validator from a machine with internet access.' },
    );
  }
}

function fixedRedirectUris(ports: readonly number[]): string[] {
  return ports.map((port) => `http://127.0.0.1:${port}${OAUTH_CALLBACK_PATH}`);
}

export async function runAuthorization(input: AuthRunInput): Promise<AuthRunResult> {
  const checks: Check[] = [];
  const noToken = (): AuthRunResult => ({ checks, accessToken: null, cleanup: async () => [] });
  const { metadata } = input;
  const ports = input.ports ?? OAUTH_CALLBACK_PORTS;
  const asUrl = input.authorizationServerUrl;
  const serverIsLoopback = isLoopbackUrl(input.serverUrl);

  // Never act on an endpoint the server's metadata made up: check before any request or browser launch.
  const endpoints: Array<[string, string | undefined]> = [
    ['authorization_endpoint', metadata.authorization_endpoint],
    ['token_endpoint', metadata.token_endpoint],
  ];
  if (metadata.client_id_metadata_document_supported !== true) {
    endpoints.push(['registration_endpoint', metadata.registration_endpoint]);
  }
  for (const [name, value] of endpoints) {
    if (value === undefined) continue;
    const problem = endpointProblem(value, serverIsLoopback);
    if (problem !== null) {
      checks.push(
        makeCheck(
          'auth.flow',
          'error',
          `Authorization skipped: the advertised ${name} is unsafe (${problem}); nothing was opened.`,
          { hint: 'Advertise https OAuth endpoints only.' },
        ),
      );
      return noToken();
    }
  }

  let resource: string;
  try {
    resource =
      selectResource(input.serverUrl, input.prm ?? undefined) ??
      resourceUrlFromServerUrl(input.serverUrl).href;
  } catch {
    resource = resourceUrlFromServerUrl(input.serverUrl).href;
  }
  const scope =
    input.challenge.scope ??
    (input.prm?.scopes_supported !== undefined && input.prm.scopes_supported.length > 0
      ? input.prm.scopes_supported.join(' ')
      : undefined);

  // Client identity: CIMD first (design 29 section 5.1), else dynamic registration.
  const useCimd = metadata.client_id_metadata_document_supported === true;
  if (!useCimd && metadata.registration_endpoint === undefined) {
    checks.push(
      makeCheck(
        'auth.flow',
        'error',
        'Authorization skipped: the server supports neither CIMD nor dynamic client registration.',
      ),
    );
    return noToken();
  }
  if (useCimd) {
    const cimdCheck = await checkCimdDocument(input.clientIdUrl, input.fetch);
    checks.push(cimdCheck);
    if (cimdCheck.severity === 'error') {
      checks.push(
        makeCheck(
          'auth.flow',
          'error',
          'Authorization skipped: the client identity document is not usable.',
        ),
      );
      return noToken();
    }
  }

  const state = randomBytes(32).toString('base64url');
  let callback;
  try {
    callback = await startCallbackServer({ state, ports });
  } catch (error) {
    checks.push(makeCheck('auth.flow', 'error', errorMessage(error)));
    return noToken();
  }
  let tokens: OAuthTokens;
  let client: OAuthClientInformation = { client_id: input.clientIdUrl };
  try {
    if (!useCimd) {
      const clientMetadata: OAuthClientMetadata & { application_type: 'native' } = {
        client_name: 'KepCup (kepcup-app validate)',
        redirect_uris: [...new Set([...fixedRedirectUris(ports), callback.redirectUri])],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        application_type: 'native',
      };
      client = await registerClient(asUrl, {
        metadata,
        clientMetadata,
        ...(scope !== undefined ? { scope } : {}),
        fetch: input.fetch,
      });
      checks.push(
        makeCheck(
          'auth.client',
          'info',
          'Registered a client through dynamic client registration.',
        ),
      );
    } else {
      checks.push(
        makeCheck(
          'auth.client',
          'info',
          `Authorizing as ${input.clientIdUrl} (CIMD, no registration).`,
        ),
      );
    }

    const { authorizationUrl, codeVerifier } = await startAuthorization(asUrl, {
      metadata,
      clientInformation: client,
      redirectUrl: callback.redirectUri,
      ...(scope !== undefined ? { scope } : {}),
      state,
      resource,
    });
    // startAuthorization only builds a URL; re-check the final one before it reaches a browser.
    const openProblem = endpointProblem(authorizationUrl.href, serverIsLoopback);
    if (openProblem !== null) {
      throw new Error(`the authorization URL is unsafe (${openProblem}); nothing was opened`);
    }
    input.log(
      `Opening the authorization page: ${authorizationUrl.origin}${authorizationUrl.pathname}`,
    );
    const delivered = callback.waitForCallback(input.callbackTimeoutMs);
    delivered.catch(() => undefined);
    await input.openBrowser(authorizationUrl.href);
    const delivery = await delivered;
    const { params } = delivery;
    try {
      if (params.error !== undefined) {
        throw new Error(
          params.error === 'access_denied'
            ? 'The authorization was denied in the browser.'
            : `The authorization server returned error=${params.error}${params.errorDescription ? ` (${params.errorDescription})` : ''}.`,
        );
      }
      // RFC 9207: iss must match when present; absent is only a problem when it was promised.
      if (params.iss !== undefined && params.iss !== metadata.issuer) {
        checks.push(
          makeCheck(
            'auth.callback-iss',
            'error',
            'The authorization response iss does not match the issuer (mix-up protection fails).',
            {
              hint: 'Return the exact issuer string from your metadata in the iss parameter.',
            },
          ),
        );
        throw new Error('iss mismatch');
      }
      if (params.iss === undefined) {
        checks.push(
          makeCheck(
            'auth.callback-iss',
            metadata.authorization_response_iss_parameter_supported === true ? 'error' : 'warn',
            'The authorization response carries no iss parameter.',
            { hint: 'Add iss=<issuer> to the redirect (RFC 9207).' },
          ),
        );
        if (metadata.authorization_response_iss_parameter_supported === true)
          throw new Error('iss missing');
      } else {
        checks.push(
          makeCheck(
            'auth.callback-iss',
            'info',
            'The authorization response carries the correct iss.',
          ),
        );
      }
      if (params.code === undefined || params.code.length === 0) {
        throw new Error('The authorization response has no code.');
      }
      tokens = await exchangeAuthorizationCode(asUrl, {
        metadata,
        clientInformation: client,
        resource,
        code: params.code,
        codeVerifier,
        redirectUrl: callback.redirectUri,
        fetch: input.fetch,
      });
      delivery.respond({ ok: true });
    } catch (error) {
      delivery.respond({ ok: false, reason: errorMessage(error) });
      throw error;
    }
  } catch (error) {
    const detail =
      error instanceof OAuthError ? `${error.code}: ${error.message}` : errorMessage(error);
    checks.push(
      makeCheck('auth.flow', 'error', `Authorization failed: ${detail}`, {
        hint: 'Complete the authorization in the browser, or fix the server error above.',
      }),
    );
    return noToken();
  } finally {
    await callback.close();
  }

  checks.push(
    makeCheck(
      'auth.flow',
      'info',
      'Interactive authorization completed (PKCE S256, state, resource indicator).',
    ),
  );
  if (tokens.token_type.toLowerCase() !== 'bearer') {
    checks.push(
      makeCheck('auth.token', 'warn', `Token type is "${tokens.token_type}", expected Bearer.`),
    );
  } else {
    checks.push(makeCheck('auth.token', 'info', 'Received a Bearer access token.'));
  }
  if (tokens.refresh_token === undefined) {
    checks.push(
      makeCheck(
        'auth.refresh-token',
        'warn',
        'No refresh token was issued: the connection ends when the access token expires.',
        {
          hint: 'Issue refresh tokens to native clients (offline access) so users do not re-authorize constantly.',
        },
      ),
    );
  } else {
    checks.push(makeCheck('auth.refresh-token', 'info', 'A refresh token was issued.'));
  }
  if (tokens.expires_in === undefined) {
    checks.push(
      makeCheck('auth.token', 'warn', 'The token response has no expires_in.', {
        hint: 'Always return expires_in.',
      }),
    );
  }

  let cleaned = false;
  const issued = tokens;
  return {
    checks,
    accessToken: issued.access_token,
    async cleanup() {
      if (cleaned) return [];
      cleaned = true;
      const endpoint = metadata.revocation_endpoint;
      if (endpoint === undefined) return [];
      if (endpointProblem(endpoint, serverIsLoopback) !== null) {
        return [
          makeCheck(
            'auth.revoke',
            'warn',
            'The revocation endpoint is unsafe (not https); the token was not revoked.',
          ),
        ];
      }
      const body = new URLSearchParams({
        token: issued.refresh_token ?? issued.access_token,
        token_type_hint: issued.refresh_token !== undefined ? 'refresh_token' : 'access_token',
        client_id: client.client_id,
      });
      try {
        const response = await input.fetch(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            accept: 'application/json',
          },
          body,
        });
        void response.body?.cancel().catch(() => undefined);
        return response.ok
          ? [
              makeCheck(
                'auth.revoke',
                'info',
                'The validation token was revoked through the revocation endpoint.',
              ),
            ]
          : [
              makeCheck(
                'auth.revoke',
                'warn',
                `The revocation endpoint answered HTTP ${response.status}; the validation token may still be valid.`,
                {
                  hint: 'RFC 7009: answer 200 for a valid revocation request from a public client.',
                },
              ),
            ];
      } catch (error) {
        return [
          makeCheck('auth.revoke', 'warn', `Token revocation failed: ${errorMessage(error)}`),
        ];
      }
    },
  };
}
