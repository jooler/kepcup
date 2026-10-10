import { afterEach, describe, expect, it } from 'vitest';
import { endpointProblem, runAuthorization } from '../src/io/auth.js';
import { validate } from '../src/validate.js';
import { find, labels, startHarness, type Harness } from './support.js';

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

async function runAuth(h: Harness, extra: Record<string, unknown> = {}, manifest = h.manifest()) {
  return validate({
    target: h.serve(manifest),
    auth: true,
    timeoutMs: 5000,
    clientIdUrl: h.cimdUrl,
    openBrowser: h.openBrowser,
    ...extra,
  });
}

describe('validate --auth (CIMD identity)', () => {
  it('authorizes once, lists the tools with the token and revokes it', async () => {
    harness = await startHarness({ cimdSupported: true });
    const report = await runAuth(harness);

    expect(labels(report, 'error')).toEqual([]);
    expect(report.exitCode).toBe(0);
    for (const id of [
      'auth.cimd-document',
      'auth.client',
      'auth.callback-iss',
      'auth.flow',
      'auth.token',
      'auth.refresh-token',
      'auth.revoke',
      'mcp.session',
      'tools.list',
    ]) {
      expect(find(report, id)?.severity, id).toBe('info');
    }
    expect(find(report, 'tools.risk-summary')?.message).toContain(
      '1 read, 1 write and 1 destructive',
    );

    // The authorization server saw KepCup's CIMD identity, not a registration.
    expect(harness.fake.authorizeRequests).toHaveLength(1);
    expect(harness.fake.authorizeRequests[0]).toMatchObject({
      clientSource: 'cimd',
      outcome: 'redirected',
    });
    expect(harness.fake.authorizeRequests[0]?.params.client_id).toBe(harness.cimdUrl);
    expect(harness.fake.authorizeRequests[0]?.params.code_challenge_method).toBe('S256');
    expect(harness.fake.authorizeRequests[0]?.params.resource).toBe(harness.fake.mcpUrl);
    expect(harness.fake.registrations).toHaveLength(0);
    expect(harness.fake.tokenRequests).toHaveLength(1);
    // tools/list was called with a bearer token; the token was revoked afterwards.
    const authed = harness.fake.mcpRequests.filter((r) => r.token !== null);
    expect(authed.some((r) => r.rpcMethods.includes('tools/list'))).toBe(true);
    expect(harness.fake.revokeRequests).toHaveLength(1);
    // The browser saw a success page; no token ends up in the report.
    const browser = await Promise.all(harness.browsers);
    expect(browser[0]?.callbackStatus).toBe(200);
    expect(browser[0]?.callbackBody).toContain('Authorized');
    const text = JSON.stringify(report);
    for (const request of authed) expect(text).not.toContain(request.token as string);
  });

  it('registers dynamically when CIMD is not offered', async () => {
    harness = await startHarness({ cimdSupported: false, dcrEnabled: true });
    const report = await runAuth(harness);
    expect(labels(report, 'error')).toEqual([]);
    expect(harness.fake.registrations).toHaveLength(1);
    expect(harness.fake.authorizeRequests[0]?.clientSource).toBe('dcr');
    expect(find(report, 'auth.client')?.message).toContain('dynamic client registration');
  });

  it('fails the flow when the user denies access', async () => {
    harness = await startHarness({ cimdSupported: true, authorizeError: 'access_denied' });
    const report = await runAuth(harness);
    expect(labels(report, 'error')).toEqual(['auth.flow']);
    expect(find(report, 'auth.flow')?.message).toContain('denied');
    expect(find(report, 'tools.skipped')).toBeDefined();
    expect(report.exitCode).toBe(1);
    expect(harness.fake.tokenRequests).toHaveLength(0);
  });

  it('rejects a missing or wrong iss (RFC 9207)', async () => {
    harness = await startHarness({ cimdSupported: true, issMode: 'omit' });
    const omitted = await runAuth(harness);
    expect(labels(omitted, 'error')).toEqual(['auth.callback-iss', 'auth.flow']);
    expect(harness.fake.tokenRequests).toHaveLength(0);
    harness.fake.configure({ issMode: 'wrong' });
    const wrong = await runAuth(harness);
    expect(labels(wrong, 'error')).toEqual(['auth.callback-iss', 'auth.flow']);
    expect(harness.fake.tokenRequests).toHaveLength(0);
  });

  it('warns about a missing refresh token and a failing revocation endpoint', async () => {
    harness = await startHarness({
      cimdSupported: true,
      issueRefreshToken: false,
      revokeStatus: 500,
    });
    const report = await runAuth(harness);
    expect(labels(report, 'error')).toEqual([]);
    expect(labels(report, 'warn')).toEqual(
      expect.arrayContaining(['auth.refresh-token', 'auth.revoke']),
    );
  });

  it('times out when nobody completes the browser step', async () => {
    harness = await startHarness({ cimdSupported: true });
    const report = await runAuth(harness, { openBrowser: () => undefined, callbackTimeoutMs: 150 });
    expect(labels(report, 'error')).toEqual(['auth.flow']);
    expect(find(report, 'auth.flow')?.message).toContain('Timed out');
    expect(find(report, 'tools.skipped')).toBeDefined();
  });

  it('stops before opening a browser when the client identity document is unusable', async () => {
    harness = await startHarness({ cimdSupported: true });
    const report = await runAuth(harness, { clientIdUrl: `${harness.files.url}/missing.json` });
    expect(labels(report, 'error')).toEqual(['auth.cimd-document', 'auth.flow']);
    expect(harness.fake.authorizeRequests).toHaveLength(0);
    expect(harness.browsers).toHaveLength(0);
  });

  it('skips the flow (with an error) when the server offers neither CIMD nor DCR', async () => {
    harness = await startHarness({ cimdSupported: false, dcrEnabled: false });
    const report = await runAuth(harness);
    expect(labels(report, 'error')).toEqual(['remote.client-registration', 'auth.flow']);
    expect(harness.browsers).toHaveLength(0);
  });

  it('reports a failing authorization server discovery instead of starting the flow', async () => {
    harness = await startHarness({ discovery: 'none' });
    const report = await runAuth(harness);
    expect(labels(report, 'error')).toEqual(['remote.as-metadata', 'auth.flow']);
  });

  it('does nothing interactive when the server is open', async () => {
    harness = await startHarness({ requireAuth: false });
    const report = await runAuth(harness);
    expect(report.exitCode).toBe(0);
    expect(harness.browsers).toHaveLength(0);
    expect(report.checks.some((c) => c.id.startsWith('auth.'))).toBe(false);
  });
});

