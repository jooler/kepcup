import { readFile } from 'node:fs/promises';
import {
  OAuthIssuerMismatchError,
  discoverAuthorizationServerMetadata,
  discoverProtectedResourceMetadata,
  parseWwwAuthenticate,
} from '@earendil-works/pi-mcp/oauth';
import type { McpFetch } from '@earendil-works/pi-mcp';
import { KEPCUP_OAUTH_CLIENT_ID, connectorMetaOf } from '@kepcup/shared';
import { checkUiTools, uiResourceUriOf, uiResourceUris } from './checks/apps-ui.js';
import { checkManifest, checkToolPolicyKeys, checkUiFlag } from './checks/manifest.js';
import {
  checkDiscovery,
  checkProbe,
  type AuthorizationServerMetadataLike,
  type ChallengeFacts,
  type DiscoveryFacts,
  type ProbeFacts,
  type ProtectedResourceMetadata,
} from './checks/remote.js';
import { checkTools } from './checks/tools.js';
import { runAuthorization } from './io/auth.js';
import { DEFAULT_TIMEOUT_MS, createGuardedFetch, fetchText } from './io/http.js';
import { connectMcp, type McpSession } from './io/mcp.js';
import {
  REPORT_SCHEMA_VERSION,
  makeCheck,
  summarize,
  type Check,
  type ValidationReport,
} from './types.js';
import { redactCheck, redactUrl } from './redact.js';
import { errorMessage, isLoopbackUrl, isTlsErrorCode, networkErrorCode } from './util.js';

export interface ValidateOptions {
  /** Path or http(s) URL of the server.json. */
  target: string;
  /** Run the interactive OAuth flow and the tool checks behind it. */
  auth?: boolean | undefined;
  /** Per-request timeout in ms (default 10 s). */
  timeoutMs?: number | undefined;
  /** Opens the authorization URL (default: only logs it). */
  openBrowser?: ((url: string) => void | Promise<void>) | undefined;
  /** OAuth client id (CIMD document URL). Default: KepCup's. Tests override. */
  clientIdUrl?: string | undefined;
  /** How long `--auth` waits for the browser (default 5 min). */
  callbackTimeoutMs?: number | undefined;
  /** Candidate loopback callback ports (default KepCup's fixed ports). */
  callbackPorts?: readonly number[] | undefined;
  /** Progress lines for the human running the tool (stderr in the CLI). */
  log?: ((line: string) => void) | undefined;
  /** Test seams. */
  fetchImpl?: typeof fetch | undefined;
  readFileImpl?: ((path: string) => Promise<string>) | undefined;
}

const MANIFEST_MAX_BYTES = 1024 * 1024;
const DEFAULT_CALLBACK_TIMEOUT_MS = 5 * 60_000;
const UI_RESOURCES_MAX = 10;

async function loadManifest(
  options: ValidateOptions,
  timeoutMs: number,
): Promise<{ ok: true; value: unknown } | { ok: false; check: Check }> {
  let text: string;
  try {
    if (/^https?:\/\//i.test(options.target)) {
      const response = await fetchText(options.target, {
        timeoutMs,
        maxBytes: MANIFEST_MAX_BYTES,
        crossOriginRedirects: true,
        headers: { accept: 'application/json' },
        ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
      });
      if (response.status !== 200) {
        return {
          ok: false,
          check: makeCheck(
            'manifest.load',
            'error',
            `${options.target} answered HTTP ${response.status}.`,
            {
              hint: 'Pass a URL that serves the server.json document with HTTP 200.',
            },
          ),
        };
      }
      text = response.text;
    } else {
      text = await (options.readFileImpl ?? ((path: string) => readFile(path, 'utf8')))(
        options.target,
      );
    }
  } catch (error) {
    return {
      ok: false,
      check: makeCheck(
        'manifest.load',
        'error',
        `Cannot read ${options.target}: ${errorMessage(error)}`,
        {
          hint: 'Pass the path or https URL of a server.json file.',
        },
      ),
    };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    return {
      ok: false,
      check: makeCheck(
        'manifest.json',
        'error',
        `server.json is not valid JSON: ${errorMessage(error)}`,
      ),
    };
  }
}

async function checkPrivacyPolicy(
  url: string,
  timeoutMs: number,
  fetchImpl?: typeof fetch,
): Promise<Check> {
  try {
    const response = await fetchText(url, {
      timeoutMs: Math.min(timeoutMs, DEFAULT_TIMEOUT_MS),
      maxBytes: 2 * 1024 * 1024,
      crossOriginRedirects: true,
      headers: { accept: 'text/html,application/xhtml+xml,text/plain,*/*' },
      ...(fetchImpl !== undefined ? { fetchImpl } : {}),
    });
    if (response.status < 200 || response.status >= 300) {
      return makeCheck(
        'manifest.privacy-policy',
        'error',
        `privacyPolicy ${url} answered HTTP ${response.status}.`,
        {
          hint: 'The privacy policy URL must be publicly reachable.',
        },
      );
    }
    const visible = response.text
      .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (visible.length === 0) {
      return makeCheck(
        'manifest.privacy-policy',
        'error',
        `privacyPolicy ${url} returned an empty page.`,
        {
          hint: 'Publish the policy text at that URL (client-rendered pages with no text are treated as empty).',
        },
      );
    }
    if (visible.length < 200) {
      return makeCheck(
        'manifest.privacy-policy',
        'warn',
        `privacyPolicy ${url} has very little text (${visible.length} characters).`,
        {
          hint: 'Make sure the URL shows the actual policy.',
        },
      );
    }
    return makeCheck(
      'manifest.privacy-policy',
      'info',
      `privacyPolicy ${url} is reachable and has content.`,
    );
  } catch (error) {
    return makeCheck(
      'manifest.privacy-policy',
      'error',
      `privacyPolicy ${url} is not reachable: ${errorMessage(error)}`,
      {
        hint: 'The privacy policy URL must answer within 10 seconds.',
      },
    );
  }
}

