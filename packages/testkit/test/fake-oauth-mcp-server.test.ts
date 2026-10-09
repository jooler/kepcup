import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { startFileServer, publishCimdDocument, type TestFileServer } from '../src/file-server.js';
import {
  simulateBrowser,
  startFakeOAuthMcpServer,
  type FakeOAuthMcpOptions,
  type FakeOAuthMcpServer,
} from '../src/fake-oauth-mcp-server.js';

/**
 * Self-test of the fake OAuth + MCP server (todo/connected-apps.md §4.1): every
 * switch the core tests will rely on gets one case here, so a core failure
 * can be told apart from a fake that does not do what its option says.
 */

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function start(options?: FakeOAuthMcpOptions): Promise<FakeOAuthMcpServer> {
  const server = await startFakeOAuthMcpServer(options);
  cleanups.push(() => server.stop());
  return server;
}

async function startFiles(): Promise<TestFileServer> {
  const files = await startFileServer({});
  cleanups.push(() => files.stop());
  return files;
}

/** Stands in for KepCup's loopback callback server. */
async function startCallback(): Promise<{ url: string; hits: URL[] }> {
  const hits: URL[] = [];
  const server: Server = createServer((req, res) => {
    hits.push(new URL(req.url ?? '/', 'http://127.0.0.1'));
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('connected');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/callback`, hits };
}

const CLIENT = { clientId: 'kepcup-test', redirectUris: ['http://127.0.0.1/callback'] };

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

interface AuthorizeInput {
  clientId?: string;
  redirectUri: string;
  scope?: string;
  resource?: string;
  state?: string;
  challenge?: string;
  extra?: Record<string, string>;
}

function authorizeUrl(server: FakeOAuthMcpServer, input: AuthorizeInput): string {
  const url = new URL(server.authorizationEndpoint);
  const params: Record<string, string | undefined> = {
    response_type: 'code',
    client_id: input.clientId ?? CLIENT.clientId,
    redirect_uri: input.redirectUri,
    state: input.state ?? 'state-1',
    code_challenge: input.challenge,
    code_challenge_method: 'S256',
    scope: input.scope,
    resource: input.resource,
    ...input.extra,
  };
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

async function tokenRequest(
  server: FakeOAuthMcpServer,
  params: Record<string, string>,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(server.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(params),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** Browser → callback → token exchange; returns the token response and the PKCE verifier used. */
async function authorizeAndExchange(
  server: FakeOAuthMcpServer,
  input: { scope?: string; resource?: string; clientId?: string; exchangeResource?: string | null } = {},
): Promise<{ status: number; body: Record<string, unknown>; code: string; verifier: string; redirectUri: string }> {
  const callback = await startCallback();
  const { verifier, challenge } = pkce();
  const result = await simulateBrowser(
    authorizeUrl(server, {
      redirectUri: callback.url,
      challenge,
      ...(input.scope !== undefined ? { scope: input.scope } : {}),
      ...(input.resource !== undefined ? { resource: input.resource } : {}),
      ...(input.clientId !== undefined ? { clientId: input.clientId } : {}),
    }),
  );
  expect(result.callbackStatus).toBe(200);
  const code = callback.hits[0]?.searchParams.get('code') ?? '';
  const resource = input.exchangeResource === undefined ? input.resource : input.exchangeResource;
  const exchange = await tokenRequest(server, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: callback.url,
    client_id: input.clientId ?? CLIENT.clientId,
    code_verifier: verifier,
    ...(resource !== undefined && resource !== null ? { resource } : {}),
  });
  return { ...exchange, code, verifier, redirectUri: callback.url };
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
};

async function rpc(
  server: FakeOAuthMcpServer,
  body: unknown,
  opts: { token?: string; sessionId?: string } = {},
): Promise<Response> {
  return fetch(server.mcpUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(opts.token !== undefined ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.sessionId !== undefined ? { 'mcp-session-id': opts.sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function mcpClient(server: FakeOAuthMcpServer, accessToken: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.mcpUrl), {
      requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
    }),
  );
  cleanups.push(() => client.close());
  return client;
}

async function getJson(url: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('resource server: challenge and protected resource metadata', () => {
  it('answers 401 with resource_metadata and scope in WWW-Authenticate', async () => {
    const server = await start({ challengeScope: 'files:read' });
    const response = await rpc(server, INITIALIZE);
    expect(response.status).toBe(401);
    const header = response.headers.get('www-authenticate') ?? '';
    expect(header).toContain(`resource_metadata="${server.url}/.well-known/oauth-protected-resource/mcp"`);
    expect(header).toContain('scope="files:read"');
    expect(header).not.toContain('error=');
  });

  it('can omit the scope and the resource_metadata parameters', async () => {
    const server = await start({ challengeResourceMetadata: false });
    const header = (await rpc(server, INITIALIZE)).headers.get('www-authenticate');
    expect(header).toBe('Bearer');
  });

  it('serves PRM on both well-known paths with configurable servers and scopes', async () => {
    const server = await start({
      prmAuthorizationServers: ['https://as.example'],
      prmScopesSupported: ['a', 'b'],
    });
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const { status, body } = await getJson(`${server.url}${path}`);
      expect(status).toBe(200);
      expect(body).toMatchObject({
        resource: server.mcpUrl,
        authorization_servers: ['https://as.example'],
        scopes_supported: ['a', 'b'],
      });
    }
  });

  it('defaults PRM authorization_servers to its own issuer and can be switched off', async () => {
    const server = await start();
    expect((await getJson(server.resourceMetadataUrl)).body).toMatchObject({
      authorization_servers: [server.issuer],
    });
    server.configure({ prmEnabled: false });
    expect((await getJson(server.resourceMetadataUrl)).status).toBe(404);
  });

  it('requireAuth=false serves /mcp without a token', async () => {
    const server = await start({ requireAuth: false });
    expect((await rpc(server, INITIALIZE)).status).toBe(200);
  });
});

describe('resource server: bearer validation', () => {
  it('serves tools to a valid token and records the call with token and scopes', async () => {
    const server = await start();
    const issued = server.issueToken({ scope: ['files:read'] });
    const client = await mcpClient(server, issued.accessToken);
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(['echo']);
    const result = await client.callTool({ name: 'echo', arguments: { hello: 'world' } });
    expect(result.content).toEqual([{ type: 'text', text: 'echo:{"hello":"world"}' }]);
    expect(server.toolCalls).toEqual([
      { name: 'echo', args: { hello: 'world' }, token: issued.accessToken, scopes: ['files:read'] },
    ]);
    expect(server.mcpRequests.some((r) => r.rpcMethods.includes('tools/list') && r.status === 200)).toBe(true);
  });

  it('rejects unknown, expired and revoked tokens with invalid_token', async () => {
    const server = await start();
    const unknown = await rpc(server, INITIALIZE, { token: 'nope' });
    expect(unknown.status).toBe(401);
    expect(unknown.headers.get('www-authenticate')).toContain('error="invalid_token"');

    const expiring = server.issueToken();
    expect((await rpc(server, INITIALIZE, { token: expiring.accessToken })).status).toBe(200);
    server.expireToken(expiring.accessToken);
    expect((await rpc(server, INITIALIZE, { token: expiring.accessToken })).status).toBe(401);

    const revoked = server.issueToken();
    server.revokeToken(revoked.accessToken);
    expect((await rpc(server, INITIALIZE, { token: revoked.accessToken })).status).toBe(401);
  });

  it('expires tokens by the configured clock', async () => {
    let now = 1_000_000;
    const server = await start({ now: () => now });
    const issued = server.issueToken({ expiresIn: 30 });
    expect(server.isAccessTokenValid(issued.accessToken)).toBe(true);
    now += 31_000;
    expect(server.isAccessTokenValid(issued.accessToken)).toBe(false);
  });

  it('validates the audience of the token', async () => {
    const server = await start();
    const foreign = server.issueToken({ audience: 'http://127.0.0.1:1/other' });
    expect((await rpc(server, INITIALIZE, { token: foreign.accessToken })).status).toBe(401);

    const none = server.issueToken({ audience: null });
    expect((await rpc(server, INITIALIZE, { token: none.accessToken })).status).toBe(200);
    server.configure({ requireAudience: true });
    expect((await rpc(server, INITIALIZE, { token: none.accessToken })).status).toBe(401);

    server.configure({ validateAudience: false, requireAudience: false });
    expect((await rpc(server, INITIALIZE, { token: foreign.accessToken })).status).toBe(200);
  });

  it('answers 403 insufficient_scope for a tool whose scopes the token lacks', async () => {
    const server = await start({
      tools: [{ name: 'write_file', requiredScopes: ['files:write', 'files:read'] }, { name: 'ping' }],
    });
    const weak = server.issueToken({ scope: ['files:read'] });
    const init = await rpc(server, INITIALIZE, { token: weak.accessToken });
    const sessionId = init.headers.get('mcp-session-id') ?? '';
    const call = (name: string, token: string) =>
      rpc(
        server,
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: {} } },
        { token, sessionId },
      );

    const denied = await call('write_file', weak.accessToken);
    expect(denied.status).toBe(403);
    const header = denied.headers.get('www-authenticate') ?? '';
    expect(header).toContain('error="insufficient_scope"');
    expect(header).toContain('scope="files:write files:read"');
    expect(header).toContain('resource_metadata=');
    expect((await call('ping', weak.accessToken)).status).toBe(200);

    const strong = server.issueToken({ scope: ['files:read', 'files:write'] });
    expect((await call('write_file', strong.accessToken)).status).toBe(200);
  });

  it('changes tools at runtime, sends list_changed and passes annotations through', async () => {
    const server = await start();
    const issued = server.issueToken();
    const client = new Client({ name: 'test', version: '0' });
    let notified = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      notified += 1;
    });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(server.mcpUrl), {
        requestInit: { headers: { authorization: `Bearer ${issued.accessToken}` } },
      }),
    );
    cleanups.push(() => client.close());

    // The client opens its notification stream right after connecting; keep
    // changing the tool until the first notification arrives.
    const deadline = Date.now() + 5000;
    while (notified === 0 && Date.now() < deadline) {
      await server.addTool({
        name: 'delete_all',
        annotations: { destructiveHint: true, readOnlyHint: false, title: 'Delete all' },
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(notified).toBeGreaterThan(0);
    expect(server.toolsListChangedCount).toBeGreaterThan(0);

    const tools = (await client.listTools()).tools;
    expect(tools.map((tool) => tool.name)).toEqual(['echo', 'delete_all']);
    expect(tools[1]?.annotations).toEqual({ destructiveHint: true, readOnlyHint: false, title: 'Delete all' });

    await server.removeTool('delete_all');
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['echo']);
  });

  it('forgets sessions on dropSessions (old session id answers 404)', async () => {
    const server = await start();
    const { accessToken } = server.issueToken();
    const init = await rpc(server, INITIALIZE, { token: accessToken });
    const sessionId = init.headers.get('mcp-session-id') ?? '';
    await server.dropSessions();
    const again = await rpc(server, { jsonrpc: '2.0', id: 3, method: 'tools/list' }, { token: accessToken, sessionId });
    expect(again.status).toBe(404);
  });
});

describe('authorization server: discovery', () => {
  it('serves the OAuth path only by default', async () => {
    const server = await start();
    const oauth = await getJson(`${server.url}/.well-known/oauth-authorization-server`);
    expect(oauth.status).toBe(200);
    expect(oauth.body).toMatchObject({
      issuer: server.issuer,
      authorization_endpoint: server.authorizationEndpoint,
      token_endpoint: server.tokenEndpoint,
      revocation_endpoint: server.revocationEndpoint,
      code_challenge_methods_supported: ['S256'],
      client_id_metadata_document_supported: false,
      authorization_response_iss_parameter_supported: true,
    });
    expect(oauth.body).not.toHaveProperty('registration_endpoint');
    expect((await getJson(`${server.url}/.well-known/openid-configuration`)).status).toBe(404);
  });

  it('can serve OIDC discovery only, both, or none', async () => {
    const server = await start({ discovery: 'oidc' });
    expect((await getJson(`${server.url}/.well-known/oauth-authorization-server`)).status).toBe(404);
    const oidc = await getJson(`${server.url}/.well-known/openid-configuration`);
    expect(oidc.status).toBe(200);
    expect(oidc.body).toMatchObject({ issuer: server.issuer, token_endpoint: server.tokenEndpoint });

    server.configure({ discovery: 'both' });
    expect((await getJson(`${server.url}/.well-known/oauth-authorization-server`)).status).toBe(200);
    expect((await getJson(`${server.url}/.well-known/openid-configuration`)).status).toBe(200);

    server.configure({ discovery: 'none' });
    expect((await getJson(`${server.url}/.well-known/oauth-authorization-server`)).status).toBe(404);
    expect((await getJson(`${server.url}/.well-known/openid-configuration`)).status).toBe(404);
  });

  it('reflects the CIMD, DCR, revocation, iss and scope switches in metadata', async () => {
    const server = await start({
      cimdSupported: true,
      dcrEnabled: true,
      revocationSupported: false,
      issParameterSupported: false,
      scopesSupported: ['a'],
      codeChallengeMethodsSupported: ['plain'],
    });
    const { body } = await getJson(`${server.url}/.well-known/oauth-authorization-server`);
    expect(body).toMatchObject({
      client_id_metadata_document_supported: true,
      registration_endpoint: server.registrationEndpoint,
      authorization_response_iss_parameter_supported: false,
      scopes_supported: ['a'],
      code_challenge_methods_supported: ['plain'],
    });
    expect(body).not.toHaveProperty('revocation_endpoint');
  });

  it('records every HTTP request it served', async () => {
    const server = await start();
    await getJson(server.resourceMetadataUrl);
    await getJson(`${server.url}/.well-known/openid-configuration`);
    expect(server.requests).toEqual([
      { method: 'GET', path: '/.well-known/oauth-protected-resource/mcp', status: 200 },
      { method: 'GET', path: '/.well-known/openid-configuration', status: 404 },
    ]);
    server.resetRecords();
    expect(server.requests).toEqual([]);
  });
});

describe('authorization server: /authorize', () => {
  it('redirects to redirect_uri with code, state and iss; simulateBrowser follows exactly that hop', async () => {
    const server = await start({ preregisteredClients: [CLIENT] });
    const callback = await startCallback();
    const { challenge } = pkce();
    const result = await server.simulateBrowser(
      authorizeUrl(server, { redirectUri: callback.url, challenge, state: 'abc', scope: 'a b' }),
    );
    expect(result.authorizeStatus).toBe(302);
    expect(result.callbackStatus).toBe(200);
    expect(result.callbackBody).toBe('connected');
    const hit = callback.hits[0];
    expect(callback.hits).toHaveLength(1);
    expect(hit?.pathname).toBe('/callback');
    expect(hit?.searchParams.get('state')).toBe('abc');
    expect(hit?.searchParams.get('iss')).toBe(server.issuer);
    expect(hit?.searchParams.get('code')).toBeTruthy();
    expect(server.authorizeRequests[0]).toMatchObject({
      clientSource: 'preregistered',
      outcome: 'redirected',
      params: { scope: 'a b', state: 'abc' },
    });
  });

  it('can omit iss or send a wrong iss', async () => {
    const server = await start({ preregisteredClients: [CLIENT], issMode: 'omit' });
    const callback = await startCallback();
    const url = authorizeUrl(server, { redirectUri: callback.url, challenge: pkce().challenge });
    await simulateBrowser(url);
    expect(callback.hits[0]?.searchParams.has('iss')).toBe(false);
    expect(callback.hits[0]?.searchParams.has('code')).toBe(true);

    server.configure({ issMode: 'wrong' });
    await simulateBrowser(url);
    const wrong = callback.hits[1]?.searchParams.get('iss');
    expect(wrong).toBeTruthy();
    expect(wrong).not.toBe(server.issuer);
  });

  it('can answer error=access_denied with state and iss', async () => {
    const server = await start({ preregisteredClients: [CLIENT], authorizeError: 'access_denied' });
    const callback = await startCallback();
    const result = await simulateBrowser(
      authorizeUrl(server, { redirectUri: callback.url, challenge: pkce().challenge, state: 's9' }),
    );
    expect(result.callbackStatus).toBe(200);
    const params = callback.hits[0]?.searchParams;
    expect(params?.get('error')).toBe('access_denied');
    expect(params?.get('state')).toBe('s9');
    expect(params?.get('iss')).toBe(server.issuer);
    expect(params?.has('code')).toBe(false);
    expect(server.authorizeRequests[0]).toMatchObject({ outcome: 'error-redirect', error: 'access_denied' });
  });

  it('matches redirect_uri exactly or loopback-port-agnostic', async () => {
    const server = await start({ preregisteredClients: [CLIENT], redirectMatch: 'exact' });
    const callback = await startCallback();
    const url = authorizeUrl(server, { redirectUri: callback.url, challenge: pkce().challenge });

    const strict = await simulateBrowser(url);
    expect(strict.authorizeStatus).toBe(400);
    expect(strict.callbackStatus).toBeNull();
    expect(callback.hits).toHaveLength(0);
    expect(server.authorizeRequests[0]).toMatchObject({ outcome: 'rejected', error: 'invalid_request' });

    server.configure({ redirectMatch: 'loopback' });
    expect((await simulateBrowser(url)).callbackStatus).toBe(200);

    // The loopback rule never applies to other hosts or paths.
    const other = await simulateBrowser(
      authorizeUrl(server, { redirectUri: 'http://127.0.0.1:9/elsewhere', challenge: pkce().challenge }),
    );
    expect(other.authorizeStatus).toBe(400);
  });

  it('accepts an exactly registered non-loopback redirect', async () => {
    const server = await start({
      preregisteredClients: [{ clientId: 'big', redirectUris: ['https://app.example/cb'] }],
      redirectMatch: 'exact',
    });
    const response = await fetch(
      authorizeUrl(server, { clientId: 'big', redirectUri: 'https://app.example/cb', challenge: pkce().challenge }),
      { redirect: 'manual' },
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('https://app.example/cb?');
  });

  it('rejects unknown clients and requests without S256 PKCE', async () => {
    const server = await start({ preregisteredClients: [CLIENT] });
    const callback = await startCallback();
    const unknown = await simulateBrowser(
      authorizeUrl(server, { clientId: 'stranger', redirectUri: callback.url, challenge: pkce().challenge }),
    );
    expect(unknown.authorizeStatus).toBe(400);
    expect(unknown.authorizeBody).toContain('invalid_client');

    await simulateBrowser(authorizeUrl(server, { redirectUri: callback.url }));
    expect(callback.hits[0]?.searchParams.get('error')).toBe('invalid_request');
  });
});

describe('authorization server: client identity', () => {
  it('registers clients over DCR, records application_type and redirect_uris, then authorizes them', async () => {
    const server = await start({ dcrEnabled: true });
    const callback = await startCallback();
    const response = await fetch(server.registrationEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'KepCup',
        application_type: 'native',
        redirect_uris: [callback.url],
        token_endpoint_auth_method: 'none',
      }),
    });
    expect(response.status).toBe(201);
    const registered = (await response.json()) as { client_id: string };
    expect(server.registrations).toEqual([
      expect.objectContaining({
        clientId: registered.client_id,
        applicationType: 'native',
        redirectUris: [callback.url],
      }),
    ]);
    expect(server.registeredClientIds()).toEqual([registered.client_id]);

    const result = await simulateBrowser(
      authorizeUrl(server, { clientId: registered.client_id, redirectUri: callback.url, challenge: pkce().challenge }),
    );
    expect(result.callbackStatus).toBe(200);
    expect(server.authorizeRequests[0]?.clientSource).toBe('dcr');
  });

  it('refuses DCR when disabled and invalid registrations when enabled', async () => {
    const server = await start();
    const post = (body: unknown) =>
      fetch(server.registrationEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect((await post({ redirect_uris: ['http://127.0.0.1/cb'] })).status).toBe(404);
    server.configure({ dcrEnabled: true });
    expect((await post({ client_name: 'no redirects' })).status).toBe(400);
    expect(server.registrations).toHaveLength(0);
  });

  it('fetches a CIMD client_id URL and validates client_id and redirect_uris', async () => {
    const files = await startFiles();
    const server = await start({ cimdSupported: true });
    const callback = await startCallback();
    const { clientId } = publishCimdDocument(files);
    const url = authorizeUrl(server, { clientId, redirectUri: callback.url, challenge: pkce().challenge });

    expect((await simulateBrowser(url)).callbackStatus).toBe(200);
    expect(server.cimdFetches).toEqual([{ url: clientId, ok: true }]);
    expect(server.authorizeRequests[0]?.clientSource).toBe('cimd');

    // The redirect must be in the document (loopback rule: any port of the listed form).
    const foreign = await simulateBrowser(
      authorizeUrl(server, { clientId, redirectUri: 'http://127.0.0.1:1/other', challenge: pkce().challenge }),
    );
    expect(foreign.authorizeStatus).toBe(400);

    // The document's client_id must equal the URL it was fetched from.
    const bad = publishCimdDocument(files, { path: 'bad.json', clientIdInDocument: 'http://elsewhere/x' });
    const mismatch = await simulateBrowser(
      authorizeUrl(server, { clientId: bad.clientId, redirectUri: callback.url, challenge: pkce().challenge }),
    );
    expect(mismatch.authorizeStatus).toBe(400);
    expect(server.cimdFetches.at(-1)).toMatchObject({ url: bad.clientId, ok: false });

    const missing = await simulateBrowser(
      authorizeUrl(server, { clientId: `${files.url}/none.json`, redirectUri: callback.url, challenge: pkce().challenge }),
    );
    expect(missing.authorizeStatus).toBe(400);
  });

  it('treats a URL client_id as unknown when CIMD is off', async () => {
    const files = await startFiles();
    const server = await start();
    const callback = await startCallback();
    const { clientId } = publishCimdDocument(files);
    const result = await simulateBrowser(
      authorizeUrl(server, { clientId, redirectUri: callback.url, challenge: pkce().challenge }),
    );
    expect(result.authorizeStatus).toBe(400);
    expect(server.cimdFetches).toHaveLength(0);
    expect(files.requestsServed()).toBe(0);
  });

  it('serves the CIMD document through file-server with a JSON content type', async () => {
    const files = await startFiles();
    const { clientId, document } = publishCimdDocument(files, { extra: { client_name: 'Custom' } });
    const response = await fetch(clientId);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ ...document, client_name: 'Custom' });
  });
});

describe('authorization server: /token', () => {
  it('exchanges a code with PKCE and returns a working access token', async () => {
    const server = await start({ preregisteredClients: [CLIENT], expiresIn: 600 });
    const resource = server.mcpUrl;
    const exchange = await authorizeAndExchange(server, { scope: 'files:read', resource });
    expect(exchange.status).toBe(200);
    expect(exchange.body).toMatchObject({
      token_type: 'Bearer',
      expires_in: 600,
      scope: 'files:read',
    });
    const accessToken = exchange.body.access_token as string;
    expect(server.isAccessTokenValid(accessToken)).toBe(true);
    expect(server.isRefreshTokenValid(exchange.body.refresh_token as string)).toBe(true);
    expect((await rpc(server, INITIALIZE, { token: accessToken })).status).toBe(200);
    expect(server.tokenRequests[0]).toMatchObject({
      status: 200,
      params: { grant_type: 'authorization_code', resource },
    });
  });

  it('rejects a wrong PKCE verifier, a reused code and a mismatched redirect_uri with invalid_grant', async () => {
    const server = await start({ preregisteredClients: [CLIENT] });
    const first = await authorizeAndExchange(server);
    expect(first.status).toBe(200);
    const replay = await tokenRequest(server, {
      grant_type: 'authorization_code',
      code: first.code,
      redirect_uri: first.redirectUri,
      client_id: CLIENT.clientId,
      code_verifier: first.verifier,
    });
    expect(replay).toMatchObject({ status: 400, body: { error: 'invalid_grant' } });

    const callback = await startCallback();
    const { challenge } = pkce();
    await simulateBrowser(authorizeUrl(server, { redirectUri: callback.url, challenge }));
    const code = callback.hits[0]?.searchParams.get('code') ?? '';
    const wrongVerifier = await tokenRequest(server, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: callback.url,
      client_id: CLIENT.clientId,
      code_verifier: pkce().verifier,
    });
    expect(wrongVerifier.body.error).toBe('invalid_grant');
    // A failed attempt burns the code.
    const retry = await tokenRequest(server, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: callback.url,
      client_id: CLIENT.clientId,
      code_verifier: pkce().verifier,
    });
    expect(retry.body.error).toBe('invalid_grant');
    expect(server.tokenRequests.at(-1)).toMatchObject({ status: 400, error: 'invalid_grant' });
  });

  it('requires the resource parameter when requireResource is on', async () => {
    const server = await start({ preregisteredClients: [CLIENT], requireResource: true });
    const without = await authorizeAndExchange(server, { exchangeResource: null });
    expect(without).toMatchObject({ status: 400, body: { error: 'invalid_target' } });
    const withResource = await authorizeAndExchange(server, { resource: server.mcpUrl });
    expect(withResource.status).toBe(200);
    const foreign = await authorizeAndExchange(server, { resource: 'http://127.0.0.1:1/other' });
    expect(foreign).toMatchObject({ status: 400, body: { error: 'invalid_target' } });
  });

  it('binds the token to the requested resource, so another audience is rejected by /mcp', async () => {
    const server = await start({ preregisteredClients: [CLIENT], validateAudience: false });
    const exchange = await authorizeAndExchange(server, { resource: 'http://127.0.0.1:1/other' });
    expect(exchange.status).toBe(200);
    server.configure({ validateAudience: true });
    expect((await rpc(server, INITIALIZE, { token: exchange.body.access_token as string })).status).toBe(401);
  });

  it('honours expiresIn (including omission), grantScope and issueRefreshToken', async () => {
    const server = await start({
      preregisteredClients: [CLIENT],
      expiresIn: null,
      grantScope: 'narrow',
      issueRefreshToken: false,
    });
    const { body } = await authorizeAndExchange(server, { scope: 'wide other' });
    expect(body).not.toHaveProperty('expires_in');
    expect(body).not.toHaveProperty('refresh_token');
    expect(body.scope).toBe('narrow');
  });

  it('rotates refresh tokens by default and invalidates the old one', async () => {
    const server = await start({ preregisteredClients: [CLIENT], expiresIn: 120 });
    const first = (await authorizeAndExchange(server, { scope: 'a b' })).body;
    const oldRefresh = first.refresh_token as string;
    const refreshed = await tokenRequest(server, {
      grant_type: 'refresh_token',
      refresh_token: oldRefresh,
      client_id: CLIENT.clientId,
    });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.refresh_token).toBeTruthy();
    expect(refreshed.body.refresh_token).not.toBe(oldRefresh);
    expect(refreshed.body.scope).toBe('a b');
    expect(refreshed.body.expires_in).toBe(120);
    expect(server.isRefreshTokenValid(oldRefresh)).toBe(false);
    const reuse = await tokenRequest(server, {
      grant_type: 'refresh_token',
      refresh_token: oldRefresh,
      client_id: CLIENT.clientId,
    });
    expect(reuse).toMatchObject({ status: 400, body: { error: 'invalid_grant' } });
  });

  it('keeps the refresh token stable and omits it from the response when rotation is off', async () => {
    const server = await start({ preregisteredClients: [CLIENT], rotateRefreshTokens: false });
    const refresh = (await authorizeAndExchange(server)).body.refresh_token as string;
    for (let i = 0; i < 2; i += 1) {
      const refreshed = await tokenRequest(server, {
        grant_type: 'refresh_token',
        refresh_token: refresh,
        client_id: CLIENT.clientId,
      });
      expect(refreshed.status).toBe(200);
      expect(refreshed.body).not.toHaveProperty('refresh_token');
    }
    expect(server.isRefreshTokenValid(refresh)).toBe(true);
  });

  it('refuses scope widening on refresh with invalid_scope', async () => {
    const server = await start({ preregisteredClients: [CLIENT] });
    const refresh = (await authorizeAndExchange(server, { scope: 'a' })).body.refresh_token as string;
    const wider = await tokenRequest(server, {
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: CLIENT.clientId,
      scope: 'a b',
    });
    expect(wider).toMatchObject({ status: 400, body: { error: 'invalid_scope' } });
  });

  it('injects invalid_grant for a number of requests, per grant type', async () => {
    const server = await start({ preregisteredClients: [CLIENT], rotateRefreshTokens: false });
    const refresh = server.issueToken({ clientId: CLIENT.clientId }).refreshToken as string;
    const params = { grant_type: 'refresh_token', refresh_token: refresh, client_id: CLIENT.clientId };

    server.failToken({ grantType: 'refresh_token', times: 2 });
    expect((await tokenRequest(server, params)).body.error).toBe('invalid_grant');
    expect((await tokenRequest(server, params)).body.error).toBe('invalid_grant');
    expect((await tokenRequest(server, params)).status).toBe(200);

    // A refresh-only failure leaves the code exchange alone.
    server.failToken({ grantType: 'refresh_token', times: Infinity });
    expect((await authorizeAndExchange(server)).status).toBe(200);
    server.clearTokenFailures();
    expect((await tokenRequest(server, params)).status).toBe(200);

    server.failToken({ error: 'server_error', status: 503 });
    expect(await tokenRequest(server, params)).toMatchObject({ status: 503, body: { error: 'server_error' } });
  });

  it('authenticates confidential preregistered clients with post or Basic credentials', async () => {
    const server = await start({
      preregisteredClients: [{ ...CLIENT, clientId: 'secret-client', clientSecret: 's3cret' }],
    });
    const refresh = server.issueToken({ clientId: 'secret-client' }).refreshToken as string;
    const params = { grant_type: 'refresh_token', refresh_token: refresh };

    expect(await tokenRequest(server, { ...params, client_id: 'secret-client' })).toMatchObject({
      status: 401,
      body: { error: 'invalid_client' },
    });
    const post = await tokenRequest(server, { ...params, client_id: 'secret-client', client_secret: 's3cret' });
    expect(post.status).toBe(200);
    const basic = await tokenRequest(server, { ...params, refresh_token: post.body.refresh_token as string }, {
      authorization: `Basic ${Buffer.from('secret-client:s3cret').toString('base64')}`,
    });
    expect(basic.status).toBe(200);
    expect(server.tokenRequests.at(-1)?.authorization).toMatch(/^Basic /);
  });

  it('rejects unsupported grant types', async () => {
    const server = await start();
    expect(await tokenRequest(server, { grant_type: 'password' })).toMatchObject({
      status: 400,
      body: { error: 'unsupported_grant_type' },
    });
  });
});

describe('authorization server: /revoke and manual token control', () => {
  it('records revoke calls and revokes the whole grant when given a refresh token', async () => {
    const server = await start({ preregisteredClients: [CLIENT] });
    const issued = server.issueToken();
    const response = await fetch(server.revocationEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: issued.refreshToken as string,
        token_type_hint: 'refresh_token',
        client_id: CLIENT.clientId,
      }),
    });
    expect(response.status).toBe(200);
    expect(server.revokeRequests).toHaveLength(1);
    expect(server.revokeRequests[0]?.params).toMatchObject({
      token: issued.refreshToken,
      token_type_hint: 'refresh_token',
      client_id: CLIENT.clientId,
    });
    expect(server.isRefreshTokenValid(issued.refreshToken as string)).toBe(false);
    expect(server.isAccessTokenValid(issued.accessToken)).toBe(false);
  });

  it('answers 200 for unknown tokens, can fail on demand and can be switched off', async () => {
    const server = await start();
    const revoke = (token: string) =>
      fetch(server.revocationEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }),
      });
    expect((await revoke('unknown')).status).toBe(200);
    server.configure({ revokeStatus: 500 });
    expect((await revoke('unknown')).status).toBe(500);
    expect(server.revokeRequests).toHaveLength(2);
    server.configure({ revocationSupported: false });
    expect((await revoke('unknown')).status).toBe(404);
  });

  it('issues, expires and revokes tokens manually', async () => {
    const server = await start();
    const first = server.issueToken({ refresh: false, scope: ['x'] });
    expect(first.refreshToken).toBeNull();
    expect(first.audience).toBe(server.mcpUrl);
    server.expireToken(first.accessToken);
    expect(server.isAccessTokenValid(first.accessToken)).toBe(false);

    const second = server.issueToken();
    const third = server.issueToken();
    server.revokeAllTokens();
    expect(server.isAccessTokenValid(second.accessToken)).toBe(false);
    expect(server.isRefreshTokenValid(third.refreshToken as string)).toBe(false);
  });
});

describe('simulateBrowser', () => {
  it('returns a non-redirect authorize answer without following anything', async () => {
    const server = await start();
    const result = await simulateBrowser(`${server.authorizationEndpoint}?client_id=nobody`);
    expect(result).toMatchObject({ authorizeStatus: 400, location: null, callbackStatus: null });
    expect(result.authorizeBody).toContain('invalid_client');
  });

  it('does not follow a second redirect from the callback', async () => {
    const server = await start({ preregisteredClients: [CLIENT] });
    const hop = createServer((req, res) => {
      res.writeHead(302, { location: 'http://127.0.0.1:1/never' });
      res.end();
      void req;
    });
    await new Promise<void>((resolve) => hop.listen(0, '127.0.0.1', resolve));
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          hop.close(() => resolve());
          hop.closeAllConnections();
        }),
    );
    const redirectUri = `http://127.0.0.1:${(hop.address() as AddressInfo).port}/callback`;
    const result = await simulateBrowser(authorizeUrl(server, { redirectUri, challenge: pkce().challenge }));
    expect(result.callbackStatus).toBe(302);
  });
});
