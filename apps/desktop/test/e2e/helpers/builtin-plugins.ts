import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * e2e helper (D104 P0b): copies the shipped builtin plugins tree
 * (`apps/desktop/resources/plugins`) into a temp directory, optionally keeping
 * only a subset of the connector entries (rewriting the connections
 * plugin.json accordingly) or dropping the skills plugin entirely. The returned
 * directory is what `KEPCUP_BUILTIN_PLUGINS` should point at.
 */

/** Repo-relative resolution: e2e specs run with cwd = apps/desktop. */
function shippedPluginsDir(): string {
  return path.resolve('resources', 'plugins');
}

export interface CopyShippedPluginsOptions {
  /** Given, only these connector slugs survive (plugin.json rewritten to match). */
  connectorSlugs?: string[];
  /** `'none'` removes the starter-skills plugin (default keeps everything). */
  skills?: 'all' | 'none';
}

/** Copies the shipped resources/plugins into `dest` and returns that directory. */
export async function copyShippedPlugins(
  dest: string,
  options: CopyShippedPluginsOptions = {},
): Promise<string> {
  const shipped = shippedPluginsDir();
  await mkdir(path.dirname(dest), { recursive: true });
  await cp(shipped, dest, { recursive: true });
  if (options.skills === 'none') {
    await rm(path.join(dest, 'com.kepcup', 'starter-skills'), { recursive: true, force: true });
  }
  if (options.connectorSlugs !== undefined) {
    const pluginDir = path.join(dest, 'com.kepcup', 'connections');
    const manifestPath = path.join(pluginDir, 'plugin.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      contributions: { connectors: Array<{ file: string }> };
    };
    const wanted = new Set(options.connectorSlugs);
    const kept: Array<{ file: string }> = [];
    for (const contribution of manifest.contributions.connectors) {
      const slug = path.basename(path.dirname(contribution.file));
      if (wanted.has(slug)) {
        kept.push(contribution);
      } else {
        await rm(path.join(pluginDir, ...contribution.file.split('/')), {
          force: true,
          recursive: true,
        });
      }
    }
    manifest.contributions.connectors = kept;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return dest;
}