async function probeRemote(url: string, fetchFn: McpFetch): Promise<ProbeFacts> {
  try {
    const response = await fetchFn(url, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'kepcup-app-validator', version: '0' },
        },
      }),
    });
    void response.body?.cancel().catch(() => undefined);
    return {
      url,
      outcome: {
        kind: 'response',
        status: response.status,
        wwwAuthenticate: response.headers.get('www-authenticate'),
      },
    };
  } catch (error) {
    const code = networkErrorCode(error);
    return {
      url,
      outcome: {
        kind: 'network-error',
        code,
        message: errorMessage(error),
        tls: isTlsErrorCode(code),
      },
    };
  }
}

interface Discovered {
  facts: DiscoveryFacts;
  prm: ProtectedResourceMetadata | null;
  as: { url: string; metadata: AuthorizationServerMetadataLike } | null;
}

async function discover(
  serverUrl: string,
  wwwAuthenticate: string | null,
  fetchFn: McpFetch,
): Promise<Discovered> {
  const parsed = parseWwwAuthenticate(wwwAuthenticate);
  const challenge: ChallengeFacts = {
    resourceMetadataUrl: parsed.resourceMetadataUrl?.href,
    scope: parsed.scope,
    error: parsed.error,
  };
  let prm: ProtectedResourceMetadata | null = null;
  let prmFact: DiscoveryFacts['prm'];
  try {
    prm = (await discoverProtectedResourceMetadata(serverUrl, {
      ...(parsed.resourceMetadataUrl !== undefined
        ? { resourceMetadataUrl: parsed.resourceMetadataUrl }
        : {}),
      fetch: fetchFn,
    })) as ProtectedResourceMetadata;
    prmFact = { ok: true, metadata: prm };
  } catch (error) {
    prmFact = { ok: false, error: errorMessage(error) };
  }
  const asUrl = prm?.authorization_servers?.[0] ?? String(new URL('/', serverUrl));
  let asFact: DiscoveryFacts['as'];
  let as: Discovered['as'] = null;
  try {
    const metadata = await discoverAuthorizationServerMetadata(asUrl, { fetch: fetchFn });
    if (metadata === undefined) {
      asFact = { ok: false, url: asUrl, error: 'no metadata document at the well-known locations' };
    } else {
      asFact = { ok: true, url: asUrl, metadata: metadata as AuthorizationServerMetadataLike };
      as = { url: asUrl, metadata: metadata as AuthorizationServerMetadataLike };
    }
  } catch (error) {
    asFact = {
      ok: false,
      url: asUrl,
      error:
        error instanceof OAuthIssuerMismatchError
          ? `issuer in the metadata (${error.received ?? 'none'}) differs from the authorization server URL (${error.expected})`
          : errorMessage(error),
    };
  }
  return { facts: { challenge, prm: prmFact, as: asFact }, prm, as };
}

