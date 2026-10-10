import { describe, expect, it } from 'vitest';
import {
  checkDiscovery,
  checkProbe,
  resourceCovers,
  type AuthorizationServerMetadataLike,
  type DiscoveryFacts,
} from '../src/checks/remote.js';
import { find, labels } from './support.js';

const URL_ = 'https://mcp.example.com/mcp';

function as(over: Partial<AuthorizationServerMetadataLike> = {}): AuthorizationServerMetadataLike {
  return {
    issuer: 'https://auth.example.com',
    authorization_endpoint: 'https://auth.example.com/authorize',
    token_endpoint: 'https://auth.example.com/token',
    response_types_supported: ['code'],
    revocation_endpoint: 'https://auth.example.com/revoke',
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    ...over,
  };
}

function facts(
  over: Partial<AuthorizationServerMetadataLike> = {},
  prm?: DiscoveryFacts['prm'],
): DiscoveryFacts {
  return {
    challenge: {},
    prm: prm ?? {
      ok: true,
      metadata: { resource: URL_, authorization_servers: ['https://auth.example.com'] },
    },
    as: { ok: true, url: 'https://auth.example.com', metadata: as(over) },
  };
}

const auto = { registration: 'auto', clientRef: null } as const;

describe('checkProbe', () => {
  it('accepts a bearer 401 with resource_metadata', () => {
    const { checks, mode } = checkProbe({
      url: URL_,
      outcome: {
        kind: 'response',
        status: 401,
        wwwAuthenticate:
          'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
      },
    });
    expect(mode).toBe('auth-required');
    expect(labels({ checks }, 'error')).toEqual([]);
    expect(find({ checks }, 'remote.challenge')?.severity).toBe('info');
  });

  it('errors when the 401 has no (bearer) challenge, warns without resource_metadata', () => {
    const none = checkProbe({
      url: URL_,
      outcome: { kind: 'response', status: 401, wwwAuthenticate: null },
    });
    expect(labels(none, 'error')).toEqual(['remote.challenge']);
    const basic = checkProbe({
      url: URL_,
      outcome: { kind: 'response', status: 401, wwwAuthenticate: 'Basic realm="x"' },
    });
    expect(labels(basic, 'error')).toEqual(['remote.challenge']);
    const bare = checkProbe({
      url: URL_,
      outcome: { kind: 'response', status: 401, wwwAuthenticate: 'Bearer' },
    });
    expect(labels(bare, 'warn')).toEqual(['remote.challenge']);
    expect(bare.mode).toBe('auth-required');
  });

  it('recognises open servers and unexpected statuses', () => {
    const open = checkProbe({
      url: URL_,
      outcome: { kind: 'response', status: 200, wwwAuthenticate: null },
    });
    expect(open.mode).toBe('open');
    expect(find(open, 'remote.open')?.severity).toBe('info');
    const bad = checkProbe({
      url: URL_,
      outcome: { kind: 'response', status: 404, wwwAuthenticate: null },
    });
    expect(bad.mode).toBe('unusable');
    expect(labels(bad, 'error')).toEqual(['remote.reachable']);
  });

  it('separates TLS failures from other network errors', () => {
    const tls = checkProbe({
      url: URL_,
      outcome: { kind: 'network-error', code: 'CERT_HAS_EXPIRED', message: 'x', tls: true },
    });
    expect(labels(tls, 'error')).toEqual(['remote.tls']);
    expect(tls.mode).toBe('unusable');
    const net = checkProbe({
      url: URL_,
      outcome: { kind: 'network-error', code: 'ECONNREFUSED', message: 'refused', tls: false },
    });
    expect(labels(net, 'error')).toEqual(['remote.reachable']);
  });
});

describe('resourceCovers', () => {
  it('requires the same origin and a path prefix', () => {
    expect(resourceCovers('https://mcp.example.com/mcp', URL_)).toBe(true);
    expect(resourceCovers('https://mcp.example.com', URL_)).toBe(true);
    expect(resourceCovers('https://mcp.example.com/other', URL_)).toBe(false);
    expect(resourceCovers('https://evil.example.com/mcp', URL_)).toBe(false);
    expect(resourceCovers('nonsense', URL_)).toBe(false);
  });
});

