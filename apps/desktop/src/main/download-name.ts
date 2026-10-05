import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Download target naming for the browser host's `will-download` handler
 * (docs/dev/phases/P11-browser.md 任务 1). The filename comes from the remote
 * page (Content-Disposition / URL tail), so it is untrusted input: it is
 * flattened to a bare filename, separators and control characters are
 * replaced, and dot-only / leading-dot names (`.`、`..`、`.env`) are normalized
 * so the target can never escape the downloads directory (BR-P11-004).
 */

/** Flattens a page-supplied filename to a safe, non-hidden base name. */
export function sanitizeDownloadName(rawName: string): string {
  const stripped = path
    .basename(rawName)
    .replace(/[/\\:*?"<>|]/g, '_')
    .split('')
    .filter((ch) => ch.charCodeAt(0) >= 32)
    .join('');
  // `path.basename('..')` is '..' — joining that would point outside `dir`.
  const withoutLeadingDots = stripped.replace(/^\.+/, '');
  return withoutLeadingDots.length > 0 ? withoutLeadingDots : 'download';
}

/** Collision-free path inside `dir` for the sanitized name. */
export function uniqueDownloadPath(
  dir: string,
  rawName: string,
  exists: (candidate: string) => boolean = existsSync,
): string {
  const base = sanitizeDownloadName(rawName);
  const ext = path.extname(base);
  const stem = ext.length > 0 ? base.slice(0, base.length - ext.length) : base;
  let candidate = path.join(dir, base);
  for (let i = 1; i < 1000; i += 1) {
    if (!exists(candidate)) return candidate;
    candidate = path.join(dir, `${stem}-${i}${ext}`);
  }
  return path.join(dir, `${stem}-${Date.now()}${ext}`);
}
