import { existsSync } from 'node:fs';
import path from 'node:path';

import { expandTilde } from '../infra/paths.js';

/**
 * Locations that stay denied even when a broader rule would allow them
 * (docs/design/10-sandbox.md "文件系统规则", docs/design/13-permissions.md
 * "默认可访问范围"). P03 may turn most denials into grantable requests; the
 * data directory (`~/.kepcup`) is handled separately and is never
 * grantable, so it is not part of this list.
 */

/** `~`-relative entries, shared by every platform. Files are allowed too. */
const COMMON = [
  '~/.ssh',
  '~/.aws',
  '~/.config/gh',
  '~/.gnupg',
  '~/.kube',
  '~/.docker',
  '~/.config/gcloud',
  '~/.azure',
  '~/.netrc',
  '~/.git-credentials',
  '~/.npmrc',
  '~/.config/op',
  '~/.config/1password',
];

const DARWIN = ['~/Library/Keychains', '~/Library/Cookies', '~/Library/Application Support/com.apple.TCC'];

const LINUX = ['~/.local/share/keyrings'];

export function sensitivePaths(platform: string = process.platform): string[] {
  const extra = platform === 'darwin' ? DARWIN : platform === 'linux' ? LINUX : [];
  const candidates = [...COMMON, ...extra].map((entry) => expandTilde(entry));
  // Files that commonly do not exist would never match anyway; keep the list
  // cheap by filtering out missing locations at build time.
  return candidates.filter((p) => existsSync(p));
}

/** Toolchain directories commands may read (interpreters, package managers). */
const TOOLCHAIN_DIRS = [
  '~/.nvm',
  '~/.pyenv',
  '~/.rbenv',
  '~/.cargo',
  '~/.rustup',
  '~/.ghcup',
  '~/.sdkman',
  '~/.volta',
  '~/.bun',
  '~/.deno',
  '~/.local/share/mise',
  '~/go',
];

const DARWIN_SYSTEM_READ = [
  '/usr',
  '/bin',
  '/sbin',
  '/etc',
  '/private/etc',
  '/opt',
  '/System',
  '/Applications',
  '/Library',
  '/usr/local',
  '/private/var/db/timezone',
  '/private/var/select',
];

const LINUX_SYSTEM_READ = ['/usr', '/bin', '/sbin', '/etc', '/lib', '/lib32', '/lib64', '/opt', '/snap'];

/** System/toolchain directories that sandboxed commands may read but not write. */
export function readOnlyRoots(platform: string = process.platform): string[] {
  const system = platform === 'darwin' ? DARWIN_SYSTEM_READ : platform === 'linux' ? LINUX_SYSTEM_READ : [];
  const toolchains = TOOLCHAIN_DIRS.map((entry) => expandTilde(entry));
  return [...system, ...toolchains].filter((p) => existsSync(p));
}

/** True when `candidate` equals `root` or lives underneath it. */
export function isInsidePath(candidate: string, root: string): boolean {
  if (candidate === root) return true;
  const rel = path.relative(root, candidate);
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
}
