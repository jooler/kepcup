import { makeCheck, type Check } from '../types.js';
import type { ToolLike } from './tools.js';

/**
 * (e) MCP Apps checks (design 29 §11.6): tools with `_meta.ui.resourceUri` must serve a `ui://`
 * resource whose `_meta.ui.csp` declares explicit allowlists. Pure: the resource reads are done by
 * the caller and passed in as {@link UiResourceFacts}.
 */

export const UI_HTML_WARN_BYTES = 2 * 1024 * 1024;
export const UI_HTML_MAX_BYTES = 10 * 1024 * 1024;
export const MCP_APP_MIME = 'text/html;profile=mcp-app';

export interface UiResourceContent {
  uri?: string | undefined;
  mimeType?: string | undefined;
  text?: string | undefined;
  blob?: string | undefined;
  _meta?: Record<string, unknown> | undefined;
}

export type UiResourceRead =
  | { ok: true; contents: UiResourceContent[]; meta?: Record<string, unknown> | undefined }
  | { ok: false; error: string };

export interface UiResourceFacts {
  uri: string;
  read: UiResourceRead;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** `_meta.ui.resourceUri` (current spelling) or the legacy flat `_meta["ui/resourceUri"]`. */
export function uiResourceUriOf(tool: ToolLike): string | null {
  const ui = asRecord(tool._meta?.ui);
  const nested = ui?.resourceUri;
  if (typeof nested === 'string') return nested;
  const legacy = tool._meta?.['ui/resourceUri'];
  return typeof legacy === 'string' ? legacy : null;
}

/** The distinct `ui://` resources the tools point at. */
export function uiResourceUris(tools: readonly ToolLike[]): string[] {
  return [...new Set(tools.flatMap((tool) => uiResourceUriOf(tool) ?? []))];
}

const CSP_LIST_KEYS = [
  'connectDomains',
  'resourceDomains',
  'frameDomains',
  'baseUriDomains',
] as const;
const CSP_KEYWORDS = new Set(["'self'", "'unsafe-inline'", "'unsafe-eval'", "'none'", 'self']);

export interface CspProblem {
  severity: 'error' | 'warn';
  id: 'ui.csp-wildcard' | 'ui.csp-insecure' | 'ui.csp-broad' | 'ui.csp-invalid';
  message: string;
}

/** Judge one CSP allowlist entry. */
export function judgeCspEntry(key: string, entry: unknown): CspProblem | null {
  if (typeof entry !== 'string' || entry.trim().length === 0) {
    return {
      severity: 'error',
      id: 'ui.csp-invalid',
      message: `${key} has a non-string or empty entry.`,
    };
  }
  const value = entry.trim();
  if (value === '*' || /^[a-z][a-z0-9+.-]*:$/i.test(value)) {
    return {
      severity: 'error',
      id: 'ui.csp-wildcard',
      message: `${key} entry "${value}" allows every origin${value === '*' ? '' : ' of that scheme'}.`,
    };
  }
  if (CSP_KEYWORDS.has(value.toLowerCase())) {
    return {
      severity: 'error',
      id: 'ui.csp-wildcard',
      message: `${key} entry "${value}" is a CSP keyword, not an origin.`,
    };
  }
  let url: URL;
  try {
    url = new URL(value.replace('*.', 'wildcard.'));
  } catch {
    return {
      severity: 'error',
      id: 'ui.csp-invalid',
      message: `${key} entry "${value}" is not an origin.`,
    };
  }
  if (!['https:', 'http:', 'wss:', 'ws:'].includes(url.protocol)) {
    return {
      severity: 'error',
      id: 'ui.csp-invalid',
      message: `${key} entry "${value}" uses scheme ${url.protocol}.`,
    };
  }
  if (value.includes('*')) {
    return {
      severity: 'warn',
      id: 'ui.csp-broad',
      message: `${key} entry "${value}" uses a wildcard host; list exact origins where possible.`,
    };
  }
  if (url.protocol === 'http:' || url.protocol === 'ws:') {
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (!local) {
      return {
        severity: 'warn',
        id: 'ui.csp-insecure',
        message: `${key} entry "${value}" is not encrypted (use https / wss).`,
      };
    }
  }
  return null;
}

function cspOf(
  tool: ToolLike | undefined,
  content: UiResourceContent | undefined,
  read: Extract<UiResourceRead, { ok: true }>,
): { csp: unknown; where: string } | null {
  const sources: [string, Record<string, unknown> | undefined][] = [
    ['resource content', content?._meta],
    ['resources/read result', read.meta],
    ['tool', tool?._meta],
  ];
  for (const [where, meta] of sources) {
    const ui = asRecord(meta?.ui);
    if (ui !== null && 'csp' in ui) return { csp: ui.csp, where };
  }
  return null;
}

function contentBytes(content: UiResourceContent): number {
  if (typeof content.text === 'string') return Buffer.byteLength(content.text, 'utf8');
  if (typeof content.blob === 'string') return Buffer.from(content.blob, 'base64').byteLength;
  return 0;
}

function htmlOf(content: UiResourceContent): string {
  if (typeof content.text === 'string') return content.text;
  if (typeof content.blob === 'string') return Buffer.from(content.blob, 'base64').toString('utf8');
  return '';
}

/** Hosts a page loads code / frames from, to compare with the declared allowlists. */
export function externalHosts(html: string): string[] {
  const hosts = new Set<string>();
  const pattern =
    /<(?:script|link|iframe|img|source)\b[^>]*?\b(?:src|href)\s*=\s*["'](https?:\/\/[^"']+)["']/gi;
  for (const match of html.matchAll(pattern)) {
    try {
      hosts.add(new URL(match[1] as string).origin);
    } catch {
      // ignore unparsable references
    }
  }
  return [...hosts];
}

function allowedOrigins(csp: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of CSP_LIST_KEYS) {
    const list = csp[key];
    if (Array.isArray(list)) for (const item of list) if (typeof item === 'string') out.push(item);
  }
  return out;
}

