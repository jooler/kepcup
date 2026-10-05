import { homedir } from 'node:os';
import path from 'node:path';

import { WSL_MOUNT_ROOT, WSL_USER_HOME } from './constants.js';
import { distroCachePath } from './paths.js';
import { isInsidePath } from '../sensitive-paths.js';
import { isInsideWindowsPath, isWindowsAbsolutePath, mountpointFor, normalizeWindowsKey, sameWindowsPath, windowsToDistroPath, type DistroMount } from './paths.js';
import type { SandboxPolicy } from '../types.js';

/**
 * Dynamic mount planning — the security boundary of the P12 backends
 * (docs/dev/phases/P12 任务 5). Mounting is the ONLY way a host directory
 * becomes visible inside the WSL distro (automount disabled), a Podman
 * container (per-command binds) or the Lima VM (provisioned mounts); so the
 * mount plan decides what the sandbox can touch at all:
 *
 * 红线：only directories that a `MountRegistration` has explicitly allowed
 * (the app-owned data home, the bound project, effective grants) may ever be
 * mounted. A policy path without a registered ancestor is NOT mounted and
 * the whole exec fails closed — a silently narrower policy would look like
 * success while the command runs against a different filesystem view.
 *
 * Two carve-outs, both app-owned constants rather than model-reachable
 * input:
 *  - policy cache directories are rewritten to the distro-internal cache
 *    root (WSL) — never mounted;
 *  - the static read-only roots (system directories and home toolchain
 *    directories from sandbox/sensitive-paths readOnlyRoots) are mounted
 *    read-only without registration; system roots are skipped entirely
 *    (the image ships its own system).
 *
 * Pure functions; the rejection behavior is unit-tested
 * (packages/core/test/unit/wsl-mounts.test.ts).
 */

/**
 * The directories mounting is allowed for, provided by start.ts from the
 * domain state (bound projects, active grants) plus the app-owned roots.
 * Windows paths compare case-insensitively with both separators; POSIX
 * paths via isInsidePath.
 */
export interface MountRegistration {
  registeredWindowsPaths(): readonly string[];
}

/** Shared authorization walk output (one entry per planned bind). */
export interface ResolvedMount {
  source: string;
  mode: 'ro' | 'rw';
  role: 'workspace' | 'grant' | 'app-root';
}

export interface ResolveOptions {
  cwd: string;
  registration: MountRegistration;
  /** Static read-only roots (readOnlyRoots(platform)) — mount ro, no registration. */
  trustedReadOnlyRoots?: readonly string[];
  /** Host home directory (system-root detection); defaults os.homedir(). */
  homeDir?: string;
  /** Host cache dirs → in-distro cache names (WSL backend passes these). */
  cacheDirs?: readonly CacheDirMapping[];
  /**
   * Host read-only roots the backend deliberately keeps OUT of the image
   * (BR-P12-003, WSL: the distro ships its own toolchains — projecting the
   * host's Windows-side `~/.cargo`/`~/go`/… binaries into a Linux distro is
   * useless surface). Policy entries inside these roots are skipped: no
   * mount, and — critically — no rejection.
   */
  skipReadOnlyRoots?: readonly string[];
}

export interface CacheDirMapping {
  /** Host path of the cache directory (canonical). */
  path: string;
  /** In-distro name under the cache root (npm / pip / xdg / cargo / uv / pycache). */
  name: string;
}

export interface PolicyRejection {
  path: string;
  kind: string;
  reason: string;
}

export interface ResolvedPolicyMounts {
  entries: ResolvedMount[];
  rejections: PolicyRejection[];
}

/**
 * Walks the policy's readWrite/readOnly entries and resolves each into a
 * bind or a rejection. Never spawns anything.
 */
