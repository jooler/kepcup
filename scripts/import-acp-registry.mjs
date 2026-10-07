#!/usr/bin/env node
// Exports AgentCatalogEntry skeletons from the ACP Registry (D72,
// docs/design/28-external-agents-acp.md §2.1, todo/acp-external-agents.md §11).
//
//   node scripts/import-acp-registry.mjs <id> [<id>...] [--registry <url|file>] [--hash]
//
// Prints a JSON array of entries for packages/shared/src/domain/agent-catalog.ts.
// Registry fields are copied verbatim; the KepCup extension fields (provider,
// transport, tier, nativeCapabilities, auth, terms, releaseGate) get
// conservative placeholders that MUST be reviewed by hand. `--hash` downloads
// every binary archive lacking a sha256 (Cursor, Antigravity …), computes it
// and pins it into the entry; without it such entries are reported and the
// script exits non-zero (the catalog schema requires a sha256 per archive).
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const DEFAULT_REGISTRY = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';

function parseArgs(argv) {
  const ids = [];
  let registry = DEFAULT_REGISTRY;
  let hash = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--registry') registry = argv[++i];
    else if (arg === '--hash') hash = true;
    else if (arg === '--help' || arg === '-h') return null;
    else ids.push(arg);
  }
  return ids.length > 0 && registry ? { ids, registry, hash } : null;
}

async function loadRegistry(source) {
  const text = /^https?:\/\//.test(source)
    ? await fetch(source).then((response) => {
        if (!response.ok) throw new Error(`registry fetch failed: HTTP ${response.status}`);
        return response.text();
      })
    : await readFile(source, 'utf8');
  const parsed = JSON.parse(text);
  const agents = Array.isArray(parsed) ? parsed : parsed.agents;
  if (!Array.isArray(agents)) throw new Error('registry JSON has no "agents" array');
  return agents;
}

async function sha256Of(url) {
  const response = await fetch(url);
  if (!response.ok || response.body === null) {
    throw new Error(`download failed (${url}): HTTP ${response.status}`);
  }
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of response.body) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  console.error(`  sha256 ${url} (${(bytes / 1024 / 1024).toFixed(1)} MiB)`);
  return hash.digest('hex');
}

function pick(object, keys) {
  const result = {};
  for (const key of keys) if (object?.[key] !== undefined) result[key] = object[key];
  return result;
}

async function toEntry(agent, { hash }) {
  const distribution = {};
  const missing = [];
  const source = agent.distribution ?? {};
  if (source.npx) distribution.npx = pick(source.npx, ['package', 'args', 'env']);
  if (source.uvx) distribution.uvx = pick(source.uvx, ['package', 'args']);
  if (source.binary) {
    distribution.binary = {};
    for (const [platform, target] of Object.entries(source.binary)) {
      const pinned = pick(target, ['archive', 'cmd', 'args', 'sha256']);
      if (pinned.sha256 === undefined) {
        if (hash) pinned.sha256 = await sha256Of(pinned.archive);
        else missing.push(`${agent.id}:${platform}`);
      }
      distribution.binary[platform] = pinned;
    }
  }
  return {
    entry: {
      ...pick(agent, ['id', 'name', 'version', 'description', 'repository', 'website']),
      authors: agent.authors ?? [],
      license: agent.license ?? 'UNKNOWN',
      // Icons ship with the app (apps/desktop/resources/agents/), never the CDN.
      icon: `${agent.id}.svg`,
      distribution,
      // —— KepCup extension fields: placeholders, review by hand ——
      provider: 'generic-acp',
      transport: 'acp',
      tier: 'preview',
      nativeCapabilities: {},
      auth: { kinds: [], note: 'TODO: 登录 / 计费方式（P0 spike 后补）' },
      releaseGate: agent.id,
    },
    missing,
  };
}

const args = parseArgs(process.argv.slice(2));
if (args === null) {
  console.error(
    'usage: node scripts/import-acp-registry.mjs <id> [<id>...] [--registry <url|file>] [--hash]',
  );
  process.exit(2);
}

const agents = await loadRegistry(args.registry);
const entries = [];
const missing = [];
for (const id of args.ids) {
  const agent = agents.find((candidate) => candidate.id === id);
  if (agent === undefined) {
    console.error(`unknown registry id: ${id}`);
    process.exit(1);
  }
  const result = await toEntry(agent, args);
  entries.push(result.entry);
  missing.push(...result.missing);
}
process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
if (missing.length > 0) {
  console.error(`binary archives without sha256 (re-run with --hash): ${missing.join(', ')}`);
  process.exit(1);
}
