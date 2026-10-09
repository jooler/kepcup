#!/usr/bin/env node
// D73 P1 §5.1 spike (NOT product code): unauthenticated discovery probe for the
// first-batch Connected Apps candidates (todo/connected-apps.md 附录 B).
//
//   node packages/core/scripts/connector-spike/probe.mjs [--only slug,slug] [--out report.json] [--timeout ms]
//
// For every candidate MCP server URL it performs ONLY credential-free requests:
//   1. POST `initialize` (JSON-RPC) -> expects 401 + WWW-Authenticate
//   2. GET  protected-resource metadata (RFC 9728), from `resource_metadata` or the
//      well-known path
//   3. GET  authorization-server metadata (RFC 8414 / OIDC discovery)
// and prints one JSON report. It never registers a client (no DCR POST), never logs in
// and never sends a token. DCR support is read off `registration_endpoint`; CIMD support
// off `client_id_metadata_document_supported`. Anything else needing an account
// ("带登录模式": tool list, annotation coverage, whoami) belongs to the user's
// login testing (U2) and is deliberately NOT done here.
import { writeFile } from 'node:fs/promises';
import net from 'node:net';
import { pathToFileURL } from 'node:url';

/** Candidate URLs, each verified against the vendor docs on 2026-10-09 (see 附录 B). */
export const CANDIDATES = [
  {
    slug: 'notion',
    url: 'https://mcp.notion.com/mcp',
    docs: 'https://developers.notion.com/docs/mcp',
  },
  { slug: 'linear', url: 'https://mcp.linear.app/mcp', docs: 'https://linear.app/docs/mcp' },
  {
    slug: 'atlassian',
    url: 'https://mcp.atlassian.com/v1/mcp/authv2',
    docs: 'https://support.atlassian.com/atlassian-rovo-mcp-server/docs/use-atlassian-rovo-mcp-server/',
  },
  { slug: 'sentry', url: 'https://mcp.sentry.dev/mcp', docs: 'https://docs.sentry.io/ai/mcp/' },
  {
    slug: 'asana',
    url: 'https://mcp.asana.com/v2/mcp',
    docs: 'https://developers.asana.com/docs/integrating-with-asanas-mcp-server',
  },
  {
    slug: 'hubspot',
    url: 'https://mcp.hubspot.com',
    docs: 'https://developers.hubspot.com/docs/apps/developer-platform/build-apps/integrate-with-the-remote-hubspot-mcp-server',
  },
  { slug: 'canva', url: 'https://mcp.canva.com/mcp', docs: 'https://www.canva.dev/docs/mcp/' },
  { slug: 'stripe', url: 'https://mcp.stripe.com', docs: 'https://docs.stripe.com/mcp' },
  {
    slug: 'github',
    url: 'https://api.githubcopilot.com/mcp/',
    docs: 'https://github.com/github/github-mcp-server/blob/main/docs/host-integration.md',
  },
];

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;
const MAX_BODY_BYTES = 256 * 1024;
const USER_AGENT = 'kepcup-connector-spike/1 (unauthenticated discovery probe)';

const INITIALIZE_BODY = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'kepcup-connector-spike', version: '0.0.0' },
  },
});

/** Fetch with timeout, https-only manual redirects and a body cap. Never throws. */
async function request(fetchImpl, url, init, timeoutMs) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (!current.startsWith('https://')) return { error: `non-https url refused: ${current}` };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(current, {
        ...init,
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'user-agent': USER_AGENT, ...init.headers },
      });
      if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
        current = new URL(response.headers.get('location'), current).href;
        continue;
      }
      const text = (await response.text()).slice(0, MAX_BODY_BYTES);
      return { status: response.status, headers: response.headers, text, url: current };
    } catch (error) {
      const reason =
        error?.name === 'AbortError'
          ? `timeout after ${timeoutMs}ms`
          : String(error?.message ?? error);
      return { error: reason };
    } finally {
      clearTimeout(timer);
    }
  }
  return { error: 'too many redirects' };
}

