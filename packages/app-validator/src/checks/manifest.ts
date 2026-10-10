import {
  CONNECTOR_META_KEY,
  connectorCatalogEntrySchema,
  connectorMetaOf,
  connectorRemoteOf,
  connectorToolPrefix,
  type ConnectorCatalogEntry,
  type ConnectorRemote,
} from '@kepcup/shared';
import { makeCheck, type Check } from '../types.js';
import { isLoopbackUrl } from '../util.js';

/**
 * (a) `server.json` + `_meta["app.kepcup/connector"]` checks. Pure: operates on the parsed JSON.
 */

/** Placeholder when the submission leaves out `releaseGate` (KepCup assigns it during review). */
export const PENDING_RELEASE_GATE = 'pending-review';

export interface ManifestResult {
  checks: Check[];
  /** The parsed entry, or null when the manifest is invalid. */
  entry: ConnectorCatalogEntry | null;
  /** The remote the later network checks should use (null: MCPB-only or unusable remote). */
  remote: ConnectorRemote | null;
}

const META_FIELD_CHECK: Record<string, string> = {
  slug: 'manifest.slug',
  icon: 'manifest.icon',
  category: 'manifest.category',
  tier: 'manifest.tier',
  auth: 'manifest.auth',
  toolPolicy: 'manifest.tool-policy',
  skills: 'manifest.skills',
  ui: 'manifest.ui',
  privacyPolicy: 'manifest.privacy-policy',
  whoami: 'manifest.whoami',
};

const META_FIELD_HINT: Record<string, string> = {
  slug: 'Use 2-16 lower-case letters/digits, no underscore (tools are exposed as app_{slug}_*).',
  icon: 'Use a plain file name ending in .svg or .png (no path separators).',
  category:
    'One of: productivity, development, project, design, payments, crm, communication, data, other.',
  tier: 'One of: builtin, verified, community, developer.',
  auth: 'auth needs kind (oauth|api-key|none), registration (auto|preregistered) and clientRef when preregistered.',
  privacyPolicy: 'Give the absolute https URL of your privacy policy page.',
};

function fillReleaseGate(raw: unknown): { value: unknown; filled: boolean } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return { value: raw, filled: false };
  const meta = (raw as Record<string, unknown>)._meta;
  if (typeof meta !== 'object' || meta === null) return { value: raw, filled: false };
  const connector = (meta as Record<string, unknown>)[CONNECTOR_META_KEY];
  if (typeof connector !== 'object' || connector === null || Array.isArray(connector)) {
    return { value: raw, filled: false };
  }
  const gate = (connector as Record<string, unknown>).releaseGate;
  if (typeof gate === 'string' && gate.length > 0) return { value: raw, filled: false };
  return {
    value: {
      ...(raw as Record<string, unknown>),
      _meta: {
        ...(meta as Record<string, unknown>),
        [CONNECTOR_META_KEY]: {
          ...(connector as Record<string, unknown>),
          releaseGate: PENDING_RELEASE_GATE,
        },
      },
    },
    filled: true,
  };
}

function issueCheckId(path: readonly PropertyKey[]): string {
  const [first, second, third] = path;
  if (first === '_meta') {
    if (second === undefined || second === CONNECTOR_META_KEY) {
      if (third === undefined) return 'manifest.meta-missing';
      return META_FIELD_CHECK[String(third)] ?? 'manifest.meta';
    }
    return 'manifest.schema';
  }
  if (first === 'remotes' || first === 'packages') return 'manifest.remote';
  return 'manifest.schema';
}

