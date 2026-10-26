// Reads the shipped builtin connector entries (D104 P0b): the shipped connector
// catalog lives as one `server.json` per directory inside the builtin plugin
// com.kepcup/connections (was a single catalog.json before D104).
// Entry order = `contributions.connectors` order in the plugin manifest.
//
//   import { readBundledConnectorEntries } from './lib/builtin-connectors.mjs';
//   const entries = readBundledConnectorEntries();          // repo checkout
//   const entries = readBundledConnectorEntries(otherRoot); // explicit repo root
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const BUNDLED_CONNECTIONS_PLUGIN_DIR = path.join(
  DEFAULT_ROOT,
  'apps/desktop/resources/plugins/com.kepcup/connections',
);

/** `[server.json, …]` in plugin.json order; throws when the plugin tree is missing. */
export function readBundledConnectorEntries(repoRoot = DEFAULT_ROOT) {
  const pluginDir = path.join(
    repoRoot,
    'apps/desktop/resources/plugins/com.kepcup/connections',
  );
  const manifest = JSON.parse(
    readFileSync(path.join(pluginDir, 'plugin.json'), 'utf8'),
  );
  const contributions = manifest?.contributions?.connectors;
  if (!Array.isArray(contributions)) {
    throw new Error(`malformed plugin manifest: ${path.join(pluginDir, 'plugin.json')}`);
  }
  return contributions.map((contribution) =>
    JSON.parse(readFileSync(path.join(pluginDir, ...String(contribution.file).split('/')), 'utf8')),
  );
}