export function checkUiResource(
  uri: string,
  tool: ToolLike | undefined,
  facts: UiResourceFacts | undefined,
): Check[] {
  const checks: Check[] = [];
  if (!uri.startsWith('ui://')) {
    checks.push(
      makeCheck('ui.resource-uri', 'error', `_meta.ui.resourceUri "${uri}" is not a ui:// URI.`, {
        subject: uri,
        hint: 'MCP Apps resources use the ui:// scheme, e.g. ui://myapp/dashboard.html.',
      }),
    );
    return checks;
  }
  if (facts === undefined || !facts.read.ok) {
    checks.push(
      makeCheck(
        'ui.resource-missing',
        'error',
        `resources/read ${uri} failed${facts !== undefined && !facts.read.ok ? `: ${facts.read.error}` : '.'}`,
        {
          subject: uri,
          hint: 'Serve the HTML through resources/read and declare the resources capability.',
        },
      ),
    );
    return checks;
  }
  const read = facts.read;
  const content = read.contents[0];
  if (content === undefined) {
    checks.push(
      makeCheck('ui.resource-missing', 'error', `resources/read ${uri} returned no contents.`, {
        subject: uri,
      }),
    );
    return checks;
  }
  checks.push(makeCheck('ui.resource', 'info', `${uri} is readable.`, { subject: uri }));

  if (content.mimeType !== MCP_APP_MIME) {
    checks.push(
      makeCheck(
        'ui.mime',
        'warn',
        `Resource mimeType is "${content.mimeType ?? '(none)'}", expected "${MCP_APP_MIME}".`,
        {
          subject: uri,
          hint: `Return mimeType "${MCP_APP_MIME}" so hosts render it as an MCP App.`,
        },
      ),
    );
  }
  const bytes = contentBytes(content);
  if (bytes === 0) {
    checks.push(
      makeCheck('ui.html-size', 'error', 'The UI resource is empty.', {
        subject: uri,
        hint: 'Return the HTML in `text` (or base64 in `blob`).',
      }),
    );
  } else if (bytes > UI_HTML_MAX_BYTES) {
    checks.push(
      makeCheck(
        'ui.html-size',
        'error',
        `The UI HTML is ${bytes} bytes (max ${UI_HTML_MAX_BYTES}).`,
        {
          subject: uri,
          hint: 'Load large assets from allowlisted origins instead of inlining them.',
        },
      ),
    );
  } else if (bytes > UI_HTML_WARN_BYTES) {
    checks.push(
      makeCheck(
        'ui.html-size',
        'warn',
        `The UI HTML is ${bytes} bytes (over ${UI_HTML_WARN_BYTES}).`,
        {
          subject: uri,
          hint: 'Large inline pages slow the first render.',
        },
      ),
    );
  }

  const found = cspOf(tool, content, read);
  const cspRecord = found === null ? null : asRecord(found.csp);
  if (found === null || cspRecord === null) {
    checks.push(
      makeCheck(
        'ui.csp-missing',
        'error',
        found === null
          ? '_meta.ui.csp is not declared; the host would have to block all network access or guess.'
          : '_meta.ui.csp is not an object.',
        {
          subject: uri,
          hint: 'Declare _meta.ui.csp with explicit allowlists, e.g. { "connectDomains": ["https://api.example.com"], "resourceDomains": [] }. An empty object means no external access.',
        },
      ),
    );
    return checks;
  }
  let problems = 0;
  for (const key of CSP_LIST_KEYS) {
    const list = cspRecord[key];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      problems += 1;
      checks.push(
        makeCheck('ui.csp-invalid', 'error', `${key} must be an array of origins.`, {
          subject: uri,
        }),
      );
      continue;
    }
    for (const entry of list) {
      const problem = judgeCspEntry(key, entry);
      if (problem === null) continue;
      if (problem.severity === 'error') problems += 1;
      checks.push(
        makeCheck(problem.id, problem.severity, problem.message, {
          subject: uri,
          hint: 'List exact https origins (https://api.example.com), never "*" or a bare scheme.',
        }),
      );
    }
  }
  if (problems === 0) {
    checks.push(
      makeCheck(
        'ui.csp',
        'info',
        `_meta.ui.csp declares explicit allowlists (found on the ${found.where}).`,
        {
          subject: uri,
          details: Object.fromEntries(CSP_LIST_KEYS.map((key) => [key, cspRecord[key] ?? []])),
        },
      ),
    );
  }
  const allowed = allowedOrigins(cspRecord);
  const undeclared = externalHosts(htmlOf(content)).filter(
    (origin) =>
      !allowed.some(
        (entry) => entry === origin || (entry.includes('*') && wildcardMatches(entry, origin)),
      ),
  );
  if (undeclared.length > 0) {
    checks.push(
      makeCheck(
        'ui.csp-undeclared-origin',
        'warn',
        `The page references origins that are not in the CSP allowlists: ${undeclared.join(', ')}.`,
        {
          subject: uri,
          hint: 'Add them to resourceDomains / frameDomains or the host will block them.',
          details: { origins: undeclared },
        },
      ),
    );
  }
  return checks;
}

function wildcardMatches(pattern: string, origin: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]+');
  return new RegExp(`^${escaped}$`).test(origin);
}

export function checkUiTools(
  tools: readonly ToolLike[],
  facts: ReadonlyMap<string, UiResourceFacts>,
): Check[] {
  const checks: Check[] = [];
  for (const uri of uiResourceUris(tools)) {
    const tool = tools.find((candidate) => uiResourceUriOf(candidate) === uri);
    checks.push(...checkUiResource(uri, tool, facts.get(uri)));
  }
  return checks;
}