describe('checkDiscovery', () => {
  it('passes a complete, modern server', () => {
    const checks = checkDiscovery(URL_, facts(), auto);
    expect(labels({ checks }, 'error')).toEqual([]);
    expect(labels({ checks }, 'warn')).toEqual([]);
    expect(find({ checks }, 'remote.client-registration')?.message).toContain(
      'https://kepcup.com/oauth/client.json',
    );
  });

  it('reports a missing or mismatching PRM', () => {
    expect(
      labels(
        { checks: checkDiscovery(URL_, facts({}, { ok: false, error: 'HTTP 404' }), auto) },
        'error',
      ),
    ).toEqual(['remote.prm']);
    const mismatch = checkDiscovery(
      URL_,
      facts(
        {},
        {
          ok: true,
          metadata: {
            resource: 'https://other.example.com/mcp',
            authorization_servers: ['https://a'],
          },
        },
      ),
      auto,
    );
    expect(labels({ checks: mismatch }, 'error')).toEqual(['remote.prm']);
    const noAs = checkDiscovery(URL_, facts({}, { ok: true, metadata: { resource: URL_ } }), auto);
    expect(labels({ checks: noAs }, 'error')).toEqual(['remote.prm']);
  });

  it('reports unavailable authorization server metadata and stops', () => {
    const checks = checkDiscovery(
      URL_,
      { ...facts(), as: { ok: false, url: 'https://auth.example.com', error: 'HTTP 404' } },
      auto,
    );
    expect(labels({ checks }, 'error')).toEqual(['remote.as-metadata']);
    expect(checks.some((c) => c.id === 'remote.pkce')).toBe(false);
  });

  it('requires PKCE S256', () => {
    expect(
      labels(
        {
          checks: checkDiscovery(
            URL_,
            facts({ code_challenge_methods_supported: undefined }),
            auto,
          ),
        },
        'error',
      ),
    ).toEqual(['remote.pkce']);
    expect(
      labels(
        {
          checks: checkDiscovery(
            URL_,
            facts({ code_challenge_methods_supported: ['plain'] }),
            auto,
          ),
        },
        'error',
      ),
    ).toEqual(['remote.pkce']);
  });

  it('warns without RFC 9207 iss support, a revocation endpoint or refresh grant', () => {
    const checks = checkDiscovery(
      URL_,
      facts({
        authorization_response_iss_parameter_supported: undefined,
        revocation_endpoint: undefined,
        grant_types_supported: ['authorization_code'],
        token_endpoint_auth_methods_supported: ['client_secret_basic'],
      }),
      auto,
    );
    expect(labels({ checks }, 'warn').sort()).toEqual(
      ['remote.iss', 'remote.public-client', 'remote.refresh-token', 'remote.revocation'].sort(),
    );
    expect(labels({ checks }, 'error')).toEqual([]);
  });

  it('accepts CIMD or DCR, errors on neither unless preregistered', () => {
    const dcrOnly = facts({
      client_id_metadata_document_supported: false,
      registration_endpoint: 'https://auth.example.com/register',
    });
    expect(labels({ checks: checkDiscovery(URL_, dcrOnly, auto) }, 'error')).toEqual([]);
    const neither = facts({ client_id_metadata_document_supported: false });
    expect(labels({ checks: checkDiscovery(URL_, neither, auto) }, 'error')).toEqual([
      'remote.client-registration',
    ]);
    const pre = checkDiscovery(URL_, neither, { registration: 'preregistered', clientRef: 'acme' });
    expect(labels({ checks: pre }, 'error')).toEqual([]);
  });

  it('errors on plaintext OAuth endpoints', () => {
    const checks = checkDiscovery(
      URL_,
      facts({ token_endpoint: 'http://auth.example.com/token' }),
      auto,
    );
    expect(labels({ checks }, 'error')).toEqual(['remote.endpoints-https']);
  });
});
