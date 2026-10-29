import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pluginIconDataUriFromBytes, type PluginManifest } from '@kepcup/shared';

/**
 * Plugin icon projection (`PluginSummary.iconDataUri`).
 *
 * The manifest's top-level `icon` is an in-package relative path (schema-checked, so
 * no absolute path / `..` can slip through here either). The file is read once per
 * summary build and inlined as a data URI: the renderer never receives filesystem
 * paths and an unusable icon degrades to `null`, where the UI's default icon takes
 * over. Extension / magic-byte / size rules live in `pluginIconDataUriFromBytes` and are
 * shared with the marketplace signer, which embeds the same icon into the signed index.
 */

/** Null when the manifest declares no icon, the file is missing / outside the dir, or it is not a usable icon. */
export function pluginIconDataUri(
  dir: string | null,
  manifest: Pick<PluginManifest, 'icon'> | null,
): string | null {
  if (dir === null || manifest === null) return null;
  const icon = manifest.icon;
  if (icon === undefined || icon.length === 0) return null;
  let realDir: string;
  let realIcon: string;
  try {
    realDir = realpathSync(dir);
    realIcon = realpathSync(path.join(dir, ...icon.split('/')));
  } catch {
    return null;
  }
  if (realIcon !== realDir && !realIcon.startsWith(realDir + path.sep)) return null;
  try {
    return pluginIconDataUriFromBytes(icon, readFileSync(realIcon));
  } catch {
    return null;
  }
}