describe('--auth never acts on unsafe endpoints', () => {
  it.each([
    'file:///etc/passwd',
    'smb://evil.example/share',
    'javascript:alert(1)',
    'myapp://authorize?x=1',
    'http://evil.example/authorize',
    'ftp://evil.example/authorize',
  ])('refuses to open an authorization_endpoint of %s', async (endpoint) => {
    harness = await startHarness({ cimdSupported: true, authorizationEndpoint: () => endpoint });
    const opened: string[] = [];
    const report = await runAuth(harness, { openBrowser: (url: string) => void opened.push(url) });
    expect(opened).toEqual([]);
    expect(harness.fake.authorizeRequests).toHaveLength(0);
    expect(harness.fake.tokenRequests).toHaveLength(0);
    expect(labels(report, 'error')).toContain('auth.flow');
    // pi-mcp's own metadata parser already rejects some schemes at discovery; either way nothing runs.
    expect(find(report, 'auth.flow')?.message).toMatch(
      /nothing was opened|could not be discovered/,
    );
    expect(report.exitCode).toBe(1);
  });

  it('endpointProblem: https always, http only on loopback for a loopback server', () => {
    expect(endpointProblem('https://auth.example.com/authorize', false)).toBeNull();
    expect(endpointProblem('https://auth.example.com/authorize', true)).toBeNull();
    expect(endpointProblem('http://127.0.0.1:1/authorize', true)).toBeNull();
    expect(endpointProblem('http://127.0.0.1:1/authorize', false)).toContain('plaintext');
    expect(endpointProblem('http://evil.example/authorize', true)).toContain('plaintext');
    expect(endpointProblem('file:///x', true)).toContain('file:');
    expect(endpointProblem('javascript:alert(1)', true)).toContain('javascript:');
    expect(endpointProblem('not a url', true)).toContain('not a valid URL');
  });

  it.each([
    ['token_endpoint', { token_endpoint: 'http://evil.example/token' }],
    [
      'registration_endpoint',
      { registration_endpoint: 'file:///etc/passwd', client_id_metadata_document_supported: false },
    ],
  ])('refuses an unsafe %s before any request or browser launch', async (name, patch) => {
    const opened: string[] = [];
    let requests = 0;
    const result = await runAuthorization({
      serverUrl: 'https://mcp.example.com/mcp',
      challenge: {},
      prm: null,
      authorizationServerUrl: 'https://auth.example.com',
      metadata: {
        issuer: 'https://auth.example.com',
        authorization_endpoint: 'https://auth.example.com/authorize',
        token_endpoint: 'https://auth.example.com/token',
        response_types_supported: ['code'],
        client_id_metadata_document_supported: true,
        ...patch,
      },
      clientIdUrl: 'https://kepcup.example/client.json',
      fetch: async () => {
        requests += 1;
        throw new Error('no network expected');
      },
      openBrowser: (url) => void opened.push(url),
      callbackTimeoutMs: 100,
      log: () => undefined,
    });
    expect(result.accessToken).toBeNull();
    expect(opened).toEqual([]);
    expect(requests).toBe(0);
    expect(find(result, 'auth.flow')?.message).toContain(name);
  });
});
