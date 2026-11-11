import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { canonicalPath, type AppPaths } from '../infra/paths.js';
import { sensitivePaths, readOnlyRoots } from './sensitive-paths.js';
import type { SandboxNetworkPolicy, SandboxPolicy } from './types.js';
import { expressibleDomainDirs } from '../workdir/domains.js';
import type { Grant } from '@kepcup/shared';

export interface PolicyWorkdir {
  /** Canonical workdir directory. */
  path: string;
  /** True when this run holds the workdir write lease. */
  hasLease: boolean;
  /** Absolute glob patterns that stay unread (workdir protect rules). */
  denyReadGlobs: string[];
}

export interface PolicyInput {
  platform: string;
  paths: AppPaths;
  /** The executing bot's workspace; created before the policy is built. */
  workspacePath: string;
  network: SandboxNetworkPolicy;
  /** Active grants of the executing bot in the current conversation (P03). */
  grants?: Grant[];
  /** The conversation's bound workdir (P04). */
  workdir?: PolicyWorkdir;
  /**
   * P06 installed toolchains: PATH prefix (bin dirs, platform-delimited) and
   * the toolchains root (read-only inside the sandbox, docs 任务 5).
   */
  toolchainPathPrefix?: string;
  toolchainsRoot?: string;
  /**
   * P08 skill directories of the executing bot (library + authored): always
   * read-only inside the sandbox even though they live under the denied data
   * home (deny-then-allow re-exposure, same as toolchainsRoot).
   */
  skillReadOnlyDirs?: string[];
  /**
   * D75 §2.1 / §5.1: the executing run may not write (a supervisor turn, or
   * a task created with `writes: false`). The workspace and the workdir are
   * mounted read-only and write grants only grant reading; the app caches
   * stay writable (package-manager / bytecode caches, not user files).
   */
  readOnlyRun?: boolean;
  /**
   * D123 §3.6: the executing write task's declared domain. When every pattern
   * is expressible as a directory, the writable roots shrink to those
   * subdirectories; otherwise the policy keeps today's whole-root mount (the
   * shadow-repo conflict check is the backstop).
   */
  writeDomain?: { root: string; patterns: string[] };
}

/**
 * Per-command sandbox policy (docs/dev/10-sandbox.md "文件系统规则"): the
 * workspace is read-write, app caches and the temp directory are read-write,
 * system and toolchain directories are read-only, everything else — including
 * the rest of the user home — is denied. Effective grants join the policy for
 * every command (docs/design/13-permissions.md "命令行"): write grants into
 * `readWrite`, read grants into `readOnly`; a granted sensitive path is
 * removed from `denyRead`. The bound workdir is read-only without the write
 * lease and read-write with it; its protect-rule globs stay denied inside
 * (srt resolves leaf-shaped globs against directory allows, last match wins).
 */
