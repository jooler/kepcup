import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  isInitializeRequest,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';

/**
 * Fake "connected app" for the OAuth tests (docs/design/29-connected-apps.md
 * §5, todo/connected-apps.md §4.1): one loopback HTTP server that is at the
 * same time
 *
 * - an MCP Streamable HTTP resource server (`/mcp`, RFC 9728 metadata, bearer
 *   validation with audience and per-tool scopes), and
 * - an OAuth authorization server (RFC 8414 / OIDC discovery, CIMD, DCR,
 *   pre-registered clients, `/authorize` without any UI, `/token` with PKCE,
 *   `/revoke`).
 *
 * Every behaviour a real server may vary on is a switch in
 * {@link FakeOAuthMcpConfig}, mutable at runtime through `configure()`.
 * Nothing leaves 127.0.0.1; the only outbound request is the CIMD fetch of a
 * `client_id` URL, which in tests points at `file-server.ts`.
 */

export type FakeDiscoveryMode = 'oauth' | 'oidc' | 'both' | 'none';
export type FakeIssMode = 'correct' | 'omit' | 'wrong';
export type FakeRedirectMatch = 'exact' | 'loopback';

export interface FakeOAuthMcpConfig {
  // ---- Resource server -------------------------------------------------
  /** false: `/mcp` is open and never challenges. */
  requireAuth: boolean;
  /** `scope="…"` of the 401 challenge; undefined omits the parameter. */
  challengeScope: string | undefined;
  /** Put `resource_metadata="…"` into WWW-Authenticate (401 and 403). */
  challengeResourceMetadata: boolean;
  /** false: both PRM URLs answer 404. */
  prmEnabled: boolean;
  /** PRM `authorization_servers`; undefined means `[issuer]`. */
  prmAuthorizationServers: string[] | undefined;
  /** PRM `scopes_supported`; undefined omits the field. */
  prmScopesSupported: string[] | undefined;
  /** PRM `resource`; undefined means the canonical MCP URL. */
  prmResource: string | undefined;
  /** A token bound to another audience is rejected (401 invalid_token). */
  validateAudience: boolean;
  /** A token without any audience is rejected too (needs validateAudience). */
  requireAudience: boolean;

  // ---- Authorization server --------------------------------------------
  /** Which discovery document paths exist. */
  discovery: FakeDiscoveryMode;
  /** Advertise (and honour) `client_id_metadata_document_supported`. */
  cimdSupported: boolean;
  /** Serve `/register` and advertise `registration_endpoint`. */
  dcrEnabled: boolean;
  /** AS metadata `scopes_supported`; undefined omits the field. */
  scopesSupported: string[] | undefined;
  /** AS metadata `authorization_response_iss_parameter_supported`. */
  issParameterSupported: boolean;
  /** Serve `/revoke` and advertise `revocation_endpoint`. */
  revocationSupported: boolean;
  /** Metadata `code_challenge_methods_supported`. */
  codeChallengeMethodsSupported: string[];
  /** How redirect_uri is compared with the registered ones. */
  redirectMatch: FakeRedirectMatch;
  /** `iss` on the authorization response (RFC 9207). */
  issMode: FakeIssMode;
  /** When set, /authorize answers `error=<value>` (e.g. access_denied) instead of a code. */
  authorizeError: string | undefined;
  /** /token requires a `resource` parameter (RFC 8707); else `invalid_target`. */
  requireResource: boolean;
  /** Refresh grants issue a new refresh token and invalidate the old one. */
  rotateRefreshTokens: boolean;
  /** Token responses carry a refresh token at all. */
  issueRefreshToken: boolean;
  /** Seconds; null omits `expires_in` (the token then lives one hour). */
  expiresIn: number | null;
  /** Scope granted by /token regardless of the requested one; undefined grants what was requested. */
  grantScope: string | undefined;
  /** HTTP status of /revoke (RFC 7009 says 200; set 500 to test failure tolerance). */
  revokeStatus: number;
  /**
   * AS metadata `authorization_endpoint` override (called on every metadata request, so a test can
   * move the endpoint between flow attempts); undefined means `{issuer}/authorize`.
   */
  authorizationEndpoint: (() => string) | undefined;
  /**
   * /register waits for this promise after recording the registration and before answering
   * (a test can act while the client's DCR round trip is in flight).
   */
  registerGate: (() => Promise<void>) | undefined;
  /**
   * OIDC: when set, the authorization_code response carries an (unsigned, JWT-shaped) `id_token` whose
   * claims are these merged over `{ iss, aud: <client id>, iat, exp }`. Mutable at runtime, so a test
   * can connect two different accounts through the same server.
   */
  idTokenClaims: Record<string, unknown> | undefined;
  /**
   * When set, AS metadata advertises `userinfo_endpoint` and `GET /userinfo` (valid Bearer token
   * required) answers these claims.
   */
  userinfoClaims: Record<string, unknown> | undefined;
  /** Clock for token expiry. */
  now: () => number;
}

/** MCP tool served by the fake; the handler defaults to an echo. */
export interface FakeMcpTool {
  name: string;
  description?: string;
  title?: string;
  inputSchema?: Tool['inputSchema'];
  /** Any MCP tool annotations (readOnlyHint, destructiveHint, …). */
  annotations?: Tool['annotations'];
  /** tools/call answers 403 insufficient_scope unless the token has all of these. */
  requiredScopes?: string[];
  handler?: (
    args: Record<string, unknown>,
    ctx: { token: string | null; scopes: string[] },
  ) => CallToolResult | string | Promise<CallToolResult | string>;
}

export interface FakePreregisteredClient {
  clientId: string;
  /** Present: /token requires it (client_secret_post or Basic). */
  clientSecret?: string;
  redirectUris: string[];
  applicationType?: string;
}