export function checkManifest(raw: unknown): ManifestResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {
      checks: [
        makeCheck('manifest.json', 'error', 'server.json must be a JSON object.', {
          hint: 'Pass the path or https URL of a server.json document (MCP Registry format).',
        }),
      ],
      entry: null,
      remote: null,
    };
  }
  const { value, filled } = fillReleaseGate(raw);
  const parsed = connectorCatalogEntrySchema.safeParse(value);
  if (!parsed.success) {
    const byId = new Map<string, string[]>();
    for (const issue of parsed.error.issues) {
      const id = issueCheckId(issue.path);
      const where = issue.path.length > 0 ? `${issue.path.map(String).join('.')}: ` : '';
      byId.set(id, [...(byId.get(id) ?? []), `${where}${issue.message}`]);
    }
    const checks: Check[] = [];
    for (const [id, messages] of byId) {
      const field = id.startsWith('manifest.') ? id.slice('manifest.'.length) : '';
      const metaField = Object.entries(META_FIELD_CHECK).find(([, v]) => v === id)?.[0];
      const hint =
        id === 'manifest.meta-missing'
          ? `Add the _meta["${CONNECTOR_META_KEY}"] object (slug, icon, category, tier, auth, privacyPolicy).`
          : id === 'manifest.remote'
            ? 'Provide remotes: [{ "type": "streamable-http", "url": "https://…" }] (or an MCPB package).'
            : metaField !== undefined
              ? META_FIELD_HINT[metaField]
              : field === 'schema'
                ? 'Compare with the MCP Registry server.json schema; name is reverse-DNS "namespace/name".'
                : undefined;
      checks.push(
        makeCheck(id, 'error', messages.join('; '), {
          ...(hint !== undefined ? { hint } : {}),
          details: { issues: messages },
        }),
      );
    }
    return { checks, entry: null, remote: null };
  }

  const entry = parsed.data;
  const meta = connectorMetaOf(entry);
  const checks: Check[] = [
    makeCheck('manifest.schema', 'info', `server.json is valid (${entry.name}@${entry.version}).`),
    makeCheck(
      'manifest.slug',
      'info',
      `Connector slug "${meta.slug}" (tools are exposed as ${connectorToolPrefix(meta.slug)}*).`,
    ),
  ];
  if (filled) {
    checks.push(
      makeCheck(
        'manifest.release-gate',
        'info',
        'releaseGate is absent; KepCup assigns it during review (validated with a placeholder).',
      ),
    );
  }

  // Tier: third parties cannot claim builtin; verified is granted by review.
  if (meta.tier === 'builtin') {
    checks.push(
      makeCheck('manifest.tier', 'error', 'Third-party manifests cannot use tier "builtin".', {
        hint: 'Use "community"; KepCup raises it to "verified" after manual review.',
      }),
    );
  } else if (meta.tier === 'verified') {
    checks.push(
      makeCheck(
        'manifest.tier',
        'warn',
        'tier "verified" is assigned by KepCup review; the submitted value is ignored.',
        { hint: 'Submit as "community".' },
      ),
    );
  } else if (meta.tier === 'developer') {
    checks.push(
      makeCheck(
        'manifest.tier',
        'warn',
        'tier "developer" marks locally added servers and is not a submission tier.',
        { hint: 'Submit as "community".' },
      ),
    );
  } else {
    checks.push(makeCheck('manifest.tier', 'info', `tier "${meta.tier}".`));
  }

  if (meta.auth.kind !== 'oauth') {
    checks.push(
      makeCheck(
        'manifest.auth',
        'info',
        `auth.kind is "${meta.auth.kind}": OAuth discovery and authorization checks are skipped.`,
      ),
    );
  }
  if (meta.skills.length > 0) {
    checks.push(
      makeCheck('manifest.skills', 'info', `${meta.skills.length} bundled skill(s) declared.`),
    );
  }

  // Remote endpoint.
  let remote: ConnectorRemote | null = null;
  const streamable = connectorRemoteOf(entry);
  if (entry.remotes.length === 0) {
    checks.push(
      makeCheck(
        'manifest.remote',
        'info',
        'No remotes[]: this is a local package entry, so remote checks are skipped.',
      ),
    );
  } else if (streamable === null) {
    checks.push(
      makeCheck(
        'manifest.remote',
        'error',
        'remotes[] has no streamable-http endpoint (legacy sse is not connectable).',
        {
          hint: 'Serve MCP over Streamable HTTP and declare { "type": "streamable-http", "url": "https://…" }.',
        },
      ),
    );
  } else {
    const url = new URL(streamable.url);
    if (url.protocol === 'https:') {
      remote = streamable;
      checks.push(makeCheck('manifest.remote', 'info', `Remote endpoint ${streamable.url}.`));
    } else if (url.protocol === 'http:' && isLoopbackUrl(streamable.url)) {
      remote = streamable;
      checks.push(
        makeCheck(
          'manifest.remote',
          'warn',
          'Remote endpoint is plaintext http on loopback (fine for local development, not publishable).',
          { hint: 'Publish the server behind https before submitting.' },
        ),
      );
    } else {
      checks.push(
        makeCheck(
          'manifest.remote',
          'error',
          `Remote endpoint must use https (got ${url.protocol}).`,
          {
            hint: 'Serve the MCP endpoint over TLS.',
          },
        ),
      );
    }
    if (entry.remotes.some((r) => r.type === 'sse')) {
      checks.push(
        makeCheck(
          'manifest.remote',
          'warn',
          'remotes[] also lists a legacy sse endpoint; KepCup ignores it.',
          {
            hint: 'Remove the sse entry once Streamable HTTP is live.',
          },
        ),
      );
    }
  }

  // Privacy policy scheme (reachability is an IO check).
  const privacy = new URL(meta.privacyPolicy);
  if (
    privacy.protocol !== 'https:' &&
    !(privacy.protocol === 'http:' && isLoopbackUrl(meta.privacyPolicy))
  ) {
    checks.push(
      makeCheck('manifest.privacy-policy', 'error', 'privacyPolicy must be an https URL.', {
        hint: 'Publish the privacy policy over https.',
      }),
    );
  }
  return { checks, entry, remote };
}

/** `toolPolicy` keys that name tools the server does not offer (typos silently weaken nothing, but are dead). */
export function checkToolPolicyKeys(
  entry: ConnectorCatalogEntry,
  toolNames: readonly string[],
): Check[] {
  const meta = connectorMetaOf(entry);
  const known = new Set(toolNames);
  const unknown = Object.keys(meta.toolPolicy).filter((name) => !known.has(name));
  if (unknown.length === 0) return [];
  return [
    makeCheck(
      'manifest.tool-policy',
      'warn',
      `toolPolicy names tools the server does not list: ${unknown.join(', ')}.`,
      { hint: 'Keys must be the exact tool names from tools/list.', details: { unknown } },
    ),
  ];
}

/** Manifest `ui` flag versus the tools' `_meta.ui.resourceUri`. */
export function checkUiFlag(entry: ConnectorCatalogEntry, uiToolCount: number): Check[] {
  const declared = connectorMetaOf(entry).ui;
  if (declared && uiToolCount === 0) {
    return [
      makeCheck(
        'manifest.ui',
        'warn',
        'Manifest declares ui: true but no tool has _meta.ui.resourceUri.',
        {
          hint: 'Set ui to false, or expose the MCP Apps resource on the tool.',
        },
      ),
    ];
  }
  if (!declared && uiToolCount > 0) {
    return [
      makeCheck(
        'manifest.ui',
        'warn',
        `${uiToolCount} tool(s) carry _meta.ui.resourceUri but the manifest declares ui: false.`,
        { hint: 'Set ui: true so the directory advertises the interactive UI.' },
      ),
    ];
  }
  return [];
}
