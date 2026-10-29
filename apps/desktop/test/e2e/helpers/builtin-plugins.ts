import { cp, mkdir, readFile } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * e2e helper (D104 P0b; marketplace conversion): assembles a builtin-plugins
 * fixture directory from the repo's `plugins/` development tree — the former
 * shipped builtins com.kepcup/starter-skills + com.kepcup/connections now live
 * there as per-item marketplace plugins (`app.kepcup/skill-*` / `connector-*`).
 * The loader expects the `{namespace}/{name}/plugin.json` two-level layout, so
 * each selected plugin is copied under its manifest id's namespace. The
 * returned directory is what `KEPCUP_BUILTIN_PLUGINS` should point at.
 *
 * This is a content fixture for UI specs, not a statement about shipping:
 * real builds ship no builtin plugins at all.
 */

/** Repo-relative resolution: e2e specs run with cwd = apps/desktop. */
function repoPluginsDir(): string {
  return path.resolve('..', '..', 'plugins');
}

export interface CopyShippedPluginsOptions {
  /** Given, only these connector plugin dirs survive (by slug). */
  connectorSlugs?: string[];
  /** `'none'` removes the skill plugins (default keeps everything). */
  skills?: 'all' | 'none';
}

/** Copies the selected plugins from `plugins/` into `dest` and returns that directory. */
export async function copyShippedPlugins(
  dest: string,
  options: CopyShippedPluginsOptions = {},
): Promise<string> {
  const source = repoPluginsDir();
  const names = readdirSync(source, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  for (const name of names) {
    if (options.skills === 'none' && name.startsWith('skill-')) continue;
    if (
      name.startsWith('connector-') &&
      options.connectorSlugs !== undefined &&
      !options.connectorSlugs.includes(name.slice('connector-'.length))
    ) {
      continue;
    }
    const manifest = JSON.parse(await readFile(path.join(source, name, 'plugin.json'), 'utf8'));
    const namespace = String(manifest.id).split('/')[0];
    if (namespace === undefined || namespace.length === 0) continue;
    const target = path.join(dest, namespace, name);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(path.join(source, name), target, { recursive: true });
  }
  return dest;
}