export interface FakeOAuthMcpOptions extends Partial<FakeOAuthMcpConfig> {
  /** Initial tools; default is one read-only `echo` tool. */
  tools?: FakeMcpTool[];
  preregisteredClients?: FakePreregisteredClient[];
}

export interface IssuedToken {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch ms according to `config.now`. */
  expiresAt: number;
  scope: string[];
  audience: string | null;
}

export interface IssueTokenOptions {
  /** Default: the first preregistered client or `manual-client`. */
  clientId?: string;
  /** Default: `[]`. */
  scope?: string[];
  /** Default: the canonical MCP URL; null: a token without audience. */
  audience?: string | null;
  /** Seconds; default `config.expiresIn ?? 3600`. */
  expiresIn?: number;
  /** Also issue a refresh token (default true). */
  refresh?: boolean;
}

export interface RecordedHttpRequest {
  method: string;
  path: string;
  status: number;
}

export interface RecordedAuthorizeRequest {
  params: Record<string, string>;
  /** Where the client identity came from; null when it was rejected. */
  clientSource: 'preregistered' | 'dcr' | 'cimd' | null;
  /** `redirected`: code issued; `error-redirect`: error sent to redirect_uri; `rejected`: 400 without redirect. */
  outcome: 'redirected' | 'error-redirect' | 'rejected';
  /** Location the browser was sent to (null when rejected). */
  location: string | null;
  /** Error code for error-redirect / rejected. */
  error?: string;
}

export interface RecordedTokenRequest {
  params: Record<string, string>;
  /** Raw Authorization header (client_secret_basic), if any. */
  authorization: string | undefined;
  status: number;
  /** OAuth error code of a failed exchange. */
  error?: string;
}

export interface RecordedRevokeRequest {
  params: Record<string, string>;
  authorization: string | undefined;
}

export interface RecordedRegistration {
  body: Record<string, unknown>;
  clientId: string;
  applicationType: string | undefined;
  redirectUris: string[];
}

export interface RecordedCimdFetch {
  url: string;
  ok: boolean;
  /** Why validation failed. */
  reason?: string;
}

export interface RecordedMcpRequest {
  httpMethod: string;
  /** JSON-RPC methods carried by a POST (a batch has several). */
  rpcMethods: string[];
  /** Bearer token presented, if any. */
  token: string | null;
  status: number;
}

export interface RecordedToolCall {
  name: string;
  args: Record<string, unknown>;
  token: string | null;
  scopes: string[];
}

export interface TokenFailure {
  /** Restrict to a grant type; undefined hits both. */
  grantType?: 'authorization_code' | 'refresh_token';
  /** OAuth error code, default `invalid_grant`. */
  error?: string;
  /** Default 400. */
  status?: number;
  /** How many /token requests fail; default 1, Infinity = until cleared. */
  times?: number;
}

export interface SimulatedBrowserResult {
  /** Status of the authorization request (302 when it redirected). */
  authorizeStatus: number;
  /** The `Location` of the authorization response, or null. */
  location: string | null;
  /** Status of the callback request (null if there was no redirect). */
  callbackStatus: number | null;
  callbackBody: string | null;
  /** Body of a non-redirect authorize answer (error page). */
  authorizeBody: string | null;
}

export interface FakeOAuthMcpServer {
  /** `http://127.0.0.1:{port}` — also the issuer. */
  readonly url: string;
  readonly port: number;
  readonly issuer: string;
  /** Canonical MCP endpoint (`{url}/mcp`), the RFC 8707 resource. */
  readonly mcpUrl: string;
  readonly resourceMetadataUrl: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly registrationEndpoint: string;
  readonly revocationEndpoint: string;
  /** Live config object; mutate via `configure`. */
  readonly config: Readonly<FakeOAuthMcpConfig>;
  configure(patch: Partial<FakeOAuthMcpConfig>): void;

  // Tools (runtime mutable; each mutation emits notifications/tools/list_changed).
  readonly tools: readonly FakeMcpTool[];
  setTools(tools: FakeMcpTool[]): Promise<void>;
  addTool(tool: FakeMcpTool): Promise<void>;
  removeTool(name: string): Promise<void>;
  /** Number of list_changed notifications sent (to any session). */
  readonly toolsListChangedCount: number;
  /** Forget all MCP sessions: later requests with the old session id get 404. */
  dropSessions(): Promise<void>;

  // Clients.
  addPreregisteredClient(client: FakePreregisteredClient): void;
  /** Client ids registered through /register. */
  registeredClientIds(): string[];

  // Tokens.
  issueToken(options?: IssueTokenOptions): IssuedToken;
  /** Forces an access token past its expiry (it keeps validating as expired → 401). */
  expireToken(accessToken: string): void;
  /** Revokes an access or refresh token (a refresh token takes its grant's access tokens along). */
  revokeToken(token: string): void;
  revokeAllTokens(): void;
  isAccessTokenValid(accessToken: string): boolean;
  isRefreshTokenValid(refreshToken: string): boolean;
  /** Queue /token failures (invalid_grant injection). */
  failToken(failure?: TokenFailure): void;
  clearTokenFailures(): void;

  // Inspection.
  readonly requests: readonly RecordedHttpRequest[];
  readonly authorizeRequests: readonly RecordedAuthorizeRequest[];
  readonly tokenRequests: readonly RecordedTokenRequest[];
  readonly revokeRequests: readonly RecordedRevokeRequest[];
  readonly registrations: readonly RecordedRegistration[];
  readonly cimdFetches: readonly RecordedCimdFetch[];
  readonly mcpRequests: readonly RecordedMcpRequest[];
  readonly toolCalls: readonly RecordedToolCall[];
  /** Every id_token minted by /token (security tests scan stores for them). */
  readonly issuedIdTokens: readonly string[];
  /** Clears every recorded list above and the list_changed counter (tokens, clients and tools stay). */
  resetRecords(): void;

