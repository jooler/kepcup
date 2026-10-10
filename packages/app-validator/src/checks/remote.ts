import { KEPCUP_OAUTH_CLIENT_ID } from '@kepcup/shared';
import { makeCheck, type Check } from '../types.js';
import { isAcceptableUrl } from '../util.js';

/**
 * (b) remote reachability and OAuth discovery checks (MCP authorization spec 2025-06-18,
 * RFC 9728 protected-resource metadata, RFC 8414 authorization-server metadata, RFC 9207 `iss`,
 * client-id metadata documents). Pure: the IO layer gathers {@link ProbeFacts} /
 * {@link DiscoveryFacts}; nothing here touches the network.
 */

export type ProbeOutcome =
  | { kind: 'response'; status: number; wwwAuthenticate: string | null }
  | { kind: 'network-error'; code: string | null; message: string; tls: boolean };

export interface ProbeFacts {
  url: string;
  outcome: ProbeOutcome;
}

export type ProbeMode = 'auth-required' | 'open' | 'unusable';

export interface ChallengeFacts {
  resourceMetadataUrl?: string | undefined;
  scope?: string | undefined;
  error?: string | undefined;
}

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers?: string[] | undefined;
  scopes_supported?: string[] | undefined;
  [key: string]: unknown;
}

export interface AuthorizationServerMetadataLike {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  response_types_supported: string[];
  registration_endpoint?: string | undefined;
  revocation_endpoint?: string | undefined;
  scopes_supported?: string[] | undefined;
  grant_types_supported?: string[] | undefined;
  token_endpoint_auth_methods_supported?: string[] | undefined;
  code_challenge_methods_supported?: string[] | undefined;
  client_id_metadata_document_supported?: boolean | undefined;
  authorization_response_iss_parameter_supported?: boolean | undefined;
  [key: string]: unknown;
}

export interface DiscoveryFacts {
  challenge: ChallengeFacts;
  prm: { ok: true; metadata: ProtectedResourceMetadata } | { ok: false; error: string };
  as:
    | { ok: true; url: string; metadata: AuthorizationServerMetadataLike }
    | { ok: false; url: string; error: string };
}

export interface RegistrationExpectation {
  registration: 'auto' | 'preregistered';
  clientRef: string | null;
}

/** Interpret the unauthenticated `initialize` probe. */
export function checkProbe(facts: ProbeFacts): { checks: Check[]; mode: ProbeMode } {
  const outcome = facts.outcome;
  if (outcome.kind === 'network-error') {
    if (outcome.tls) {
      return {
        mode: 'unusable',
        checks: [
          makeCheck(
            'remote.tls',
            'error',
            `TLS handshake with ${facts.url} failed (${outcome.code ?? outcome.message}).`,
            {
              hint: 'Serve a certificate that chains to a public CA, matches the host name and has not expired.',
            },
          ),
        ],
      };
    }
    return {
      mode: 'unusable',
      checks: [
        makeCheck('remote.reachable', 'error', `Cannot reach ${facts.url}: ${outcome.message}`, {
          hint: 'Check the URL, DNS and that the server accepts POST requests on the MCP endpoint.',
        }),
      ],
    };
  }
  const checks: Check[] = [
    makeCheck('remote.reachable', 'info', `${facts.url} answered HTTP ${outcome.status}.`),
  ];
  if (outcome.status === 401) {
    if (outcome.wwwAuthenticate === null || !/^\s*bearer\b/i.test(outcome.wwwAuthenticate)) {
      checks.push(
        makeCheck(
          'remote.challenge',
          'error',
          outcome.wwwAuthenticate === null
            ? 'HTTP 401 without a WWW-Authenticate header.'
            : `WWW-Authenticate is not a Bearer challenge (${outcome.wwwAuthenticate.slice(0, 80)}).`,
          {
            hint: 'Answer unauthenticated requests with 401 and `WWW-Authenticate: Bearer resource_metadata="https://…/.well-known/oauth-protected-resource"`.',
          },
        ),
      );
      return { checks, mode: 'auth-required' };
    }
    if (!/resource_metadata\s*=/i.test(outcome.wwwAuthenticate)) {
      checks.push(
        makeCheck(
          'remote.challenge',
          'warn',
          'The 401 challenge has no resource_metadata parameter; clients must guess the metadata URL.',
          { hint: 'Add resource_metadata="<PRM URL>" to WWW-Authenticate (RFC 9728 section 5.1).' },
        ),
      );
    } else {
      checks.push(
        makeCheck('remote.challenge', 'info', 'The 401 challenge carries resource_metadata.'),
      );
    }
    return { checks, mode: 'auth-required' };
  }
  if (outcome.status >= 200 && outcome.status < 300) {
    checks.push(
      makeCheck(
        'remote.open',
        'info',
        'The server accepts unauthenticated requests: OAuth checks are skipped and tools are listed without a token.',
      ),
    );
    return { checks, mode: 'open' };
  }
  checks.push(
    makeCheck(
      'remote.reachable',
      'error',
      `Unexpected HTTP ${outcome.status} from the MCP endpoint (expected 401 with a challenge, or 2xx).`,
      {
        hint: 'POST an initialize request: unauthenticated clients must get 401 + WWW-Authenticate.',
      },
    ),
  );
  return { checks, mode: 'unusable' };
}

