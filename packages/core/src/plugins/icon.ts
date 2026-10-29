import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { PLUGIN_ICON_MAX_BYTES, type PluginManifest } from '@kepcup/shared';

/**
 * Plugin icon projection (`PluginSummary.iconDataUri`).
 *
 * The manifest's top-level `icon` is an in-package relative path (schema-checked, so
 * no absolute path / `..` can slip through here either). The file is read once per
 * summary build and inlined as a data URI: the renderer never receives filesystem
 * paths and an unusable icon degrades to `null`, where the UI's default icon takes
 * over. Only SVG / PNG are accepted, capped at 256 KiB so a summary stays cheap.
 */

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function looksLikeSvg(bytes: Buffer): boolean {
  const head = bytes.subarray(0, Math.min(bytes.length, 512)).toString('utf8').trimStart();
  return head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'));
}

function looksLikeIcon(bytes: Buffer, ext: string): boolean {
  if (ext === '.png') return bytes.subarray(0, 8).equals(PNG_SIGNATURE);
  return looksLikeSvg(bytes);
}

/** Null when the manifest declares no icon, the file is missing / outside the dir, or it is not a usable icon. */
export function pluginIconDataUri(
  dir: string | null,
  manifest: Pick<PluginManifest, 'icon'> | null,
): string | null {
  if (dir === null || manifest === null) return null;
  const icon = manifest.icon;
  if (icon === undefined || icon.length === 0) return null;
  const ext = path.extname(icon).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (mime === undefined) return null;
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
    const bytes = readFileSync(realIcon);
    if (bytes.length === 0 || bytes.length > PLUGIN_ICON_MAX_BYTES) return null;
    if (!looksLikeIcon(bytes, ext)) return null;
    return `data:${mime};base64,${bytes.toString('base64')}`;
  } catch {
    return null;
  }
}