export async function validate(options: ValidateOptions): Promise<ValidationReport> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const log = options.log ?? (() => undefined);
  const checks: Check[] = [];
  let remoteUrl: string | null = null;
  const finish = (): ValidationReport => {
    const summary = summarize(checks);
    return {
      schemaVersion: REPORT_SCHEMA_VERSION,
      target: redactUrl(options.target),
      remote: remoteUrl === null ? null : redactUrl(remoteUrl),
      auth: options.auth === true,
      summary,
      exitCode: summary.errors > 0 ? 1 : 0,
      checks: checks.map(redactCheck),
    };
  };

  const loaded = await loadManifest(options, timeoutMs);
  if (!loaded.ok) {
    checks.push(loaded.check);
    return finish();
  }
  const manifest = checkManifest(loaded.value);
  checks.push(...manifest.checks);
  const entry = manifest.entry;
  if (entry === null) return finish();
  const meta = connectorMetaOf(entry);

  log('Checking the privacy policy ...');
  checks.push(await checkPrivacyPolicy(meta.privacyPolicy, timeoutMs, options.fetchImpl));

  const remote = manifest.remote;
  if (remote === null) {
    checks.push(
      makeCheck(
        'tools.skipped',
        'info',
        'No usable remote endpoint: server and tool checks were skipped.',
      ),
    );
    return finish();
  }
  remoteUrl = remote.url;
  // Everything the remote's metadata points at may reach loopback / private hosts only when the
  // remote itself is local (development); a public server can never steer the CLI into the LAN.
  const guarded = createGuardedFetch({
    timeoutMs,
    allowLoopback: isLoopbackUrl(remote.url),
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
  });

  log(`Probing ${redactUrl(remote.url)} ...`);
  const probeFacts = await probeRemote(remote.url, guarded);
  const probe = checkProbe(probeFacts);
  checks.push(...probe.checks);
  if (probe.mode === 'unusable') {
    checks.push(
      makeCheck('tools.skipped', 'info', 'The endpoint is not usable: tool checks were skipped.'),
    );
    return finish();
  }

  let accessToken: string | undefined;
  let cleanup: (() => Promise<Check[]>) | null = null;
  if (probe.mode === 'auth-required') {
    if (meta.auth.kind !== 'oauth') {
      checks.push(
        makeCheck(
          'tools.skipped',
          'info',
          `auth.kind is "${meta.auth.kind}" but the server requires authorization; tool checks were skipped.`,
        ),
      );
      return finish();
    }
    log('Discovering the authorization server ...');
    const wwwAuthenticate =
      probeFacts.outcome.kind === 'response' ? probeFacts.outcome.wwwAuthenticate : null;
    const found = await discover(remote.url, wwwAuthenticate, guarded);
    checks.push(
      ...checkDiscovery(remote.url, found.facts, {
        registration: meta.auth.registration,
        clientRef: meta.auth.clientRef,
      }),
    );
    if (options.auth !== true) {
      checks.push(
        makeCheck(
          'auth.skipped',
          'info',
          'The server requires authorization: authorization and tool checks were skipped. Re-run with --auth to authorize once and check the tools.',
        ),
      );
      return finish();
    }
    if (found.as === null) {
      checks.push(
        makeCheck(
          'auth.flow',
          'error',
          'Authorization skipped: the authorization server could not be discovered.',
        ),
      );
      return finish();
    }
    log('Starting the authorization flow (a browser window is needed) ...');
    const run = await runAuthorization({
      serverUrl: remote.url,
      challenge: found.facts.challenge,
      prm: found.prm,
      authorizationServerUrl: found.as.url,
      metadata: found.as.metadata,
      clientIdUrl: options.clientIdUrl ?? KEPCUP_OAUTH_CLIENT_ID,
      fetch: guarded,
      openBrowser: options.openBrowser ?? ((url) => log(`Open this URL in a browser: ${url}`)),
      callbackTimeoutMs: options.callbackTimeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS,
      ports: options.callbackPorts,
      log,
    });
    checks.push(...run.checks);
    cleanup = run.cleanup;
    if (run.accessToken === null) {
      checks.push(
        makeCheck(
          'tools.skipped',
          'info',
          'Authorization did not complete: tool checks were skipped.',
        ),
      );
      return finish();
    }
    accessToken = run.accessToken;
  }

  let session: McpSession | null = null;
  try {
    log('Listing tools ...');
    try {
      session = await connectMcp({
        url: remote.url,
        fetch: guarded,
        accessToken,
        timeoutMs,
      });
    } catch (error) {
      checks.push(
        makeCheck('tools.list', 'error', `tools/list failed: ${errorMessage(error)}`, {
          hint:
            accessToken === undefined
              ? 'The server must answer initialize and tools/list over Streamable HTTP.'
              : 'The server rejected the token it just issued, or does not speak Streamable HTTP MCP.',
        }),
      );
      return finish();
    }
    checks.push(
      makeCheck(
        'mcp.session',
        'info',
        `MCP session established (${session.serverName ?? 'unnamed server'}, protocol ${session.protocolVersion ?? 'unknown'}).`,
      ),
    );
    const tools = session.tools;
    checks.push(...checkTools(tools, { slug: meta.slug }));
    checks.push(
      ...checkToolPolicyKeys(
        entry,
        tools.map((tool) => tool.name),
      ),
    );

    const uris = uiResourceUris(tools);
    checks.push(...checkUiFlag(entry, uris.length));
    if (uris.length > 0) {
      log(`Reading ${Math.min(uris.length, UI_RESOURCES_MAX)} MCP Apps resource(s) ...`);
      const facts = new Map<string, Awaited<ReturnType<McpSession['readUiResource']>>>();
      for (const uri of uris.slice(0, UI_RESOURCES_MAX)) {
        facts.set(
          uri,
          uri.startsWith('ui://')
            ? await session.readUiResource(uri)
            : { uri, read: { ok: false, error: 'not a ui:// URI' } },
        );
      }
      checks.push(
        ...checkUiTools(
          tools.filter((tool) => facts.has(uiResourceUriOf(tool) ?? '')),
          facts,
        ),
      );
      if (uris.length > UI_RESOURCES_MAX) {
        checks.push(
          makeCheck(
            'ui.resource',
            'warn',
            `${uris.length - UI_RESOURCES_MAX} more UI resources were not checked.`,
          ),
        );
      }
    }
  } finally {
    await session?.close();
    if (cleanup !== null) checks.push(...(await cleanup()));
  }
  return finish();
}