export function resolvePolicyMounts(policy: SandboxPolicy, options: ResolveOptions): ResolvedPolicyMounts {
  const home = options.homeDir ?? homedir();
  const sameOrInside = (candidate: string, root: string): boolean =>
    isWindowsCandidate(options.cwd, candidate) ? isInsideWindowsPath(candidate, root) : isInsidePath(candidate, root);

  const authorizedRoot = (candidate: string): string | null => {
    for (const root of options.registration.registeredWindowsPaths()) {
      if (sameOrInside(candidate, root)) return root;
    }
    return null;
  };

  // Entries are keyed case-insensitively for Windows paths (BR-P12-008):
  // mountpointFor already normalizes the case, so two spellings of the same
  // directory (`C:\Code\proj` vs `c:\code\proj`) must produce ONE planned
  // mount, not two entries racing on the same mountpoint.
  const entries = new Map<string, ResolvedMount>();
  const rejections: PolicyRejection[] = [];

  const addEntry = (source: string, mode: 'ro' | 'rw', role: ResolvedMount['role']): void => {
    const key = isWindowsCandidate(options.cwd, source) ? normalizeWindowsKey(source) : source;
    const existing = entries.get(key);
    if (existing !== undefined) {
      // A rw requirement upgrades a planned ro mount; never the reverse.
      if (mode === 'rw') existing.mode = 'rw';
      return;
    }
    entries.set(key, { source, mode, role });
  };

  const cacheFor = (entry: string): CacheDirMapping | null => {
    for (const cache of options.cacheDirs ?? []) {
      if (sameOrInside(entry, cache.path) && sameOrInside(cache.path, entry)) return cache;
    }
    return null;
  };

  /**
   * True for absolute system roots the image already provides (POSIX only —
   * Windows readOnlyRoots are home-scoped toolchain dirs). Anything outside
   * the host home and absolute is treated as system.
   */
  const isSystemRoot = (entry: string): boolean => {
    if (isWindowsCandidate(options.cwd, entry)) return false;
    if (!path.isAbsolute(entry)) return false;
    return !sameOrInside(entry, home);
  };

  for (const entry of policy.readWrite) {
    if (cacheFor(entry) !== null) continue; // caches are rewritten, not mounted
    if (isSystemRoot(entry)) continue;
    // Authorization against the registration; the mounted source is the
    // policy entry itself (e.g. the workspace directory), never its
    // registered ancestor — mounting the data home would expose everything.
    if (authorizedRoot(entry) === null) {
      rejections.push({
        path: entry,
        kind: 'readWrite',
        reason: '路径未登记（未绑定的 project、未授权目录或数据目录之外的路径不能进入沙箱）',
      });
      continue;
    }
    addEntry(entry, 'rw', 'workspace');
  }

  for (const entry of policy.readOnly) {
    if (cacheFor(entry) !== null) continue;
    if ((options.skipReadOnlyRoots ?? []).some((root2) => sameOrInside(entry, root2))) continue;
    if (isSystemRoot(entry)) continue; // image ships its own system
    if (authorizedRoot(entry) !== null) {
      addEntry(entry, 'ro', 'grant');
      continue;
    }
    // Static read-only roots (home toolchain dirs etc.) mount ro without
    // registration: they are app-owned constants, not model-reachable.
    const trusted = (options.trustedReadOnlyRoots ?? []).some((root2) => sameOrInside(entry, root2));
    if (trusted) {
      addEntry(entry, 'ro', 'app-root');
      continue;
    }
    rejections.push({
      path: entry,
      kind: 'readOnly',
      reason: '只读路径未登记且不属于静态只读白名单，拒绝进入沙箱',
    });
  }

  return { entries: [...entries.values()], rejections };
}

/**
 * Platform flavor for a path: Windows rules when either the cwd or the path
 * is a Windows absolute path (drive letter / UNC). The backend only runs
 * one flavor per machine, so this keeps the pure helpers self-describing.
 */
function isWindowsCandidate(cwd: string, candidate: string): boolean {
  return process.platform === 'win32' || isWindowsAbsolutePath(candidate) || /^[a-zA-Z]:[\\/]/.test(cwd) || cwd.startsWith('\\\\');
}

// --- WSL plan (hash mountpoints under /mnt/kepcup) -----------------------------------

export interface MountPlan {
  mounts: Array<DistroMount & { role: ResolvedMount['role'] }>;
  /**
   * Policy paths rewritten to their distro spelling for the shim (readWrite
   * / readOnly entries and the cwd). Cache entries are rewritten to the
   * in-distro cache root (never round-trip through NTFS).
   */
  distroReadWrites: string[];
  distroReadOnlys: string[];
  distroDenyReads: string[];
  distroCwd: string | null;
  /** Unregistered / unmappable policy paths — non-empty means refuse exec. */
  rejections: PolicyRejection[];
}

