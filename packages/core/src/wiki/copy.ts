import { createHash } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from 'node:fs';
import path from 'node:path';

import { canonicalPath } from '../infra/paths.js';
import { isInsidePath } from '../sandbox/sensitive-paths.js';

/**
 * Wiki 移交复制的纯辅助（D88 P2，docs/design/37 §3.2）：页面里引用了哪些 `raw/` 原件与
 * D85 资产（`raw/_assets/{id}.json`、`raw/_derived/{id}/`、仓外 `wiki-store/{id}/`），以及
 * 文件级的复制 / 硬链接 / 比较。真正的两段式复制（来源锁内快照 → 目标锁内落盘）在
 * `WikiService.copyForHandover`。
 */

/** `pages/**.md`, wiki-root relative, POSIX separators, no `..`. */
export function isWikiPagePath(rel: string): boolean {
  return (
    rel.startsWith('pages/') &&
    rel.toLowerCase().endsWith('.md') &&
    !rel.split('/').some((part) => part === '..' || part === '.' || part.length === 0) &&
    !rel.includes('\\')
  );
}

/** A D85 asset id (`ast_…`; any safe single path segment is accepted). */
const ASSET_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Link targets of a markdown page: inline links / images, reference definitions, html src/href. */
const LINK_PATTERNS: readonly RegExp[] = [
  /\]\(\s*<([^>]+)>[^)]*\)/g,
  /\]\(\s*([^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g,
  /^\s{0,3}\[[^\]]+\]:\s*<?([^\s>]+)>?/gm,
  /\b(?:src|href)\s*=\s*["']([^"']+)["']/g,
];

/** What a set of pages references under `raw/` (wiki-root relative paths / asset ids). */
export interface WikiPageReferences {
  /** Plain raw files (`raw/…`, not under `_assets` / `_derived`). */
  rawFiles: Set<string>;
  /** D85 asset ids referenced through `raw/_assets/{id}.json` or `raw/_derived/{id}/…`. */
  assetIds: Set<string>;
}

/**
 * The `raw/` references of one page (relative links resolved against the page's directory).
 * Absolute URLs, anchors and anything escaping the wiki root are ignored.
 */
export function pageReferences(
  pageRel: string,
  content: string,
  into?: WikiPageReferences,
): WikiPageReferences {
  const refs = into ?? { rawFiles: new Set<string>(), assetIds: new Set<string>() };
  const baseDir = path.posix.dirname(pageRel);
  for (const pattern of LINK_PATTERNS) {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(content); match !== null; match = pattern.exec(content)) {
      let target = (match[1] ?? '').trim();
      if (target.length === 0 || target.startsWith('#') || target.startsWith('/')) continue;
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // http:, mailto:, data:, file: …
      target = target.split('#')[0]!.split('?')[0]!;
      try {
        target = decodeURI(target);
      } catch {
        // keep the raw form
      }
      const resolved = path.posix.normalize(path.posix.join(baseDir, target));
      if (resolved.startsWith('..') || !resolved.startsWith('raw/')) continue;
      const parts = resolved.split('/');
      if (parts.some((part) => part === '..')) continue;
      if (parts[1] === '_assets') {
        const id = (parts[2] ?? '').replace(/\.json$/i, '');
        if (parts.length === 3 && ASSET_ID.test(id)) refs.assetIds.add(id);
        continue;
      }
      if (parts[1] === '_derived') {
        const id = parts[2] ?? '';
        if (ASSET_ID.test(id)) refs.assetIds.add(id);
        continue;
      }
      if (parts.length >= 2 && (parts[parts.length - 1] ?? '').length > 0) {
        refs.rawFiles.add(resolved);
      }
    }
  }
  return refs;
}

/**
 * `rel` (wiki-root relative) resolved inside `root` with symlinks followed; null when it
 * escapes the root (or `rel` is malformed).
 */
export function resolveInside(root: string, rel: string): string | null {
  if (rel.length === 0 || path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) return null;
  const canonicalRoot = canonicalPath(root);
  const resolved = canonicalPath(path.join(root, rel));
  return isInsidePath(resolved, canonicalRoot) && resolved !== canonicalRoot ? resolved : null;
}

/** Every file under `dir` (relative POSIX paths), skipping the top-level `skip` entries. */
export function listFilesRecursive(dir: string, skip: readonly string[] = []): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (prefix.length === 0 && skip.includes(entry.name)) continue;
      const rel = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full, rel);
      else if (entry.isFile()) out.push(rel);
      // symlinks and other node types are never copied
    }
  };
  walk(dir, '');
  return out.sort();
}

const COMPARE_IN_MEMORY_MAX_BYTES = 32 * 1024 * 1024;

function sha256OfFile(file: string): string {
  const hash = createHash('sha256');
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

/** Byte-identical files (size first; large files compared by streaming sha256). */
export function sameFileContent(a: string, b: string): boolean {
  const sa = statSync(a);
  const sb = statSync(b);
  if (sa.size !== sb.size) return false;
  if (sa.ino === sb.ino && sa.dev === sb.dev) return true;
  if (sa.size <= COMPARE_IN_MEMORY_MAX_BYTES) return readFileSync(a).equals(readFileSync(b));
  return sha256OfFile(a) === sha256OfFile(b);
}

/**
 * Hard-links `from` to `to` (content-addressed, never rewritten in place — D85 writes the
 * store by atomic rename), falling back to a copy across devices / where links are not
 * allowed. `to` must not exist.
 */
export function linkOrCopy(from: string, to: string): 'link' | 'copy' {
  mkdirSync(path.dirname(to), { recursive: true });
  try {
    linkSync(from, to);
    return 'link';
  } catch {
    copyFileSync(from, to, fsConstants.COPYFILE_FICLONE);
    return 'copy';
  }
}

/** Copies `from` to `to` (reflink where the filesystem supports it). */
export function copyFile(from: string, to: string): void {
  mkdirSync(path.dirname(to), { recursive: true });
  copyFileSync(from, to, fsConstants.COPYFILE_FICLONE);
}
