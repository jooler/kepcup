import { createHash } from 'node:crypto';
import path from 'node:path';

import { WSL_CACHE_ROOT, WSL_MOUNT_ROOT, WSL_TOOLCHAINS_ROOT, WSL_WORKSPACES_ROOT } from './constants.js';

/**
 * Windows path ↔ distro path conversion (docs/dev/phases/P12 任务 4). Pure
 * functions; the WSL backend maps every Windows path of a sandbox policy
 * through the mount plan before it reaches the in-distro shim, so nothing
 * inside the distro ever sees a Windows path it has no mount for.
 *
 * Windows comparisons are case-insensitive (docs/dev/01-conventions.md) —
 * matching here lowercases drive letters and path segments. UNC paths
 * (\\server\share, \\wsl$\…) and drive paths (C:\…) are both recognized;
 * paths with spaces are safe end to end because mounts are addressed by
 * their hash mountpoint, never by the raw path (mounts.ts).
 */

/** True when `candidate` is a Windows absolute path we could ever mount. */
export function isWindowsAbsolutePath(candidate: string): boolean {
  if (/^[a-zA-Z]:[\\/]/.test(candidate)) return true;
  // UNC: \\server\share or //server/share — but never the \\wsl$ /
  // \\wsl.localhost 9P shares: those point back into a distro, not at a
  // Windows directory drvfs could mount.
  if (/^\\\\[^\\]/.test(candidate) || /^\/\/[^/]/.test(candidate)) {
    return !isWslUncPath(candidate);
  }
  return false;
}

/** True for the `\\wsl$\<distro>` / `\\wsl.localhost\<distro>` 9P shares. */
export function isWslUncPath(candidate: string): boolean {
  return /^\\\\(?:wsl\$|wsl\.localhost)\\/i.test(candidate) || /^\/\/(?:wsl\$|wsl\.localhost)\//i.test(candidate);
}

/** Case-insensitive Windows path normalization used for comparisons only. */
export function normalizeWindowsKey(candidate: string): string {
  return candidate.replaceAll('/', '\\').toLowerCase();
}

/** True when both paths are the same Windows path (case-insensitive, both separators). */
export function sameWindowsPath(a: string, b: string): boolean {
  return normalizeWindowsKey(a) === normalizeWindowsKey(b);
}

/** True when `candidate` equals or lives underneath `root` (Windows rules). */
export function isInsideWindowsPath(candidate: string, root: string): boolean {
  const candidateKey = normalizeWindowsKey(candidate);
  const rootKey = normalizeWindowsKey(root);
  if (candidateKey === rootKey) return true;
  const rootWithSep = rootKey.endsWith('\\') ? rootKey : `${rootKey}\\`;
  return candidateKey.startsWith(rootWithSep);
}

/**
 * One registered mount: a Windows directory visible inside the distro at a
 * fixed mountpoint. Mountpoints are content-addressed
 * (`/mnt/kepcup/<16 hex of sha256(canonical source)>`) so two policies over the
 * same directory agree, and the mount script only ever accepts validated
 * mountpoints (mounts.ts), never raw Windows paths.
 */
export interface DistroMount {
  /** Canonical Windows source directory. */
  source: string;
  /** In-distro mountpoint under /mnt/kepcup. */
  mountpoint: string;
  mode: 'ro' | 'rw';
}

/** Deterministic mountpoint for a canonical Windows source path. */
export function mountpointFor(source: string): string {
  const hash = createHash('sha256').update(normalizeWindowsKey(source)).digest('hex');
  return `${WSL_MOUNT_ROOT}/${hash.slice(0, 16)}`;
}

/**
 * Maps a Windows policy path to its in-distro location using the planned
 * mounts (exact match or a path inside a mounted directory). Returns null
 * when no mount covers the path — the backend fails closed on that
 * (unmapped paths would silently escape the policy if translated naively).
 * Distro-internal locations (cache root, toolchain root, workspaces root)
 * pass through unchanged.
 */
export function windowsToDistroPath(
  windowsPath: string,
  mounts: readonly DistroMount[],
): string | null {
  for (const mount of mounts) {
    if (sameWindowsPath(windowsPath, mount.source)) return mount.mountpoint;
    if (isInsideWindowsPath(windowsPath, mount.source)) {
      const rel = normalizeWindowsKey(windowsPath).slice(normalizeWindowsKey(mount.source).length);
      const relDistro = rel.replaceAll('\\', '/');
      return `${mount.mountpoint}${relDistro.startsWith('/') ? relDistro : `/${relDistro}`}`;
    }
  }
  return null;
}

/**
 * `\\wsl$` UNC form of a distro path (docs 任务书 "workspace 通过
 * \\wsl$\Kepcup\... 访问"): the Windows-side spelling of anything that
 * lives inside the distro filesystem. Used by tooling and diagnostics; the
 * workspace itself stays a Windows directory in P12 (drvfs mount), see
 * docs/dev/PROGRESS.md P12 裁决.
 */
export function wslUncPath(distroPath: string, distroName: string): string {
  const withoutDrive = distroPath.startsWith('/') ? distroPath : `/${distroPath}`;
  return `\\\\wsl$\\${distroName}${withoutDrive.replaceAll('/', '\\')}`;
}

/** In-distro path of a bot's workspace when the distro filesystem is used. */
export function distroWorkspacePath(botId: string, conversationId: string): string {
  return path.posix.join(WSL_WORKSPACES_ROOT, botId, conversationId);
}

/** In-distro cache directory for one tool (npm/pip/xdg/cargo/uv). */
export function distroCachePath(name: string): string {
  return path.posix.join(WSL_CACHE_ROOT, name);
}

/** In-distro toolchain directory for one installed item version (P06). */
export function distroToolchainPath(item: string, version: string): string {
  return path.posix.join(WSL_TOOLCHAINS_ROOT, item, version);
}

/**
 * Maps a violation/deny line path reported by the in-distro srt back to its
 * Windows spelling when it points into a mount (best-effort display only —
 * the model sees these hints to request access).
 */
export function distroToWindowsPath(distroPath: string, mounts: readonly DistroMount[]): string | null {
  for (const mount of mounts) {
    const prefix = mount.mountpoint.endsWith('/') ? mount.mountpoint : `${mount.mountpoint}/`;
    if (distroPath === mount.mountpoint || distroPath.startsWith(prefix)) {
      const rel = distroPath.slice(mount.mountpoint.length).replaceAll('/', '\\');
      return rel.length > 0 ? `${mount.source}${rel}` : mount.source;
    }
  }
  return null;
}