/** RFC 9728 / MCP: the PRM `resource` must cover the MCP URL. */
export function resourceCovers(resource: string, serverUrl: string): boolean {
  try {
    const wanted = new URL(serverUrl);
    const configured = new URL(resource);
    if (wanted.origin !== configured.origin) return false;
    const trim = (path: string): string => (path.endsWith('/') ? path : `${path}/`);
    return trim(wanted.pathname).startsWith(trim(configured.pathname));
  } catch {
    return false;
  }
}

export function checkDiscovery(
  serverUrl: string,
  facts: DiscoveryFacts,
  expectation: RegistrationExpectation,
): Check[] {
  const checks: Check[] = [];

  // Protected resource metadata (RFC 9728).
  if (!facts.prm.ok) {
    checks.push(
      makeCheck(
        'remote.prm',
        'error',
        `Protected resource metadata is not available: ${facts.prm.error}`,
        {
          hint: 'Publish /.well-known/oauth-protected-resource (RFC 9728) with resource and authorization_servers.',
        },
      ),
    );
  } else {
    const prm = facts.prm.metadata;
    if (!resourceCovers(prm.resource, serverUrl)) {
      checks.push(
        makeCheck(
          'remote.prm',
          'error',
          `PRM resource "${prm.resource}" does not cover the MCP URL ${serverUrl}.`,
          {
            hint: 'resource must be the MCP endpoint URL (or a path prefix of it, same origin).',
          },
        ),
      );
    } else if (prm.authorization_servers === undefined || prm.authorization_servers.length === 0) {
      checks.push(
        makeCheck('remote.prm', 'error', 'PRM lists no authorization_servers.', {
          hint: 'Add authorization_servers: ["https://your-issuer"].',
        }),
      );
    } else {
      checks.push(
        makeCheck(
          'remote.prm',
          'info',
          `Protected resource metadata found (authorization server ${prm.authorization_servers[0]}).`,
        ),
      );
    }
  }

  // Authorization server metadata (RFC 8414 / OIDC discovery).
  if (!facts.as.ok) {
    checks.push(
      makeCheck(
        'remote.as-metadata',
        'error',
        `Authorization server metadata for ${facts.as.url} is not available: ${facts.as.error}`,
        {
          hint: 'Serve /.well-known/oauth-authorization-server (or openid-configuration) whose issuer equals the authorization server URL.',
        },
      ),
    );
    return checks;
  }
  const meta = facts.as.metadata;
  checks.push(
    makeCheck(
      'remote.as-metadata',
      'info',
      `Authorization server metadata found (issuer ${meta.issuer}).`,
    ),
  );

  const unsafe = (
    [
      ['authorization_endpoint', meta.authorization_endpoint],
      ['token_endpoint', meta.token_endpoint],
      ['registration_endpoint', meta.registration_endpoint],
      ['revocation_endpoint', meta.revocation_endpoint],
    ] as const
  ).filter(([, value]) => value !== undefined && !isAcceptableUrl(value));
  if (unsafe.length > 0) {
    checks.push(
      makeCheck(
        'remote.endpoints-https',
        'error',
        `Endpoints must use https: ${unsafe.map(([k]) => k).join(', ')}.`,
        {
          hint: 'All OAuth endpoints must be served over TLS.',
        },
      ),
    );
  }

  // PKCE (OAuth 2.1; MCP requires S256).
  const methods = meta.code_challenge_methods_supported;
  if (methods === undefined) {
    checks.push(
      makeCheck(
        'remote.pkce',
        'error',
        'code_challenge_methods_supported is absent: clients cannot confirm PKCE S256 support (MCP requires refusing in that case).',
        { hint: 'Advertise code_challenge_methods_supported: ["S256"].' },
      ),
    );
  } else if (!methods.includes('S256')) {
    checks.push(
      makeCheck(
        'remote.pkce',
        'error',
        `PKCE S256 is not supported (advertised: ${methods.join(', ') || 'none'}).`,
        {
          hint: 'Support code_challenge_method=S256.',
        },
      ),
    );
  } else {
    checks.push(makeCheck('remote.pkce', 'info', 'PKCE S256 is supported.'));
  }

  // RFC 9207 iss.
  if (meta.authorization_response_iss_parameter_supported === true) {
    checks.push(makeCheck('remote.iss', 'info', 'Authorization responses carry iss (RFC 9207).'));
  } else {
    checks.push(
      makeCheck(
        'remote.iss',
        'warn',
        'authorization_response_iss_parameter_supported is not true: mix-up attacks cannot be detected by the client.',
        {
          hint: 'Return iss in the authorization response and advertise authorization_response_iss_parameter_supported: true.',
        },
      ),
    );
  }

  // Client registration.
  const cimd = meta.client_id_metadata_document_supported === true;
  const dcr = meta.registration_endpoint !== undefined;
  if (cimd) {
    checks.push(
      makeCheck(
        'remote.client-registration',
        'info',
        `Client ID Metadata Documents are supported: KepCup connects as ${KEPCUP_OAUTH_CLIENT_ID} without registering.`,
      ),
    );
  } else if (dcr) {
    checks.push(
      makeCheck(
        'remote.client-registration',
        'info',
        'Dynamic client registration is available (CIMD is preferred but not required).',
      ),
    );
  } else if (expectation.registration === 'preregistered') {
    checks.push(
      makeCheck(
        'remote.client-registration',
        'info',
        `Neither CIMD nor DCR; the manifest asks for KepCup's pre-registered client "${expectation.clientRef ?? ''}".`,
      ),
    );
  } else {
    checks.push(
      makeCheck(
        'remote.client-registration',
        'error',
        'Neither CIMD (client_id_metadata_document_supported) nor DCR (registration_endpoint) is available.',
        {
          hint: 'Support CIMD (preferred) or DCR, or set auth.registration to "preregistered" and ask KepCup to register a client.',
        },
      ),
    );
  }
  const authMethods = meta.token_endpoint_auth_methods_supported;
  if (authMethods !== undefined && !authMethods.includes('none')) {
    checks.push(
      makeCheck(
        'remote.public-client',
        'warn',
        `token_endpoint_auth_methods_supported lacks "none" (${authMethods.join(', ')}): KepCup is a public native client.`,
        { hint: 'Allow the "none" token endpoint auth method with PKCE.' },
      ),
    );
  }
  const grants = meta.grant_types_supported;
  if (grants !== undefined && !grants.includes('refresh_token')) {
    checks.push(
      makeCheck(
        'remote.refresh-token',
        'warn',
        'refresh_token is not among grant_types_supported: users must re-authorize when the access token expires.',
        {
          hint: 'Support the refresh_token grant (with rotation) for a lasting connection.',
        },
      ),
    );
  }
  if (meta.revocation_endpoint === undefined) {
    checks.push(
      makeCheck(
        'remote.revocation',
        'warn',
        'No revocation_endpoint: disconnecting in KepCup cannot invalidate the token server-side.',
        {
          hint: 'Implement RFC 7009 token revocation and advertise revocation_endpoint.',
        },
      ),
    );
  } else {
    checks.push(makeCheck('remote.revocation', 'info', 'Token revocation endpoint is advertised.'));
  }
  return checks;
}