export function buildSandboxPolicy(input: PolicyInput): SandboxPolicy {
  const { platform, paths, workspacePath, network } = input;
  // The temp directory must NOT be listed here: it is an ancestor of the
  // data home on macOS (tests) and re-allowing it un-does the home deny in
  // the sandbox profile. srt redirects TMPDIR to a sandbox-private location
  // and allows writes there by default.
  // uv and pycache are app caches too: UV_CACHE_DIR / PYTHONPYCACHEPREFIX
  // already point here. Leaving them out of readWrite made macOS system
  // Python fail `file-write-create` on `{pycache}/opt/...` and exit before
  // it could listen (workdir localhost probes then saw curl `000`).
  const cacheDirs = [
    paths.cacheNpmDir,
    paths.cachePipDir,
    paths.cacheXdgDir,
    paths.cacheCargoDir,
    paths.cacheUvDir,
    paths.cachePycacheDir,
  ];
  const readOnlyRun = input.readOnlyRun === true;
  const readWrite = readOnlyRun ? [...cacheDirs] : [workspacePath, ...cacheDirs];
  const readOnly = readOnlyRoots(platform);
  if (readOnlyRun) readOnly.push(workspacePath);
  // D123: a declared write domain narrows what commands may write. Only the
  // expressible forms are applied; the rest keeps the whole root (DEV noted).
  const writeDomain = readOnlyRun ? undefined : input.writeDomain;
  const domainDirs = writeDomain !== undefined ? expressibleDomainDirs(writeDomain) : null;
  const pushUnique = (list: string[], value: string): void => {
    if (!list.includes(value)) list.push(value);
  };
  if (domainDirs !== null && writeDomain !== undefined) {
    const index = readWrite.indexOf(workspacePath);
    if (index >= 0) readWrite.splice(index, 1);
    pushUnique(readOnly, workspacePath);
    // Only a domain rooted inside the workspace re-opens its subdirs; a
    // workdir-rooted (or granted) domain leaves the workspace read-only.
    if (rootContains(workspacePath, writeDomain.root)) {
      for (const dir of domainDirs) pushUnique(readWrite, dir);
    }
  }
  const userHome = canonicalPath(homedir());
  let denyRead: string[] = [userHome, paths.home, ...sensitivePaths(platform)];
  if (platform === 'darwin') {
    // CoreFoundation and the macOS python3 stub read this one-byte encoding
    // file at startup (`0:0` style). It sits in the denied home; re-allow
    // that file only — Apple's bsd.sb does the same. Not a credential, and
    // it does not open the rest of the home or localhost.
    readOnly.push(path.join(userHome, '.CFUserTextEncoding'));
  }

  // Installed toolchains (P06) are visible read-only inside the sandbox and
  // their bin dirs lead PATH (docs/dev/phases/P06-environment.md 任务 5).
  const toolchainsRoot = input.toolchainsRoot ?? paths.toolchainsDir;
  if (existsSync(toolchainsRoot)) readOnly.push(toolchainsRoot);
  // The toolchains root lives under the denied data home; re-expose it
  // (srt's read model is deny-then-allow, last match wins).
  denyRead = denyRead.filter((denied) => !isAncestor(toolchainsRoot, denied));

  // Skill directories (P08): read-only visibility inside the sandbox. Same
  // deny-then-allow re-exposure; writes stay impossible (readOnly only).
  for (const dir of input.skillReadOnlyDirs ?? []) {
    if (!existsSync(dir)) continue;
    readOnly.push(dir);
    denyRead = denyRead.filter((denied) => !isAncestor(dir, denied));
  }

  const workdir = input.workdir;
  if (workdir !== undefined) {
    if (workdir.hasLease && !readOnlyRun) {
      if (domainDirs !== null && writeDomain !== undefined) {
        if (rootContains(workdir.path, writeDomain.root)) {
          pushUnique(readOnly, workdir.path);
          for (const dir of domainDirs) pushUnique(readWrite, dir);
        } else {
          // Rooted in the workspace (or a grant): this workdir is outside the
          // declared domain, so commands may not write it.
          pushUnique(readOnly, workdir.path);
        }
      } else {
        readWrite.push(workdir.path);
      }
    } else readOnly.push(workdir.path);
    // The workdir re-exposes its slice of the denied home; protect-rule globs
    // re-deny inside it (srt read model: deny-then-allow, last match wins).
    denyRead = denyRead.filter(
      (denied) => !(denied === workdir.path || isAncestor(workdir.path, denied)),
    );
    denyRead.push(...workdir.denyReadGlobs);
  }

  for (const grant of input.grants ?? []) {
    if (grant.access === 'write' && !readOnlyRun) readWrite.push(grant.path);
    else readOnly.push(grant.path);
    // A granted sensitive location is no longer wholesale denied; srt's
    // read model is deny-then-allow, so the allow entry above re-exposes it.
    denyRead = denyRead.filter(
      (denied) => !(denied === grant.path || isAncestor(grant.path, denied)),
    );
  }

  const env: Record<string, string> = {
    npm_config_cache: paths.cacheNpmDir,
    PIP_CACHE_DIR: paths.cachePipDir,
    XDG_CACHE_HOME: paths.cacheXdgDir,
    CARGO_HOME: paths.cacheCargoDir,
    // macOS system Python remaps bytecode caches to
    // ~/Library/Caches/com.apple.python (under the denied home) and dies
    // without it; point the prefix at the app cache instead.
    PYTHONPYCACHEPREFIX: paths.cachePycacheDir,
    // uv's package cache stays inside the app cache (P06).
    UV_CACHE_DIR: paths.cacheUvDir,
  };
  const parentPath = input.platform === 'win32' ? (process.env.Path ?? process.env.PATH ?? '') : (process.env.PATH ?? '');
  env.PATH = input.toolchainPathPrefix
    ? `${input.toolchainPathPrefix}${input.platform === 'win32' ? ';' : ':'}${parentPath}`
    : parentPath;

  return {
    readWrite,
    readOnly,
    // The canonical user home is denied wholesale: `paths.home` is the data
    // directory (~/.kepcup), not the home itself, so without this entry
    // ~/Documents, shell history and source trees would be readable by
    // sandboxed commands. Workspaces, caches, toolchains and grants live
    // underneath it and are re-exposed via readWrite/readOnly (srt's read
    // model is deny-then-allow, last match wins).
    denyRead,
    network,
    env,
  };
}

/** True when `root` equals or contains `candidate` (both canonical). */
function isAncestor(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith('/') ? root : `${root}/`);
}

/** Path-component ancestor check that ignores case off Linux. */
function rootContains(root: string, candidate: string): boolean {
  const normalize = (value: string): string => {
    const posix = value.replaceAll('\\', '/').replace(/\/+$/, '');
    return process.platform === 'linux' ? posix : posix.toLowerCase();
  };
  return isAncestor(normalize(root), normalize(candidate));
}

/**
 * Addresses that are denied in every network mode (docs/design/10-sandbox.md):
 * loopback, RFC1918, link-local, multicast/broadcast and cloud metadata
 * endpoints. Given to srt both as IP-literal deny rules (judged even for
 * literal destinations) and resolved-address rules (judged for hostnames).
 */
const ALWAYS_DENIED_ADDRESSES = [
  'localhost',
  '127.0.0.0/8',
  '0.0.0.0/8',
  '::1',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16',
  'fe80::/10',
  '224.0.0.0/4',
  'ff00::/8',
  '255.255.255.255',
  // Cloud instance metadata endpoints outside link-local space.
  '100.100.100.200',
  '168.63.129.16',
  '192.0.0.192',
  'fd00:ec2::/32',
  'fd20:ce::254',
  'fd00:c1::a9fe:a9fe',
  'fd00:42::42',
  'fd00:a9fe:a9fe::1',
  'fd00:100::100:200',
];

/** Address rules shared by every mode (see module comment). */
export function alwaysDeniedAddresses(): string[] {
  return [...ALWAYS_DENIED_ADDRESSES];
}

/**
 * Split for srt: `deniedDomains` accepts hostnames and IP literals;
 * `deniedResolvedAddresses` accepts IP addresses/CIDRs only.
 */
export function alwaysDeniedDomainEntries(): { domains: string[]; resolvedAddresses: string[] } {
  return {
    domains: [...ALWAYS_DENIED_ADDRESSES],
    resolvedAddresses: ALWAYS_DENIED_ADDRESSES.filter((entry) => entry !== 'localhost'),
  };
}