/** Parses `Bearer realm="x", resource_metadata="y", scope="a b"` (and several challenges). */
export function parseWwwAuthenticate(header) {
  if (!header) return [];
  const challenges = [];
  const re = /([A-Za-z][A-Za-z0-9_-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g;
  for (const part of header.split(/,\s*(?=[A-Za-z][A-Za-z0-9._~+/-]*(?:\s|$))/)) {
    const m = /^([A-Za-z][A-Za-z0-9._~+/-]*)(?:\s+(.*))?$/s.exec(part.trim());
    if (!m) continue;
    const params = {};
    for (const p of (m[2] ?? '').matchAll(re)) params[p[1]] = p[2] ?? p[3];
    challenges.push({ scheme: m[1], params });
  }
  return challenges;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function getJson(fetchImpl, url, timeoutMs) {
  const response = await request(
    fetchImpl,
    url,
    { method: 'GET', headers: { accept: 'application/json' } },
    timeoutMs,
  );
  if (response.error !== undefined) return { url, error: response.error };
  const body = response.status === 200 ? parseJson(response.text) : null;
  return { url, status: response.status, body };
}

/** RFC 9728 §3.1 well-known URL (path inserted after the host). */
export function protectedResourceUrls(serverUrl) {
  const u = new URL(serverUrl);
  const path = u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '');
  const urls = [`${u.origin}/.well-known/oauth-protected-resource${path}`];
  if (path !== '') urls.push(`${u.origin}/.well-known/oauth-protected-resource`);
  return urls;
}

/** RFC 8414 §3 + OIDC discovery candidate URLs for an issuer. */
export function authorizationServerUrls(issuer) {
  const u = new URL(issuer);
  const path = u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '');
  const urls = [`${u.origin}/.well-known/oauth-authorization-server${path}`];
  urls.push(`${u.origin}/.well-known/openid-configuration${path}`);
  if (path !== '') urls.push(`${u.origin}${path}/.well-known/openid-configuration`);
  return urls;
}

function summarizeAs(metadata) {
  return {
    issuer: metadata.issuer ?? null,
    authorization_endpoint: metadata.authorization_endpoint ?? null,
    token_endpoint: metadata.token_endpoint ?? null,
    registration_endpoint: metadata.registration_endpoint ?? null,
    revocation_endpoint: metadata.revocation_endpoint ?? null,
    client_id_metadata_document_supported: metadata.client_id_metadata_document_supported ?? null,
    scopes_supported: metadata.scopes_supported ?? null,
    code_challenge_methods_supported: metadata.code_challenge_methods_supported ?? null,
    authorization_response_iss_parameter_supported:
      metadata.authorization_response_iss_parameter_supported ?? null,
    grant_types_supported: metadata.grant_types_supported ?? null,
    token_endpoint_auth_methods_supported: metadata.token_endpoint_auth_methods_supported ?? null,
  };
}

/** `cimd` > `dcr` > `none` (AS metadata fetched) > `unknown` (no AS metadata). */
export function autoRegistrationOf(asSummary) {
  if (asSummary === null) return 'unknown';
  if (asSummary.client_id_metadata_document_supported === true) return 'cimd';
  if (
    typeof asSummary.registration_endpoint === 'string' &&
    asSummary.registration_endpoint.length > 0
  )
    return 'dcr';
  return 'none';
}

/** Probes one candidate. Never throws; failures are recorded in the report. */
export async function probeCandidate(
  candidate,
  { fetch: fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {},
) {
  const report = {
    slug: candidate.slug,
    url: candidate.url,
    docs: candidate.docs ?? null,
    notes: [],
  };

  const init = await request(
    fetchImpl,
    candidate.url,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: INITIALIZE_BODY,
    },
    timeoutMs,
  );
  if (init.error !== undefined) {
    report.initialize = { error: init.error };
    report.autoRegistration = 'unknown';
    return report;
  }
  const challengeHeader = init.headers.get('www-authenticate');
  const challenges = parseWwwAuthenticate(challengeHeader);
  const bearer = challenges.find((c) => c.scheme.toLowerCase() === 'bearer') ?? null;
  report.initialize = {
    status: init.status,
    finalUrl: init.url,
    wwwAuthenticate: challengeHeader,
    challenge: bearer?.params ?? null,
  };
  if (init.status !== 401) {
    report.notes.push(`initialize without credentials returned ${init.status} (expected 401)`);
  }

  // PRM: the challenge's resource_metadata first, then the well-known URLs.
  const prmUrls = [];
  if (bearer?.params.resource_metadata) prmUrls.push(bearer.params.resource_metadata);
  for (const url of protectedResourceUrls(candidate.url))
    if (!prmUrls.includes(url)) prmUrls.push(url);
  let prm = null;
  const prmTried = [];
  for (const url of prmUrls) {
    const got = await getJson(fetchImpl, url, timeoutMs);
    prmTried.push({ url, status: got.status ?? null, error: got.error ?? null });
    if (got.body !== null && got.body !== undefined && typeof got.body === 'object') {
      prm = { url, ...got.body };
      break;
    }
  }
  report.prm = prm === null ? { found: false, tried: prmTried } : { found: true, ...prm };

  // AS metadata: first advertised issuer; fall back to the MCP origin (legacy servers).
  const issuers =
    Array.isArray(prm?.authorization_servers) && prm.authorization_servers.length > 0
      ? prm.authorization_servers
      : [new URL(candidate.url).origin];
  if (prm === null)
    report.notes.push(
      'no PRM: assuming the MCP origin is the authorization server (2025-03-26 behaviour)',
    );
  report.authorizationServers = issuers;
  const issuer = issuers[0];
  let as = null;
  const asTried = [];
  for (const url of authorizationServerUrls(issuer)) {
    const got = await getJson(fetchImpl, url, timeoutMs);
    asTried.push({ url, status: got.status ?? null, error: got.error ?? null });
    if (got.body !== null && got.body !== undefined && typeof got.body === 'object') {
      as = { url, ...summarizeAs(got.body) };
      break;
    }
  }
  report.authorizationServer =
    as === null ? { found: false, issuer, tried: asTried } : { found: true, ...as };
  report.autoRegistration = autoRegistrationOf(as);
  report.pkceS256 =
    as === null ? null : (as.code_challenge_methods_supported ?? []).includes('S256');
  if (issuers.length > 1)
    report.notes.push(`only the first of ${issuers.length} authorization servers was probed`);
  return report;
}

function parseArgs(argv) {
  const options = { only: null, out: null, timeoutMs: DEFAULT_TIMEOUT_MS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--only') options.only = argv[++i].split(',');
    else if (arg === '--out') options.out = argv[++i];
    else if (arg === '--timeout') options.timeoutMs = Number(argv[++i]);
    else return null;
  }
  return Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options : null;
}

async function main() {
  // Node's default 250ms per-address connect attempt is too tight for slow/IPv6-less hosts.
  net.setDefaultAutoSelectFamilyAttemptTimeout(3000);
  const options = parseArgs(process.argv.slice(2));
  if (options === null) {
    console.error('usage: node probe.mjs [--only slug,slug] [--out report.json] [--timeout ms]');
    process.exit(2);
  }
  const selected = CANDIDATES.filter((c) => options.only === null || options.only.includes(c.slug));
  const reports = [];
  for (const candidate of selected) {
    console.error(`[probe] ${candidate.slug} ${candidate.url}`);
    reports.push(await probeCandidate(candidate, { timeoutMs: options.timeoutMs }));
  }
  const output = JSON.stringify({ generatedAt: new Date().toISOString(), reports }, null, 2);
  if (options.out !== null) await writeFile(options.out, `${output}\n`);
  else process.stdout.write(`${output}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
