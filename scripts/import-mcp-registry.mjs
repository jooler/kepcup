#!/usr/bin/env node
// Exports a connected-apps catalog entry skeleton from the official MCP Registry
// (D73 P1 §5.2, docs/design/29-connected-apps.md §4).
//
//   node scripts/import-mcp-registry.mjs <registry-name> [<name>...] [--registry <base-url|file>]
//
// Looks each name up via the Registry API (`GET {base}/v0.1/servers/{name}/versions/latest`,
// https://github.com/modelcontextprotocol/registry) — or in a local JSON file holding
// `{ servers: [{ server, _meta }] }` / `[...]` / one `{ server }` — and prints a JSON array of
// entries for apps/desktop/resources/connectors/catalog.json. Registry fields are copied
// verbatim (only the subset the catalog schema knows); `_meta["app.kepcup/connector"]` gets
// placeholders that MUST be completed by hand: the privacy policy is left as the literal
// "TODO" so the entry fails the catalog contract test until a human fills it in. Nothing is
// ever written to the catalog automatically, and the release gate is NOT opened here.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const DEFAULT_REGISTRY = 'https://registry.modelcontextprotocol.io';
export const META_KEY = 'app.kepcup/connector';

/** Unwraps both registry shapes: `{ server, _meta }` and a bare server.json. */
function unwrap(item) {
  return item && typeof item === 'object' && item.server ? item.server : item;
}

/** Looks a name up in a base URL (API) or a local file. `fetchImpl` is injectable. */
export async function fetchServerJson(
  name,
  { registry = DEFAULT_REGISTRY, fetch: fetchImpl = fetch } = {},
) {
  if (/^https?:\/\//.test(registry)) {
    const url = `${registry.replace(/\/$/, '')}/v0.1/servers/${encodeURIComponent(name)}/versions/latest`;
    const response = await fetchImpl(url, { headers: { accept: 'application/json' } });
    if (response.status === 404) throw new Error(`unknown registry name: ${name}`);
    if (!response.ok) throw new Error(`registry fetch failed (${url}): HTTP ${response.status}`);
    return unwrap(await response.json());
  }
  const parsed = JSON.parse(await readFile(registry, 'utf8'));
  const list = Array.isArray(parsed) ? parsed : (parsed.servers ?? [parsed]);
  // Several versions of one name may be listed: prefer the one flagged latest, else the last.
  const matches = list.filter((item) => unwrap(item)?.name === name);
  if (matches.length === 0) throw new Error(`unknown registry name: ${name}`);
  const latest = matches.find(
    (item) => item?._meta?.['io.modelcontextprotocol.registry/official']?.isLatest,
  );
  return unwrap(latest ?? matches[matches.length - 1]);
}

/** `[a-z0-9]{2,16}` slug candidate from the registry name's tail (`com.notion/mcp` -> `notion`). */
export function slugFromName(name) {
  const [namespace, tail = ''] = name.split('/');
  const generic = new Set(['mcp', 'server', 'mcpserver']);
  const labels = namespace.split('.').reverse(); // io.github.x -> x, github, io
  const candidates = [tail, ...labels].map((value) =>
    value.toLowerCase().replace(/[^a-z0-9]/g, ''),
  );
  const picked = candidates.find(
    (value) =>
      value.length >= 2 && !generic.has(value) && !['io', 'com', 'app', 'github'].includes(value),
  );
  return (picked ?? candidates.find((value) => value.length >= 2) ?? 'todo')
    .slice(0, 16)
    .padEnd(2, '0');
}

/** Pure conversion: registry server.json -> `{ entry, todo[] }` (todo = fields to review). */
export function toSkeleton(server) {
  const todo = [];
  const slug = slugFromName(server.name);
  const remotes = [];
  for (const remote of server.remotes ?? []) {
    if (remote.type !== 'streamable-http' && remote.type !== 'sse') continue;
    if (remote.headers?.length || remote.variables) {
      todo.push(
        `remotes: ${remote.url} declares headers/variables (dropped; catalog supports plain URL remotes only)`,
      );
    }
    if (/\{[^}]+\}/.test(remote.url)) todo.push(`remotes: ${remote.url} is a URL template`);
    remotes.push({ type: remote.type, url: remote.url });
  }
  if (!remotes.some((remote) => remote.type === 'streamable-http')) {
    todo.push('remotes: no streamable-http remote (P1 only connects streamable-http)');
  }
  const packages = [];
  for (const pkg of server.packages ?? []) {
    if (pkg.registryType === 'mcpb') {
      packages.push({
        registryType: 'mcpb',
        identifier: pkg.identifier,
        version: pkg.version,
        fileSha256: pkg.fileSha256,
      });
    }
  }
  const entry = {
    ...(server.$schema ? { $schema: server.$schema } : {}),
    name: server.name,
    title: server.title ?? server.name.split('/').pop(),
    description: server.description ?? '',
    version: server.version,
    ...(server.websiteUrl ? { websiteUrl: server.websiteUrl } : {}),
    remotes,
    ...(packages.length > 0 ? { packages } : {}),
    _meta: {
      // —— KepCup extension: placeholders, complete by hand ——
      [META_KEY]: {
        slug,
        icon: `${slug}.svg`,
        category: 'other',
        tier: 'community',
        auth: {
          kind: 'oauth',
          registration: 'auto',
          clientRef: null,
          scopes: { default: [], write: [] },
        },
        toolPolicy: {},
        skills: [],
        ui: false,
        privacyPolicy: 'TODO',
        releaseGate: slug,
      },
    },
  };
  if (!server.title) todo.push('title: registry has none (name tail used)');
  todo.push(
    '_meta: privacyPolicy, category, tier, auth, toolPolicy, whoami (run the spike + login test first)',
  );
  todo.push(
    `slug "${slug}" is derived from the name; confirm it is unique and add icons/${slug}.svg`,
  );
  return { entry, todo };
}

function parseArgs(argv) {
  const names = [];
  let registry = DEFAULT_REGISTRY;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--registry') registry = argv[++i];
    else if (arg === '--help' || arg === '-h') return null;
    else names.push(arg);
  }
  return names.length > 0 && registry ? { names, registry } : null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args === null) {
    console.error(
      'usage: node scripts/import-mcp-registry.mjs <registry-name> [<name>...] [--registry <base-url|file>]',
    );
    process.exit(2);
  }
  const entries = [];
  for (const name of args.names) {
    let server;
    try {
      server = await fetchServerJson(name, { registry: args.registry });
    } catch (error) {
      console.error(String(error?.message ?? error));
      process.exit(1);
    }
    const { entry, todo } = toSkeleton(server);
    entries.push(entry);
    for (const line of todo) console.error(`[${name}] TODO ${line}`);
  }
  process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