/** True when the distro-side mountpoint matches the script's strict shape. */
export function isValidMountpoint(candidate: string): boolean {
  return new RegExp(`^${WSL_MOUNT_ROOT}/[0-9a-f]{16}$`).test(candidate);
}

/** Base64url of the UTF-8 source path (argv-safe transport into kepcup-mount). */
export function encodeMountSource(source: string): string {
  return Buffer.from(source, 'utf8').toString('base64url');
}

export function decodeMountSource(encoded: string): string {
  return Buffer.from(encoded, 'base64url').toString('utf8');
}

/**
 * Plans the mounts + distro-side policy for one exec in the WSL distro.
 * The cwd must be covered by a planned mount or be distro-internal already;
 * anything else produces a rejection and the backend refuses to run.
 */
export function planMounts(policy: SandboxPolicy, options: ResolveOptions): MountPlan {
  const resolved = resolvePolicyMounts(policy, options);
  const mounts: Array<DistroMount & { role: ResolvedMount['role'] }> = resolved.entries.map((entry) => ({
    source: entry.source,
    mode: entry.mode,
    role: entry.role,
    mountpoint: mountpointFor(entry.source),
  }));

  const distroReadWrites: string[] = [];
  const distroReadOnlys: string[] = [];
  for (const entry of policy.readWrite) {
    const cache = cacheDirFor(entry, options.cacheDirs);
    if (cache !== null) {
      distroReadWrites.push(distroCachePath(cache.name));
      continue;
    }
    const mapped = windowsToDistroPath(entry, mounts);
    if (mapped !== null) distroReadWrites.push(mapped);
  }
  for (const entry of policy.readOnly) {
    if (cacheDirFor(entry, options.cacheDirs) !== null) continue;
    const mapped = windowsToDistroPath(entry, mounts);
    if (mapped !== null) distroReadOnlys.push(mapped);
  }

  // denyRead entries are paths that must stay INVISIBLE. Inside the distro
  // the default view is NOT free (BR-P12-001): srt's read model is deny-
  // then-allow, so without explicit denies EVERYTHING would be readable —
  // the whole mount root (other conversations' mounts still alive in the
  // shared VM: revoked one-time grants, other bots' directories) and the
  // distro user home (every bot's caches and image state). Both are denied
  // wholesale here; the plan's specific mountpoints and cache paths are
  // re-exposed by the shim config's allowRead/allowWrite (last match wins —
  // the same idiom the data-directory policy uses for the denied host home).
  const distroDenyReads: string[] = [WSL_MOUNT_ROOT, WSL_USER_HOME];
  for (const entry of policy.denyRead) {
    if (!isWindowsAbsolutePath(entry)) continue;
    const mapped = windowsToDistroPath(entry, mounts);
    if (mapped !== null) distroDenyReads.push(mapped);
  }

  let distroCwd: string | null;
  if (!isWindowsAbsolutePath(options.cwd)) {
    distroCwd = options.cwd;
  } else {
    distroCwd = windowsToDistroPath(options.cwd, mounts);
    if (distroCwd === null) {
      resolved.rejections.push({
        path: options.cwd,
        kind: 'cwd',
        reason: '工作目录未挂载，无法在发行版内定位',
      });
    }
  }

  return {
    mounts,
    distroReadWrites,
    distroReadOnlys,
    distroDenyReads,
    distroCwd,
    rejections: resolved.rejections,
  };
}

function cacheDirFor(entry: string, caches?: readonly CacheDirMapping[]): CacheDirMapping | null {
  for (const cache of caches ?? []) {
    if (sameWindowsPath(entry, cache.path)) return cache;
  }
  return null;
}

// --- container plan (1:1 binds) ---------------------------------------------------

/**
 * Container/Lima variant: every resolved mount binds at the IDENTICAL path
 * inside the VM (podman `-v src:src`, Lima provisioned mounts), so the
 * policy needs no path rewriting — only the authorization walk plus the cwd
 * coverage check. Any rejection refuses the whole command. The cwd coverage
 * check lives in backend-container.ts (`cwdCoverageRejections`) next to its
 * only consumer — the former `checkRegistration` wrapper here was src dead
 * code (BR-P12-007).
 */
