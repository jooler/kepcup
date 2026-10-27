// Reads the official connector entries for the connector directory channel
// (dl.kepcup.com/connectors/v1): one `server.json` per connector plugin in the
// repo's `plugins/connector-<slug>/` development directory (D104: the former
// builtin plugin com.kepcup/connections was split into per-connector marketplace
// plugins; the directory channel keeps curating the same entries from here).
//
//   import { readBundledConnectorEntries } from './lib/builtin-connectors.mjs';
//   const entries = readBundledConnectorEntries();          // repo checkout
//   const entries = readBundledConnectorEntries(otherRoot); // explicit repo root
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const BUNDLED_CONNECTIONS_PLUGIN_DIR = path.join(DEFAULT_ROOT, 'plugins');

/**
 * `[server.json, …]` sorted by slug; throws when the plugin tree is missing.
 * Curation override: the server.json files carry `tier: "community"` (what a
 * third-party submission must claim), but these are KepCup first-party
 * connectors — the directory channel publishes them as `verified` (the review
 * this tier claims is ours; installed plugins carry the marketplace tier anyway).
 */
export function readBundledConnectorEntries(repoRoot = DEFAULT_ROOT) {
  const pluginsDir = path.join(repoRoot, 'plugins');
  const slugs = readdirSync(pluginsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('connector-'))
    .map((e) => e.name.slice('connector-'.length))
    .sort();
  if (slugs.length === 0) {
    throw new Error(`no connector-* plugins under ${pluginsDir}`);
  }
  return slugs.map((slug) => {
    const entry = JSON.parse(
      readFileSync(
        path.join(pluginsDir, `connector-${slug}`, 'connectors', slug, 'server.json'),
        'utf8',
      ),
    );
    const meta = entry?._meta?.['app.kepcup/connector'];
    if (meta && meta.tier === 'community') meta.tier = 'verified';
    return entry;
  });
}
