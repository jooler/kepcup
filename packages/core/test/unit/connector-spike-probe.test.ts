import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

/** The D73 §5.1 spike probe (not product code): parsing + discovery flow against a fake fetch. */
const here = path.dirname(fileURLToPath(import.meta.url));
const probeUrl = pathToFileURL(path.resolve(here, '../../scripts/connector-spike/probe.mjs')).href;

interface ProbeReport {
  initialize: { status?: number; error?: string; challenge: { resource_metadata?: string } };
  prm: { found: boolean };
  authorizationServer: {
    found: boolean;
    authorization_response_iss_parameter_supported?: boolean | null;
  };
  autoRegistration: string;
  pkceS256: boolean | null;
}

interface Probe {
  CANDIDATES: Array<{ slug: string; url: string }>;
  parseWwwAuthenticate(
    header: string | null,
  ): Array<{ scheme: string; params: Record<string, string> }>;
  protectedResourceUrls(url: string): string[];
  authorizationServerUrls(issuer: string): string[];
  autoRegistrationOf(summary: Record<string, unknown> | null): string;
  probeCandidate(
    candidate: { slug: string; url: string },
    options: { fetch: (url: string, init?: RequestInit) => Promise<Response>; timeoutMs?: number },
  ): Promise<ProbeReport>;
}
const probe = (await import(/* @vite-ignore */ probeUrl)) as Probe;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('connector spike probe', () => {
  it('lists the 9 first-batch candidates, all https', () => {
    expect(probe.CANDIDATES.map((c) => c.slug)).toEqual([
      'notion',
      'linear',
      'atlassian',
      'sentry',
      'asana',
      'hubspot',
      'canva',
      'stripe',
      'github',
    ]);
    for (const c of probe.CANDIDATES) expect(c.url).toMatch(/^https:\/\//);
  });

  it('parses WWW-Authenticate challenges', () => {
    const [bearer] = probe.parseWwwAuthenticate(
      'Bearer realm="OAuth", resource_metadata="https://x.test/.well-known/oauth-protected-resource/mcp", scope="read write"',
    );
    expect(bearer?.scheme).toBe('Bearer');
    expect(bearer?.params).toMatchObject({ realm: 'OAuth', scope: 'read write' });
    expect(bearer?.params.resource_metadata).toBe(
      'https://x.test/.well-known/oauth-protected-resource/mcp',
    );
    expect(probe.parseWwwAuthenticate(null)).toEqual([]);
  });

  it('builds RFC 9728 / RFC 8414 well-known URLs with path insertion', () => {
    expect(probe.protectedResourceUrls('https://h.test/v1/mcp')).toEqual([
      'https://h.test/.well-known/oauth-protected-resource/v1/mcp',
      'https://h.test/.well-known/oauth-protected-resource',
    ]);
    expect(probe.protectedResourceUrls('https://h.test')).toEqual([
      'https://h.test/.well-known/oauth-protected-resource',
    ]);
    expect(probe.authorizationServerUrls('https://a.test/tenant')[0]).toBe(
      'https://a.test/.well-known/oauth-authorization-server/tenant',
    );
  });

  it('walks 401 -> PRM -> AS metadata and classifies CIMD / DCR / none, never sending credentials', async () => {
    const seen: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
    const fakeFetch = async (url: string, init: RequestInit = {}) => {
      seen.push({
        url,
        method: init.method ?? 'GET',
        headers: (init.headers ?? {}) as Record<string, string>,
      });
      if (url === 'https://mcp.v.test/mcp') {
        return new Response('', {
          status: 401,
          headers: {
            'www-authenticate': 'Bearer resource_metadata="https://mcp.v.test/prm", scope="a"',
          },
        });
      }
      if (url === 'https://mcp.v.test/prm') {
        return json({
          resource: 'https://mcp.v.test/mcp',
          authorization_servers: ['https://auth.v.test'],
          scopes_supported: ['a'],
        });
      }
      if (url === 'https://auth.v.test/.well-known/oauth-authorization-server') {
        return json({
          issuer: 'https://auth.v.test',
          registration_endpoint: 'https://auth.v.test/register',
          client_id_metadata_document_supported: true,
          code_challenge_methods_supported: ['S256'],
          authorization_response_iss_parameter_supported: true,
          revocation_endpoint: 'https://auth.v.test/revoke',
        });
      }
      return new Response('nope', { status: 404 });
    };
    const report = await probe.probeCandidate(
      { slug: 'v', url: 'https://mcp.v.test/mcp' },
      { fetch: fakeFetch },
    );
    expect(report.initialize.status).toBe(401);
    expect(report.initialize.challenge.resource_metadata).toBe('https://mcp.v.test/prm');
    expect(report.prm.found).toBe(true);
    expect(report.authorizationServer.found).toBe(true);
    expect(report.autoRegistration).toBe('cimd');
    expect(report.pkceS256).toBe(true);
    expect(report.authorizationServer.authorization_response_iss_parameter_supported).toBe(true);
    for (const request of seen) {
      expect(Object.keys(request.headers).map((h) => h.toLowerCase())).not.toContain(
        'authorization',
      );
      // Only GET discovery requests and the single unauthenticated initialize POST.
      if (request.method === 'POST') expect(request.url).toBe('https://mcp.v.test/mcp');
    }
    expect(seen.filter((r) => r.method === 'POST')).toHaveLength(1);
  });

  it('records network failures instead of throwing, and refuses non-https redirects', async () => {
    const failing = await probe.probeCandidate(
      { slug: 'x', url: 'https://x.test/mcp' },
      {
        fetch: async () => {
          throw new Error('boom');
        },
      },
    );
    expect(failing.initialize.error).toBe('boom');
    expect(failing.autoRegistration).toBe('unknown');
    const redirect = await probe.probeCandidate(
      { slug: 'x', url: 'https://x.test/mcp' },
      {
        fetch: async () =>
          new Response('', { status: 302, headers: { location: 'http://evil.test/' } }),
      },
    );
    expect(redirect.initialize.error).toMatch(/non-https/);
  });

  it('classifies DCR-only and none', () => {
    expect(probe.autoRegistrationOf({ registration_endpoint: 'https://a/register' })).toBe('dcr');
    expect(probe.autoRegistrationOf({ registration_endpoint: null })).toBe('none');
    expect(probe.autoRegistrationOf(null)).toBe('unknown');
  });
});