  simulateBrowser(url: string | URL): Promise<SimulatedBrowserResult>;
  stop(): Promise<void>;
}

interface ClientRecord {
  clientId: string;
  clientSecret?: string;
  redirectUris: string[];
}

interface CodeRecord {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string[];
  resource: string | null;
  expiresAt: number;
}

interface AccessRecord {
  grantId: string;
  clientId: string;
  scope: string[];
  audience: string | null;
  expiresAt: number;
  revoked: boolean;
}

interface RefreshRecord {
  grantId: string;
  clientId: string;
  scope: string[];
  audience: string | null;
  revoked: boolean;
}

interface Session {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

const MCP_PATH = '/mcp';
const PRM_PATH = '/.well-known/oauth-protected-resource';
const CODE_TTL_MS = 60_000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);
const WRONG_ISSUER = 'https://evil.example/not-the-issuer';

const DEFAULT_CONFIG: Omit<FakeOAuthMcpConfig, 'now'> = {
  requireAuth: true,
  challengeScope: undefined,
  challengeResourceMetadata: true,
  prmEnabled: true,
  prmAuthorizationServers: undefined,
  prmScopesSupported: undefined,
  prmResource: undefined,
  validateAudience: true,
  requireAudience: false,
  discovery: 'oauth',
  cimdSupported: false,
  dcrEnabled: false,
  scopesSupported: undefined,
  issParameterSupported: true,
  revocationSupported: true,
  codeChallengeMethodsSupported: ['S256'],
  redirectMatch: 'loopback',
  issMode: 'correct',
  authorizeError: undefined,
  requireResource: false,
  rotateRefreshTokens: true,
  issueRefreshToken: true,
  expiresIn: 3600,
  grantScope: undefined,
  revokeStatus: 200,
  authorizationEndpoint: undefined,
  registerGate: undefined,
  idTokenClaims: undefined,
  userinfoClaims: undefined,
};

const DEFAULT_TOOLS: FakeMcpTool[] = [
  {
    name: 'echo',
    description: 'Echo the arguments back.',
    annotations: { readOnlyHint: true },
  },
];

function token(prefix: string): string {
  return `${prefix}_${randomBytes(18).toString('hex')}`;
}

/** Trailing slash / default-port insensitive resource comparison (RFC 8707). */
function sameResource(a: string, b: string): boolean {
  try {
    const left = new URL(a);
    const right = new URL(b);
    return (
      left.origin === right.origin &&
      left.pathname.replace(/\/$/, '') === right.pathname.replace(/\/$/, '') &&
      left.search === right.search
    );
  } catch {
    return false;
  }
}

function splitScope(value: string | undefined): string[] {
  return value === undefined ? [] : value.split(/\s+/).filter((part) => part !== '');
}

function pkceS256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function isLoopbackHttp(url: URL): boolean {
  return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
}

function redirectAllowed(
  registered: string[],
  requested: string,
  mode: FakeRedirectMatch,
): boolean {
  if (registered.includes(requested)) return true;
  if (mode === 'exact') return false;
  let want: URL;
  try {
    want = new URL(requested);
  } catch {
    return false;
  }
  if (!isLoopbackHttp(want)) return false;
  // RFC 8252 §7.3: for loopback redirects the port is ignored.
  return registered.some((candidate) => {
    try {
      const have = new URL(candidate);
      return (
        isLoopbackHttp(have) &&
        have.hostname === want.hostname &&
        have.pathname === want.pathname &&
        have.search === want.search
      );
    } catch {
      return false;
    }
  });
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function oauthError(
  res: ServerResponse,
  status: number,
  error: string,
  description?: string,
): void {
  sendJson(res, status, {
    error,
    ...(description !== undefined ? { error_description: description } : {}),
  });
}

/** Form (or JSON) body of /token and /revoke as flat string params. */
function parseParams(contentType: string | undefined, raw: string): Record<string, string> {
  if (contentType?.includes('application/json') === true) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return Object.fromEntries(
        Object.entries(parsed).filter(([, value]) => typeof value === 'string'),
      ) as Record<string, string>;
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

/** Basic client credentials of the Authorization header, if any. */
function basicCredentials(header: string | undefined): { id: string; secret: string } | null {
  if (header === undefined || !/^basic\s/i.test(header)) return null;
  const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon < 0) return null;
  return {
    id: decodeURIComponent(decoded.slice(0, colon)),
    secret: decodeURIComponent(decoded.slice(colon + 1)),
  };
}

/**
 * Stands in for the system browser in tests: GETs the authorization URL
 * without following redirects, then GETs the single `Location` it answered
 * with (KepCup's local callback server). A non-redirect answer (e.g. a 400
 * from an invalid redirect_uri) is returned as-is and nothing is followed.
 */
export async function simulateBrowser(url: string | URL): Promise<SimulatedBrowserResult> {
  const authorize = await fetch(url, { redirect: 'manual' });
  const location = authorize.headers.get('location');
  if (authorize.status < 300 || authorize.status >= 400 || location === null) {
    return {
      authorizeStatus: authorize.status,
      location: null,
      callbackStatus: null,
      callbackBody: null,
      authorizeBody: await authorize.text(),
    };
  }
  await authorize.arrayBuffer();
  const callback = await fetch(new URL(location, url), { redirect: 'manual' });
  return {
    authorizeStatus: authorize.status,
    location,
    callbackStatus: callback.status,
    callbackBody: await callback.text(),
    authorizeBody: null,
  };
}

export function startFakeOAuthMcpServer(
  options: FakeOAuthMcpOptions = {},
): Promise<FakeOAuthMcpServer> {
  const { tools: initialTools, preregisteredClients, ...configOptions } = options;
  const config: FakeOAuthMcpConfig = { ...DEFAULT_CONFIG, now: Date.now, ...configOptions };
  let tools: FakeMcpTool[] = [...(initialTools ?? DEFAULT_TOOLS)];

  const preregistered = new Map<string, ClientRecord>();
  const dynamicClients = new Map<string, ClientRecord>();
  const codes = new Map<string, CodeRecord>();
  const accessTokens = new Map<string, AccessRecord>();
  const refreshTokens = new Map<string, RefreshRecord>();
  const sessions = new Map<string, Session>();
  const failures: {
    grantType: TokenFailure['grantType'];
    error: string;
    status: number;
    times: number;
  }[] = [];

  const requests: RecordedHttpRequest[] = [];
  const authorizeRequests: RecordedAuthorizeRequest[] = [];
  const tokenRequests: RecordedTokenRequest[] = [];
  const revokeRequests: RecordedRevokeRequest[] = [];
  const registrations: RecordedRegistration[] = [];
  const cimdFetches: RecordedCimdFetch[] = [];
  const mcpRequests: RecordedMcpRequest[] = [];
  const toolCalls: RecordedToolCall[] = [];
  const issuedIdTokens: string[] = [];
  let listChangedCount = 0;
  let dcrCounter = 0;
  let base = '';

  for (const client of preregisteredClients ?? []) {
    preregistered.set(client.clientId, {
      clientId: client.clientId,
      ...(client.clientSecret !== undefined ? { clientSecret: client.clientSecret } : {}),
      redirectUris: client.redirectUris,
    });
  }

  const mcpUrl = (): string => `${base}${MCP_PATH}`;
  const resourceMetadataUrl = (): string => `${base}${PRM_PATH}${MCP_PATH}`;

  // ---- Tokens ---------------------------------------------------------------

  function mintTokens(grant: {
    grantId: string;
    clientId: string;
    scope: string[];
    audience: string | null;
    expiresInSeconds: number;
  }): { accessToken: string; expiresAt: number } {
    const accessToken = token('at');
    const expiresAt = config.now() + grant.expiresInSeconds * 1000;
    accessTokens.set(accessToken, {
      grantId: grant.grantId,
      clientId: grant.clientId,
      scope: grant.scope,
      audience: grant.audience,
      expiresAt,
      revoked: false,
    });
    return { accessToken, expiresAt };
  }

  function issueToken(opts: IssueTokenOptions = {}): IssuedToken {
    const clientId = opts.clientId ?? [...preregistered.keys()][0] ?? 'manual-client';
    const scope = opts.scope ?? [];
    const audience = opts.audience === undefined ? mcpUrl() : opts.audience;
    const grantId = randomUUID();
    let refreshToken: string | null = null;
    if (opts.refresh !== false) {
      refreshToken = token('rt');
      refreshTokens.set(refreshToken, { grantId, clientId, scope, audience, revoked: false });
    }
    const minted = mintTokens({
      grantId,
      clientId,
      scope,
      audience,
      expiresInSeconds: opts.expiresIn ?? config.expiresIn ?? 3600,
    });
    return { ...minted, refreshToken, scope, audience };
  }

  /** Unsigned JWT-shaped id_token (the client reads claims from the token endpoint response). */
  function mintIdToken(clientId: string): string {
    const nowSec = Math.floor(config.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        iss: base,
        aud: clientId,
        iat: nowSec,
        exp: nowSec + 3600,
        ...config.idTokenClaims,
      }),
    ).toString('base64url');
    const idToken = `${header}.${payload}.fake-signature`;
    issuedIdTokens.push(idToken);
    return idToken;
  }

  function revokeGrant(grantId: string): void {
    for (const record of accessTokens.values()) {
      if (record.grantId === grantId) record.revoked = true;
    }
    for (const record of refreshTokens.values()) {
      if (record.grantId === grantId) record.revoked = true;
    }
  }

  function revokeToken(value: string): void {
    const access = accessTokens.get(value);
    if (access !== undefined) {
      access.revoked = true;
      return;
    }
    const refresh = refreshTokens.get(value);
    if (refresh !== undefined) revokeGrant(refresh.grantId);
  }

  const accessUsable = (record: AccessRecord | undefined): record is AccessRecord =>
    record !== undefined && !record.revoked && record.expiresAt > config.now();

  // ---- MCP resource server --------------------------------------------------

  function challenge(error?: { code: string; scope?: string }): string {
    const parts: string[] = [];
    if (error !== undefined) parts.push(`error="${error.code}"`);
    const scope = error?.scope ?? config.challengeScope;
    if (scope !== undefined) parts.push(`scope="${scope}"`);
    if (config.challengeResourceMetadata) {
      parts.push(`resource_metadata="${resourceMetadataUrl()}"`);
    }
    return parts.length === 0 ? 'Bearer' : `Bearer ${parts.join(', ')}`;
  }

  function createSession(): Session {
    const server = new McpServer(
      { name: 'fake-oauth-mcp', version: '0.0.0' },
      { capabilities: { tools: { listChanged: true } } },
    );
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: tools.map((tool) => ({
        name: tool.name,
        ...(tool.title !== undefined ? { title: tool.title } : {}),
        description: tool.description ?? `Fake tool ${tool.name}`,
        inputSchema: tool.inputSchema ?? { type: 'object' as const, properties: {} },
        ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const tool = tools.find((candidate) => candidate.name === request.params.name);
      if (tool === undefined) {
        return {
          isError: true,
          content: [{ type: 'text', text: `unknown tool ${request.params.name}` }],
        };
      }
      const args = request.params.arguments ?? {};
      const auth = extra.authInfo;
      const ctx = { token: auth?.token ?? null, scopes: auth?.scopes ?? [] };
      toolCalls.push({ name: tool.name, args, ...ctx });
      if (tool.handler === undefined) {
        return { content: [{ type: 'text', text: `${tool.name}:${JSON.stringify(args)}` }] };
      }
      const out = await tool.handler(args, ctx);
      return typeof out === 'string' ? { content: [{ type: 'text', text: out }] } : out;
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        sessions.set(id, { server, transport });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId !== undefined) sessions.delete(transport.sessionId);
    };
    return { server, transport };
  }

  /** tools/call messages in a POST body, for the per-tool scope check. */
  function toolCallNames(body: unknown): string[] {
    const messages = Array.isArray(body) ? body : [body];
    const names: string[] = [];
    for (const message of messages) {
      const item = message as { method?: unknown; params?: { name?: unknown } } | null;
      if (item?.method === 'tools/call' && typeof item.params?.name === 'string') {
        names.push(item.params.name);
      }
    }
    return names;
  }

  function rpcMethods(body: unknown): string[] {
    const messages = Array.isArray(body) ? body : [body];
    return messages.flatMap((message) => {
      const method = (message as { method?: unknown } | null)?.method;
      return typeof method === 'string' ? [method] : [];
    });
  }

  async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const httpMethod = req.method ?? 'GET';
    let body: unknown;
    if (httpMethod === 'POST') {
      const raw = await readBody(req);
      try {
        body = JSON.parse(raw);
      } catch {
        sendJson(res, 400, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error' },
        });
        return;
      }
    }
    const header = req.headers.authorization;
    const presented = /^Bearer\s+(.+)$/i.exec(header ?? '')?.[1] ?? null;
    const record = (status: number): void => {
      mcpRequests.push({ httpMethod, rpcMethods: rpcMethods(body), token: presented, status });
    };

    let authInfo:
      { token: string; clientId: string; scopes: string[]; expiresAt: number } | undefined;
    if (config.requireAuth) {
      if (presented === null) {
        record(401);
        res.writeHead(401, { 'www-authenticate': challenge(), 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      const access = accessTokens.get(presented);
      const audienceOk =
        access !== undefined &&
        (!config.validateAudience ||
          (access.audience === null
            ? !config.requireAudience
            : sameResource(access.audience, mcpUrl())));
      if (!accessUsable(access) || !audienceOk) {
        record(401);
        res.writeHead(401, {
          'www-authenticate': challenge({ code: 'invalid_token' }),
          'content-type': 'application/json',
        });
        res.end(JSON.stringify({ error: 'invalid_token' }));
        return;
      }
      authInfo = {
        token: presented,
        clientId: access.clientId,
        scopes: access.scope,
        expiresAt: Math.floor(access.expiresAt / 1000),
      };
      for (const name of toolCallNames(body)) {
        const required = tools.find((tool) => tool.name === name)?.requiredScopes ?? [];
        if (required.some((scope) => !access.scope.includes(scope))) {
          record(403);
          res.writeHead(403, {
            'www-authenticate': challenge({
              code: 'insufficient_scope',
              scope: required.join(' '),
            }),
            'content-type': 'application/json',
          });
          res.end(JSON.stringify({ error: 'insufficient_scope' }));
          return;
        }
      }
    }

    const sessionId = req.headers['mcp-session-id'];
    let session: Session | undefined;
    if (typeof sessionId === 'string') {
      session = sessions.get(sessionId);
      if (session === undefined) {
        record(404);
        sendJson(res, 404, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32001, message: 'Session not found' },
        });
        return;
      }
    } else if (httpMethod === 'POST' && isInitializeRequest(body)) {
      session = createSession();
      await session.server.connect(session.transport);
    } else {
      record(400);
      sendJson(res, 400, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32000, message: 'Bad Request: no valid session id' },
      });
      return;
    }
    (req as IncomingMessage & { auth?: unknown }).auth = authInfo;
    res.on('finish', () => record(res.statusCode));
    await session.transport.handleRequest(
      req as IncomingMessage & { auth?: NonNullable<typeof authInfo> },
      res,
      body,
    );
  }

  async function notifyToolsChanged(): Promise<void> {
    await Promise.all(
      [...sessions.values()].map(async ({ server }) => {
        try {
          await server.sendToolListChanged();
          listChangedCount += 1;
        } catch {
          // A session without an open stream or already closing; not an error for tests.
        }
      }),
    );
  }

  // ---- Discovery documents --------------------------------------------------

  function prmDocument(): Record<string, unknown> {
    return {
      resource: config.prmResource ?? mcpUrl(),
      authorization_servers: config.prmAuthorizationServers ?? [base],
      ...(config.prmScopesSupported !== undefined
        ? { scopes_supported: config.prmScopesSupported }
        : {}),
      bearer_methods_supported: ['header'],
    };
  }

  function authorizationServerDocument(oidc: boolean): Record<string, unknown> {
    return {
      issuer: base,
      authorization_endpoint: config.authorizationEndpoint?.() ?? `${base}/authorize`,
      token_endpoint: `${base}/token`,
      ...(config.dcrEnabled ? { registration_endpoint: `${base}/register` } : {}),
      ...(config.revocationSupported ? { revocation_endpoint: `${base}/revoke` } : {}),
      ...(config.userinfoClaims !== undefined ? { userinfo_endpoint: `${base}/userinfo` } : {}),
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: config.codeChallengeMethodsSupported,
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      ...(config.scopesSupported !== undefined ? { scopes_supported: config.scopesSupported } : {}),
      client_id_metadata_document_supported: config.cimdSupported,
      authorization_response_iss_parameter_supported: config.issParameterSupported,
      ...(oidc
        ? {
            jwks_uri: `${base}/jwks`,
            subject_types_supported: ['public'],
            id_token_signing_alg_values_supported: ['RS256'],
          }
        : {}),
    };
  }

  // ---- Client identity ------------------------------------------------------

  /** Fetches and validates a CIMD document; the redirect check happens in the caller. */
  async function fetchCimd(clientId: string): Promise<ClientRecord | string> {
    const fail = (reason: string): string => {
      cimdFetches.push({ url: clientId, ok: false, reason });
      return reason;
    };
    let response: Response;
    try {
      response = await fetch(clientId, { redirect: 'error', signal: AbortSignal.timeout(5000) });
    } catch (error) {
      return fail(`fetch failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) return fail(`status ${response.status}`);
    let doc: { client_id?: unknown; redirect_uris?: unknown };
    try {
      doc = (await response.json()) as typeof doc;
    } catch {
      return fail('not JSON');
    }
    if (doc.client_id !== clientId) return fail('client_id does not match the document URL');
    if (
      !Array.isArray(doc.redirect_uris) ||
      doc.redirect_uris.length === 0 ||
      doc.redirect_uris.some((uri) => typeof uri !== 'string')
    ) {
      return fail('redirect_uris missing');
    }
    cimdFetches.push({ url: clientId, ok: true });
    return { clientId, redirectUris: doc.redirect_uris as string[] };
  }

  async function resolveClient(
    clientId: string | undefined,
  ): Promise<
    { client: ClientRecord; source: 'preregistered' | 'dcr' | 'cimd' } | { error: string }
  > {
    if (clientId === undefined || clientId === '') return { error: 'missing client_id' };
    const known = preregistered.get(clientId);
    if (known !== undefined) return { client: known, source: 'preregistered' };
    const dynamic = dynamicClients.get(clientId);
    if (dynamic !== undefined) return { client: dynamic, source: 'dcr' };
    if (config.cimdSupported && /^https?:\/\//.test(clientId)) {
      const fetched = await fetchCimd(clientId);
      return typeof fetched === 'string'
        ? { error: `invalid client metadata document: ${fetched}` }
        : { client: fetched, source: 'cimd' };
    }
    return { error: 'unknown client_id' };
  }

  // ---- /authorize -----------------------------------------------------------

  async function handleAuthorize(url: URL, res: ServerResponse): Promise<void> {
    const params = Object.fromEntries(url.searchParams);
    const reject = (
      status: number,
      error: string,
      description: string,
      source: RecordedAuthorizeRequest['clientSource'],
    ): void => {
      authorizeRequests.push({
        params,
        clientSource: source,
        outcome: 'rejected',
        location: null,
        error,
      });
      oauthError(res, status, error, description);
    };

    const resolved = await resolveClient(params.client_id);
    if ('error' in resolved) {
      reject(400, 'invalid_client', resolved.error, null);
      return;
    }
    const redirectUri = params.redirect_uri;
    if (
      redirectUri === undefined ||
      !redirectAllowed(resolved.client.redirectUris, redirectUri, config.redirectMatch)
    ) {
      reject(
        400,
        'invalid_request',
        'redirect_uri is not registered for this client',
        resolved.source,
      );
      return;
    }

    const target = new URL(redirectUri);
    const finish = (outcome: 'redirected' | 'error-redirect', error?: string): void => {
      if (params.state !== undefined) target.searchParams.set('state', params.state);
      if (config.issMode === 'correct') target.searchParams.set('iss', base);
      else if (config.issMode === 'wrong') target.searchParams.set('iss', WRONG_ISSUER);
      authorizeRequests.push({
        params,
        clientSource: resolved.source,
        outcome,
        location: target.toString(),
        ...(error !== undefined ? { error } : {}),
      });
      res.writeHead(302, { location: target.toString(), 'cache-control': 'no-store' });
      res.end();
    };
    const fail = (error: string, description: string): void => {
      target.searchParams.set('error', error);
      target.searchParams.set('error_description', description);
      finish('error-redirect', error);
    };

    if (params.response_type !== 'code') {
      fail('unsupported_response_type', 'only response_type=code is supported');
      return;
    }
    if (params.code_challenge === undefined || params.code_challenge_method !== 'S256') {
      fail('invalid_request', 'PKCE with code_challenge_method=S256 is required');
      return;
    }
    if (config.authorizeError !== undefined) {
      fail(config.authorizeError, 'simulated authorization failure');
      return;
    }

    const code = token('code');
    codes.set(code, {
      clientId: resolved.client.clientId,
      redirectUri,
      codeChallenge: params.code_challenge,
      scope: splitScope(params.scope),
      resource: params.resource ?? null,
      expiresAt: config.now() + CODE_TTL_MS,
    });
    target.searchParams.set('code', code);
    finish('redirected');
  }

  // ---- /token ---------------------------------------------------------------

  async function handleToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const params = parseParams(req.headers['content-type'], await readBody(req));
    const authorization = req.headers.authorization;
    const respond = (status: number, error: string | undefined, body: unknown): void => {
      tokenRequests.push({
        params,
        authorization,
        status,
        ...(error !== undefined ? { error } : {}),
      });
      sendJson(res, status, body);
    };
    const fail = (status: number, error: string, description: string): void => {
      respond(status, error, { error, error_description: description });
    };

    const grantType = params.grant_type;
    const injected = failures.find(
      (failure) =>
        failure.times > 0 && (failure.grantType === undefined || failure.grantType === grantType),
    );
    if (injected !== undefined) {
      injected.times -= 1;
      fail(injected.status, injected.error, 'simulated token failure');
      return;
    }

    const basic = basicCredentials(authorization);
    const clientId = params.client_id ?? basic?.id;
    const clientSecret = params.client_secret ?? basic?.secret;
    const client = clientId === undefined ? undefined : preregistered.get(clientId);
    if (client?.clientSecret !== undefined && client.clientSecret !== clientSecret) {
      fail(401, 'invalid_client', 'client authentication failed');
      return;
    }
    if (config.requireResource && params.resource === undefined) {
      fail(400, 'invalid_target', 'resource parameter is required');
      return;
    }
    if (
      params.resource !== undefined &&
      config.validateAudience &&
      !sameResource(params.resource, config.prmResource ?? mcpUrl())
    ) {
      fail(400, 'invalid_target', 'unknown resource');
      return;
    }

    const expiresInSeconds = config.expiresIn ?? 3600;
    const responseBody = (
      access: { accessToken: string },
      refresh: string | null,
      scope: string[],
      idToken?: string,
    ): Record<string, unknown> => ({
      access_token: access.accessToken,
      token_type: 'Bearer',
      ...(config.expiresIn !== null ? { expires_in: expiresInSeconds } : {}),
      ...(refresh !== null ? { refresh_token: refresh } : {}),
      ...(scope.length > 0 ? { scope: scope.join(' ') } : {}),
      ...(idToken !== undefined ? { id_token: idToken } : {}),
    });

    if (grantType === 'authorization_code') {
      const record = params.code === undefined ? undefined : codes.get(params.code);
      if (params.code !== undefined) codes.delete(params.code);
      if (
        record === undefined ||
        record.expiresAt <= config.now() ||
        record.clientId !== clientId ||
        record.redirectUri !== params.redirect_uri
      ) {
        fail(400, 'invalid_grant', 'authorization code is invalid, expired or already used');
        return;
      }
      if (
        params.code_verifier === undefined ||
        pkceS256(params.code_verifier) !== record.codeChallenge
      ) {
        fail(400, 'invalid_grant', 'PKCE verification failed');
        return;
      }
      const scope = config.grantScope !== undefined ? splitScope(config.grantScope) : record.scope;
      const audience = params.resource ?? record.resource;
      const grantId = randomUUID();
      const refresh = config.issueRefreshToken ? token('rt') : null;
      if (refresh !== null) {
        refreshTokens.set(refresh, {
          grantId,
          clientId: record.clientId,
          scope,
          audience,
          revoked: false,
        });
      }
      const access = mintTokens({
        grantId,
        clientId: record.clientId,
        scope,
        audience,
        expiresInSeconds,
      });
      const idToken = config.idTokenClaims === undefined ? undefined : mintIdToken(record.clientId);
      respond(200, undefined, responseBody(access, refresh, scope, idToken));
      return;
    }

    if (grantType === 'refresh_token') {
      const old =
        params.refresh_token === undefined ? undefined : refreshTokens.get(params.refresh_token);
      if (
        old === undefined ||
        old.revoked ||
        (clientId !== undefined && old.clientId !== clientId)
      ) {
        fail(400, 'invalid_grant', 'refresh token is invalid or revoked');
        return;
      }
      const requested = params.scope !== undefined ? splitScope(params.scope) : old.scope;
      if (requested.some((scope) => !old.scope.includes(scope))) {
        fail(400, 'invalid_scope', 'requested scope exceeds the original grant');
        return;
      }
      const audience = params.resource ?? old.audience;
      let refresh: string | null = null;
      if (config.rotateRefreshTokens) {
        refresh = token('rt');
        refreshTokens.delete(params.refresh_token as string);
        refreshTokens.set(refresh, {
          grantId: old.grantId,
          clientId: old.clientId,
          scope: old.scope,
          audience,
          revoked: false,
        });
      }
      const access = mintTokens({
        grantId: old.grantId,
        clientId: old.clientId,
        scope: requested,
        audience,
        expiresInSeconds,
      });
      respond(200, undefined, responseBody(access, refresh, requested));
      return;
    }

    fail(400, 'unsupported_grant_type', `unsupported grant_type ${grantType ?? '(none)'}`);
  }

  // ---- /register, /revoke ----------------------------------------------------

  async function handleRegister(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    } catch {
      oauthError(res, 400, 'invalid_client_metadata', 'body is not JSON');
      return;
    }
    const redirectUris = body.redirect_uris;
    if (
      !Array.isArray(redirectUris) ||
      redirectUris.length === 0 ||
      redirectUris.some((uri) => typeof uri !== 'string')
    ) {
      oauthError(res, 400, 'invalid_redirect_uri', 'redirect_uris is required');
      return;
    }
    dcrCounter += 1;
    const clientId = `dcr-client-${dcrCounter}`;
    dynamicClients.set(clientId, { clientId, redirectUris: redirectUris as string[] });
    registrations.push({
      body,
      clientId,
      applicationType:
        typeof body.application_type === 'string' ? body.application_type : undefined,
      redirectUris: redirectUris as string[],
    });
    await config.registerGate?.();
    sendJson(res, 201, {
      ...body,
      client_id: clientId,
      client_id_issued_at: Math.floor(config.now() / 1000),
      token_endpoint_auth_method: 'none',
    });
  }

  async function handleRevoke(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const params = parseParams(req.headers['content-type'], await readBody(req));
    revokeRequests.push({ params, authorization: req.headers.authorization });
    if (config.revokeStatus !== 200) {
      oauthError(res, config.revokeStatus, 'server_error', 'simulated revoke failure');
      return;
    }
    if (params.token !== undefined) revokeToken(params.token);
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end('{}');
  }

  // ---- Dispatch -------------------------------------------------------------

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', base);
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (path === MCP_PATH) return handleMcp(req, res);

    if (method === 'GET' && (path === PRM_PATH || path === `${PRM_PATH}${MCP_PATH}`)) {
      if (!config.prmEnabled) return oauthError(res, 404, 'not_found');
      return sendJson(res, 200, prmDocument());
    }
    if (method === 'GET' && path === '/.well-known/oauth-authorization-server') {
      if (config.discovery !== 'oauth' && config.discovery !== 'both') {
        return oauthError(res, 404, 'not_found');
      }
      return sendJson(res, 200, authorizationServerDocument(false));
    }
    if (method === 'GET' && path === '/.well-known/openid-configuration') {
      if (config.discovery !== 'oidc' && config.discovery !== 'both') {
        return oauthError(res, 404, 'not_found');
      }
      return sendJson(res, 200, authorizationServerDocument(true));
    }
    if (method === 'GET' && path === '/userinfo' && config.userinfoClaims !== undefined) {
      const presented = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1];
      if (presented === undefined || !accessUsable(accessTokens.get(presented))) {
        return oauthError(res, 401, 'invalid_token');
      }
      return sendJson(res, 200, config.userinfoClaims);
    }
    if (method === 'GET' && path === '/authorize') return handleAuthorize(url, res);
    if (method === 'POST' && path === '/token') return handleToken(req, res);
    if (method === 'POST' && path === '/register' && config.dcrEnabled) {
      return handleRegister(req, res);
    }
    if (method === 'POST' && path === '/revoke' && config.revocationSupported) {
      return handleRevoke(req, res);
    }
    return oauthError(res, 404, 'not_found');
  }

  const httpServer: HttpServer = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    res.on('finish', () => {
      requests.push({ method: req.method ?? 'GET', path, status: res.statusCode });
    });
    route(req, res).catch((error: unknown) => {
      if (!res.headersSent) {
        sendJson(res, 500, {
          error: 'server_error',
          error_description: error instanceof Error ? error.message : String(error),
        });
      } else {
        res.end();
      }
    });
  });

  return new Promise((resolve, reject) => {
    httpServer.on('error', reject);
    httpServer.listen(0, '127.0.0.1', () => {
      const port = (httpServer.address() as AddressInfo).port;
      base = `http://127.0.0.1:${port}`;
      resolve({
        url: base,
        port,
        issuer: base,
        get mcpUrl() {
          return mcpUrl();
        },
        get resourceMetadataUrl() {
          return resourceMetadataUrl();
        },
        authorizationEndpoint: `${base}/authorize`,
        tokenEndpoint: `${base}/token`,
        registrationEndpoint: `${base}/register`,
        revocationEndpoint: `${base}/revoke`,
        config,
        configure: (patch) => {
          Object.assign(config, patch);
        },
        get tools() {
          return tools;
        },
        setTools: async (next) => {
          tools = [...next];
          await notifyToolsChanged();
        },
        addTool: async (tool) => {
          tools = [...tools.filter((existing) => existing.name !== tool.name), tool];
          await notifyToolsChanged();
        },
        removeTool: async (name) => {
          tools = tools.filter((tool) => tool.name !== name);
          await notifyToolsChanged();
        },
        get toolsListChangedCount() {
          return listChangedCount;
        },
        dropSessions: async () => {
          const open = [...sessions.values()];
          sessions.clear();
          await Promise.all(open.map(({ transport }) => transport.close().catch(() => undefined)));
        },
        addPreregisteredClient: (client) => {
          preregistered.set(client.clientId, {
            clientId: client.clientId,
            ...(client.clientSecret !== undefined ? { clientSecret: client.clientSecret } : {}),
            redirectUris: client.redirectUris,
          });
        },
        registeredClientIds: () => [...dynamicClients.keys()],
        issueToken,
        expireToken: (accessToken) => {
          const record = accessTokens.get(accessToken);
          if (record !== undefined) record.expiresAt = config.now() - 1;
        },
        revokeToken,
        revokeAllTokens: () => {
          for (const record of accessTokens.values()) record.revoked = true;
          for (const record of refreshTokens.values()) record.revoked = true;
        },
        isAccessTokenValid: (accessToken) => accessUsable(accessTokens.get(accessToken)),
        isRefreshTokenValid: (refreshToken) => {
          const record = refreshTokens.get(refreshToken);
          return record !== undefined && !record.revoked;
        },
        failToken: (failure = {}) => {
          failures.push({
            grantType: failure.grantType,
            error: failure.error ?? 'invalid_grant',
            status: failure.status ?? 400,
            times: failure.times ?? 1,
          });
        },
        clearTokenFailures: () => {
          failures.length = 0;
        },
        requests,
        authorizeRequests,
        tokenRequests,
        revokeRequests,
        registrations,
        cimdFetches,
        mcpRequests,
        toolCalls,
        issuedIdTokens,
        resetRecords: () => {
          for (const list of [
            requests,
            authorizeRequests,
            tokenRequests,
            revokeRequests,
            registrations,
            cimdFetches,
            mcpRequests,
            toolCalls,
            issuedIdTokens,
          ] as unknown[][]) {
            list.length = 0;
          }
          listChangedCount = 0;
        },
        simulateBrowser,
        stop: async () => {
          const open = [...sessions.values()];
          sessions.clear();
          await Promise.all(open.map(({ transport }) => transport.close().catch(() => undefined)));
          await new Promise<void>((done) => {
            httpServer.close(() => done());
            httpServer.closeAllConnections();
          });
        },
      });
    });
  });
}
